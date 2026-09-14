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
//
// The parse is split into one small helper per decision (#906): the single
// 155-line closure it replaced measured cyclomatic complexity 42, and every
// branch of it is pinned end to end in `test/parse-args.test.ts`.

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

function expectedOneArgument(flag) {
  return `argument ${flag}: expected one argument`;
}

/**
 * Fail loudly at construction on a spec that cannot be satisfied -- a rename
 * that leaves a stale default or a required flag behind is otherwise silent.
 */
function assertSpecSatisfiable(config) {
  const { booleans, values, defaults, required, VALUES } = config;
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
}

/** Booleans start false, value flags start at their default or null. */
function initialOpts({ booleans, values, defaults }) {
  const opts = Object.create(null);
  for (const key of Object.values(booleans)) opts[key] = false;
  for (const { key } of Object.values(values)) {
    opts[key] = key in defaults ? defaults[key] : null;
  }
  Object.assign(opts, defaults);
  return opts;
}

/** Split `--flag=value` once, up front, so both spellings share one path. */
function splitInlineValue(arg) {
  const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
  if (eq === -1) return { flag: arg, inline: null };
  return { flag: arg.slice(0, eq), inline: arg.slice(eq + 1) };
}

/**
 * A leading '-' normally means "the next flag, not my value" -- but a
 * well-formed integer is a legitimate value for an int flag, so `--seed -5`
 * and `--seed=-5` stay the same command.
 */
function cannotBeValue(def, next) {
  if (next === undefined) return true;
  return next.startsWith('-') && !(def.type === 'int' && INT_RE.test(next));
}

/** The raw value text and how many extra argv tokens it used, or an error. */
function readRawValue(flag, def, inline, next) {
  if (inline !== null) return { raw: inline, consumed: 0 };
  if (cannotBeValue(def, next)) return { error: expectedOneArgument(flag) };
  return { raw: next, consumed: 1 };
}

/** Validate an int value's syntax AND its exactness. */
function parseIntValue(flag, raw) {
  // Validate the VALUE, not just its presence: a flag whose purpose is
  // determinism must not decay to a default when its value is junk.
  if (!INT_RE.test(raw)) {
    return { error: `argument ${flag}: invalid int value: '${raw}'` };
  }
  // Syntactically an integer is not enough: Number() silently rounds past
  // 2^53-1, so `--seed 9007199254740993` would RUN with ...992 -- the value
  // used differing from the value asked for, which is the exact class of lie
  // a determinism flag must not tell.
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) {
    return { error: `argument ${flag}: integer out of safe range: '${raw}'` };
  }
  return { value: parsed };
}

function coerceValue(flag, def, raw) {
  // Empty is the missing-value case wearing a disguise. `--repo=` is typed by
  // nobody, but `--repo "$UNSET_VAR"` expands to `--repo ''` in any shell, and
  // an accepted empty path silently retargets writes at the process CWD.
  if (raw === '') return { error: expectedOneArgument(flag) };
  if (def.type === 'int') return parseIntValue(flag, raw);
  return { value: raw };
}

/** Store a value flag's value; the outcome says how many tokens it took. */
function takeValue(state, flag, inline, index) {
  const def = state.VALUES[flag];
  const read = readRawValue(flag, def, inline, state.argv[index + 1]);
  if (read.error !== undefined) return read;
  const coerced = coerceValue(flag, def, read.raw);
  if (coerced.error !== undefined) return coerced;
  state.opts[def.key] = coerced.value;
  return { consumed: read.consumed };
}

/** A lone `-` is a positional, as argparse treats it. */
function isPositional(state, arg) {
  if (!state.positionals) return false;
  return arg === '-' || !arg.startsWith('-');
}

/** A token that is neither help nor `--`: a flag, a positional, or junk. */
function readOptionToken(state, arg, index) {
  const { flag, inline } = splitInlineValue(arg);
  if (state.BOOLEANS[flag] !== undefined && inline === null) {
    state.opts[state.BOOLEANS[flag]] = true;
    return { consumed: 0 };
  }
  if (state.VALUES[flag] !== undefined) {
    return takeValue(state, flag, inline, index);
  }
  if (isPositional(state, arg)) {
    state.found.push(arg);
    return { consumed: 0 };
  }
  return { error: `unrecognized arguments: ${arg}` };
}

function endOptions(state) {
  if (!state.positionals) return { error: 'unrecognized arguments: --' };
  state.endOfOptions = true;
  return { consumed: 0 };
}

/**
 * One token's outcome: `{consumed}` to keep scanning, or `{help}` / `{error}`
 * to stop.
 */
function readToken(state, index) {
  const arg = state.argv[index];
  if (state.endOfOptions) {
    state.found.push(arg);
    return { consumed: 0 };
  }
  // Help short-circuits everything, including the required-flag check --
  // otherwise `--help` reports the arguments it is being asked to explain as
  // missing.
  if (arg === '-h' || arg === '--help') return { help: true };
  if (arg === '--') return endOptions(state);
  return readOptionToken(state, arg, index);
}

/** Scan argv; returns the stopping outcome, or null when argv ran out. */
function scanTokens(state) {
  for (let i = 0; i < state.argv.length; i += 1) {
    const outcome = readToken(state, i);
    if (outcome.consumed === undefined) return outcome;
    i += outcome.consumed;
  }
  return null;
}

function missingRequired({ required, VALUES }, opts) {
  return required.filter((flag) => {
    const value = opts[VALUES[flag].key];
    return value === null || value === undefined;
  });
}

function parseArgv(config, argv) {
  const opts = initialOpts(config);
  const found = [];
  const result = { opts, positionals: found, help: false, error: null };
  const state = { ...config, argv, opts, found, endOfOptions: false };

  const stop = scanTokens(state);
  if (stop !== null) return Object.assign(result, stop);

  const missing = missingRequired(config, opts);
  if (missing.length) {
    result.error = `the following arguments are required: ${missing.join(', ')}`;
    return result;
  }

  const { positionals } = config;
  if (positionals && !found.length && positionals.defaults) {
    found.push(...positionals.defaults);
  }
  return result;
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

  const config = {
    booleans,
    values,
    defaults,
    required,
    positionals,
    BOOLEANS: nullProtoMap(booleans),
    VALUES: nullProtoMap(values),
  };
  assertSpecSatisfiable(config);

  return function parse(argv = []) {
    return parseArgv(config, argv);
  };
}
