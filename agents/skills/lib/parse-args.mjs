// Shared skill-CLI argument parser (#479).
//
// Skill CLIs are deliberately self-contained -- they import no engine code, so
// the runner can exec them anywhere node runs. That constraint is why five of
// them hand-rolled the same `parseArgs` loop, and why the same bug class came
// back three consecutive rounds: the pattern was copy-paste, so each new skill
// inherited whichever version its author happened to copy.
//
// This module is the one implementation of the four invariants that loop has to
// honour. It stays dependency-free ESM under `agents/skills/lib/`, which keeps
// the self-contained property intact -- a skill importing a sibling file in the
// same shipped tree is still a skill that needs nothing installed.
//
//   1. null-prototype flag lookup   -- an inherited key must never resolve
//   2. empty-value rejection        -- `--flag=` and `--flag ''` alike
//   3. arity checking               -- `argument <flag>: expected one argument`
//   4. `--flag=value`               -- accepted everywhere, not per-skill
//
// `test/skill-cli-conformance.test.ts` discovers every SKILL.md declaring
// `cli:` and asserts the module exports the `CLI_SPEC` it passed here, so a
// sixth hand-rolled copy fails CI instead of quietly starting the cycle again.

/** Exit code argparse reserves for usage errors; the whole family follows it. */
export const EXIT_USAGE = 2;

/** Well-formed integer, sign allowed -- no floats, no exponents, no 0x. */
const INT_RE = /^[+-]?\d+$/;

/**
 * argparse prints `prog: error: message` for usage errors. The family's
 * comments have claimed argparse parity throughout while shipping two formats
 * under that banner; this is the one that makes the claim true. Runtime
 * failures (exit 1) keep the plainer `prog: message` -- argparse never owned
 * those, so there is nothing to be faithful to.
 */
export function formatUsageError(prog, message) {
  return `${prog}: error: ${message}`;
}

/** Inherited keys must not resolve, so every lookup map is null-prototype. */
function nullProtoMap(entries) {
  return Object.assign(Object.create(null), entries);
}

/**
 * Build a parser from a declarative spec.
 *
 * @param {object} spec
 * @param {string} spec.prog          program name used in error output
 * @param {Record<string,string>} [spec.booleans]  '--json' -> 'json'
 * @param {Record<string,{key:string,type?:'string'|'int'}>} [spec.values]
 * @param {Record<string,unknown>} [spec.defaults] initial option values
 * @param {string[]} [spec.required]  value flags that must be supplied
 * @param {{key:string,defaults?:string[]}} [spec.positionals]
 *        declaring positionals also enables the `--` end-of-options terminator
 *        and a lone `-`; a CLI that takes no paths gets neither, since there is
 *        nothing for them to protect.
 * @returns {(argv: string[]) => {opts: Record<string,unknown>, positionals: string[], help: boolean, error: string|null}}
 */
export function createParser(spec) {
  const {
    prog,
    booleans = {},
    values = {},
    defaults = {},
    required = [],
    positionals = null,
  } = spec ?? {};

  if (!prog) throw new Error('createParser: spec.prog is required');

  const BOOLEANS = nullProtoMap(booleans);
  const VALUES = nullProtoMap(values);

  // Fail loudly at construction on a spec that cannot be satisfied -- a rename
  // that leaves a stale default or a required flag behind is otherwise silent.
  const declaredKeys = new Set([
    ...Object.values(booleans),
    ...Object.values(values).map((v) => v.key),
  ]);
  for (const key of Object.keys(defaults)) {
    if (!declaredKeys.has(key)) {
      throw new Error(`createParser: defaults names unknown key '${key}'`);
    }
  }
  for (const flag of required) {
    if (VALUES[flag] === undefined) {
      throw new Error(`createParser: required names undeclared flag '${flag}'`);
    }
  }

  return function parse(argv = []) {
    const opts = Object.create(null);
    for (const key of Object.values(booleans)) opts[key] = false;
    for (const { key } of Object.values(values)) {
      opts[key] = key in defaults ? defaults[key] : null;
    }
    Object.assign(opts, defaults);

    const found = [];
    const result = { opts, positionals: found, help: false, error: null };
    const fail = (message) => {
      result.error = message;
      return result;
    };

    let endOfOptions = false;

    for (let i = 0; i < argv.length; i += 1) {
      const arg = argv[i];

      if (endOfOptions) {
        found.push(arg);
        continue;
      }

      // Help short-circuits everything, including the required-flag check
      // below -- otherwise `--help` reports the arguments it is being asked to
      // explain as missing.
      if (arg === '-h' || arg === '--help') {
        result.help = true;
        return result;
      }

      if (arg === '--') {
        if (!positionals) return fail('unrecognized arguments: --');
        endOfOptions = true;
        continue;
      }

      // Split `--flag=value` once, up front, so both spellings share one path.
      const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
      const flag = eq === -1 ? arg : arg.slice(0, eq);
      const inline = eq === -1 ? null : arg.slice(eq + 1);

      if (BOOLEANS[flag] !== undefined && inline === null) {
        opts[BOOLEANS[flag]] = true;
        continue;
      }

      const def = VALUES[flag];
      if (def !== undefined) {
        let raw;
        if (inline !== null) {
          raw = inline;
        } else {
          const next = argv[i + 1];
          // A leading '-' normally means "the next flag, not my value" -- but a
          // well-formed integer is a legitimate value for an int flag, so
          // `--seed -5` and `--seed=-5` stay the same command.
          const looksLikeFlag =
            next !== undefined &&
            next.startsWith('-') &&
            !(def.type === 'int' && INT_RE.test(next));
          if (next === undefined || looksLikeFlag) {
            return fail(`argument ${flag}: expected one argument`);
          }
          raw = next;
          i += 1;
        }
        // Empty is the missing-value case wearing a disguise. `--repo=` is
        // typed by nobody, but `--repo "$UNSET_VAR"` expands to `--repo ''` in
        // any shell, and an accepted empty path silently retargets writes at
        // the process CWD.
        if (raw === '') return fail(`argument ${flag}: expected one argument`);
        if (def.type === 'int') {
          // Validate the VALUE, not just its presence: a flag whose purpose is
          // determinism must not decay to a default when its value is junk.
          if (!INT_RE.test(raw)) {
            return fail(`argument ${flag}: invalid int value: '${raw}'`);
          }
          // Syntactically an integer is not enough: Number() silently rounds
          // past 2^53-1, so `--seed 9007199254740993` would RUN with ...992 --
          // the value used differing from the value asked for, which is the
          // exact class of lie a determinism flag must not tell.
          const parsed = Number(raw);
          if (!Number.isSafeInteger(parsed)) {
            return fail(
              `argument ${flag}: integer out of safe range: '${raw}'`,
            );
          }
          opts[def.key] = parsed;
        } else {
          opts[def.key] = raw;
        }
        continue;
      }

      // A lone `-` is a positional, as argparse treats it.
      if (positionals && (arg === '-' || !arg.startsWith('-'))) {
        found.push(arg);
        continue;
      }

      return fail(`unrecognized arguments: ${arg}`);
    }

    const missing = required.filter((flag) => {
      const value = opts[VALUES[flag].key];
      return value === null || value === undefined;
    });
    if (missing.length) {
      return fail(
        `the following arguments are required: ${missing.join(', ')}`,
      );
    }

    if (positionals && !found.length && positionals.defaults) {
      found.push(...positionals.defaults);
    }

    return result;
  };
}
