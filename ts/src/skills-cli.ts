/**
 * `canary skills` sub-app -- faithful port of the `skills_app` commands in
 * `agent/cli.py` (`list`, `run`), wired to the already-ported `SkillRegistry`.
 *
 * INTENTIONAL DEVIATION (`skills run`, entry-target branch): Python's `entry:`
 * skills load a Python `module:callable` via `importlib` and invoke it in-process
 * -- there is no portable Node equivalent. The `cli:` branch (spawn a `.py`/`.js`
 * target, the path skills actually use going forward) is ported faithfully; the
 * `entry:` branch preserves the Python exit-code ladder (bad format -> 5,
 * load/attr failure -> 6) over a dynamic `import()`, which will not resolve a
 * Python module. No Python test exercises the cli/entry execution branches.
 */

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { Command } from 'commander';
import pc from 'picocolors';

import { CliExitError, jsonIndent2, normalizeUsageExit } from './cli-common.js';
import { gateOutcome, type GateResult } from './core/gate-result.js';
import {
  checkExamples,
  spawnRunner,
  type ExampleFinding,
} from './core/skill-examples.js';
import {
  SurfaceFindingKind,
  checkSurfaces,
  collectSurfaces,
  type SurfaceDeclaration,
  type SurfaceFinding,
} from './core/skill-surfaces.js';
import {
  isExecutableSkillAllowed,
  resolveCliPath,
  type SkillInfo,
} from './core/skill-registry.js';
import { CROSS, EM_DASH, type MainDeps } from './main-deps.js';

interface ListOptions {
  verbose?: boolean;
}

function overlayName(skill: SkillInfo): string {
  // Clone layout: ~/.canary/overlays/<overlay>/.canary/skills/<name>/SKILL.md
  const parts = skill.path.split(/[\\/]/);
  const i = parts.indexOf('overlays');
  return i >= 0 && i + 1 < parts.length ? parts[i + 1]! : '?';
}

function formatSkill(skill: SkillInfo, verbose: boolean): string {
  // rich rendered `\[cli]` etc. as literal "[cli]" (the backslash escapes the
  // markup); the equivalent picocolors output is the literal bracket text.
  let marker = '';
  if (skill.error) marker = ' [error]';
  else if (skill.cli) marker = ' [cli]';
  else if (skill.entry) marker = ' [entry]';
  const desc = skill.description ? `  ${skill.description}` : '';
  let line = `  /${skill.name}${marker}${desc}`;
  if (verbose) line += `\n    ${pc.dim(skill.path)}`;
  return line;
}

function listCmd(opts: ListOptions, deps: MainDeps): void {
  const verbose = opts.verbose ?? false;
  const skills = deps.makeSkillRegistry().discover();
  if (skills.length === 0) {
    deps.out(pc.yellow('No skills found.'));
    return;
  }

  const bundled = skills.filter((s) => s.source === 'bundled');
  const overlay = skills.filter((s) => s.source === 'overlay');
  const globalSkills = skills.filter((s) => s.source === 'global');
  const local = skills.filter((s) => s.source === 'local');

  if (bundled.length) {
    deps.out(pc.bold('Bundled skills:'));
    for (const skill of bundled) deps.out(formatSkill(skill, verbose));
  }
  if (overlay.length) {
    const sorted = [...overlay].sort((a, b) =>
      overlayName(a).localeCompare(overlayName(b)),
    );
    let idx = 0;
    let cur: string | null = null;
    for (const skill of sorted) {
      const oname = overlayName(skill);
      if (oname !== cur) {
        if (bundled.length || idx > 0) deps.out('');
        deps.out(
          `${pc.bold('Overlay skills')} ${pc.dim(`(${oname} ${EM_DASH} override bundled):`)}`,
        );
        cur = oname;
        idx += 1;
      }
      deps.out(formatSkill(skill, verbose));
    }
  }
  if (globalSkills.length) {
    if (bundled.length || overlay.length) deps.out('');
    deps.out(
      `${pc.bold('Global skills')} ${pc.dim(`(~/.canary/skills/ ${EM_DASH} override overlay):`)}`,
    );
    for (const skill of globalSkills) deps.out(formatSkill(skill, verbose));
  }
  if (local.length) {
    if (bundled.length || overlay.length || globalSkills.length) deps.out('');
    deps.out(
      `${pc.bold('Local overlay skills')} ${pc.dim('(override global):')}`,
    );
    for (const skill of local) deps.out(formatSkill(skill, verbose));
  }
}

interface RunOptions {
  allowExecutableSkills?: boolean;
}

async function runCmd(
  name: string,
  args: string[],
  opts: RunOptions,
  deps: MainDeps,
): Promise<void> {
  const skill = deps.makeSkillRegistry().find(name);
  if (skill === null) {
    deps.out(`${pc.red(CROSS)} No skill named ${pc.bold(name)} found.`);
    throw new CliExitError(1);
  }
  if (skill.error) {
    deps.out(`${pc.red(CROSS)} Skill ${pc.bold(name)}: ${skill.error}`);
    throw new CliExitError(2);
  }
  if (!skill.isExecutable) {
    deps.out(
      pc.yellow(
        `Skill ${pc.bold(name)} is markdown-only ${EM_DASH} no cli: or entry: field to run.`,
      ),
    );
    throw new CliExitError(2);
  }
  if (!isExecutableSkillAllowed(opts.allowExecutableSkills ?? false)) {
    deps.out(
      `${pc.red(CROSS)} Refusing to invoke executable skill in non-interactive context. Pass ${pc.bold('--allow-executable-skills')} to opt in (e.g. in trusted CI configurations).`,
    );
    throw new CliExitError(3);
  }

  const forwarded = args;

  if (skill.cli) {
    let target: string;
    try {
      target = resolveCliPath(skill);
    } catch (exc) {
      deps.out(
        `${pc.red(CROSS)} ${exc instanceof Error ? exc.message : String(exc)}`,
      );
      throw new CliExitError(4);
    }
    const cmd = target.endsWith('.py') ? [deps.pythonExe(), target] : [target];
    const res = deps.runSubprocess(cmd[0]!, [...cmd.slice(1), ...forwarded], {
      cwd: skill.dir,
      inherit: true,
    });
    // A spawn failure (missing interpreter/binary) yields status=null; Python's
    // subprocess.run raises FileNotFoundError -> nonzero exit. Map null -> 1, not
    // a silent 0. A normal run passes its real exit code through.
    throw new CliExitError(res.status ?? 1);
  }

  // entry: branch -- see module docstring (Python-module semantics are not
  // portable; the exit-code ladder is preserved).
  const [moduleName, sep, attr] = partition(skill.entry!, ':');
  if (!moduleName || !attr || !sep) {
    deps.out(
      `${pc.red(CROSS)} Skill ${pc.bold(name)} entry must be 'module:callable', got '${skill.entry}'`,
    );
    throw new CliExitError(5);
  }
  try {
    const mod = (await import(moduleName)) as Record<string, unknown>;
    const target = mod[attr];
    if (typeof target !== 'function') throw new Error('not callable');
    const rc = (target as () => unknown)();
    throw new CliExitError(typeof rc === 'number' ? rc : 0);
  } catch (exc) {
    if (exc instanceof CliExitError) throw exc;
    deps.out(
      `${pc.red(CROSS)} Skill ${pc.bold(name)} entry '${skill.entry}': ${exc instanceof Error ? exc.message : String(exc)}`,
    );
    throw new CliExitError(6);
  }
}

interface VerifyOptions {
  root?: string;
  json?: boolean;
  runExamples?: boolean;
  canaryBin?: string;
}

/**
 * `skills verify` -- cross-surface consistency (#452) plus execution of the
 * commands the docs promise (#487).
 *
 * **Two checks, two summary lines, deliberately.** Folding them into one
 * denominator is the trap: 80 surfaces checked and 0 examples executed would
 * render as a single healthy number while the half that actually executes
 * something had abstained. Each check therefore reports its own denominator
 * through `gateOutcome`, and the reader sees both.
 *
 * Classified **advisory** (exit 0): both checks are landing on a corpus nothing
 * has ever swept, so their precision is unknown and ADR 0010 says promotion
 * waits for the triage. Abstention is still printed loudly -- that is what the
 * classification does *not* soften.
 */
/**
 * Run the examples half, or explain why it could not run.
 *
 * The examples half spawns a CLI. When there is no built one, the honest result
 * is a zero denominator carrying the reason -- an unrunnable runner must never
 * look like a clean corpus.
 */
function exampleHalf(
  opts: VerifyOptions,
  surfaces: SurfaceDeclaration[],
  root: string,
): GateResult<ExampleFinding> {
  const bin = opts.canaryBin ?? join(root, 'ts', 'bin', 'canary.js');
  if ((opts.runExamples ?? true) && existsSync(bin)) {
    return checkExamples(surfaces, spawnRunner(bin), root);
  }
  return {
    checked: 0,
    findings: [],
    skipped: [
      {
        name: 'every documented example',
        reason:
          opts.runExamples === false
            ? '--no-run-examples was passed'
            : `no built CLI at ${bin} (run \`npm --prefix ts run build\`)`,
      },
    ],
  };
}

/**
 * Per-kind tally over the FULL enum, including kinds that scored zero.
 *
 * A triage backlog is read by category, and `cli-not-executable=0` is the line
 * that says the rule ran. An absent line is indistinguishable from a rule that
 * was never evaluated -- the reading trap this whole check exists to close.
 */
function tallyByKind(findings: SurfaceFinding[]): string {
  return Object.values(SurfaceFindingKind)
    .map((kind) => `${kind}=${findings.filter((f) => f.kind === kind).length}`)
    .join(' ');
}

/** Both halves as JSON, each carrying its own `checked` and `abstained`. */
function verifyJson(
  root: string,
  surfaceResult: GateResult<SurfaceFinding>,
  exampleResult: GateResult<ExampleFinding>,
): string {
  return jsonIndent2({
    root,
    surfaces: {
      checked: surfaceResult.checked,
      abstained: !(surfaceResult.checked > 0),
      findings: surfaceResult.findings,
    },
    examples: {
      checked: exampleResult.checked,
      abstained: !(exampleResult.checked > 0),
      findings: exampleResult.findings,
      skipped: exampleResult.skipped ?? [],
    },
  });
}

/** One summary line per half, plus the remediation text on an abstention. */
function verifyReport(
  root: string,
  surfaceResult: GateResult<SurfaceFinding>,
  exampleResult: GateResult<ExampleFinding>,
  deps: MainDeps,
): void {
  for (const f of surfaceResult.findings) {
    deps.err(`${pc.yellow(CROSS)} [${f.kind}] ${f.name}: ${f.detail}`);
  }
  for (const f of exampleResult.findings) {
    deps.err(`${pc.yellow(CROSS)} [${f.kind}] ${f.skill}: ${f.detail}`);
  }

  const surfaceOutcome = gateOutcome(surfaceResult, 'advisory', {
    noun: 'surface declaration(s)',
  });
  deps.out(`surfaces: ${surfaceOutcome.summaryLine}`);
  deps.out(`  by kind: ${tallyByKind(surfaceResult.findings)}`);
  if (surfaceOutcome.abstained) {
    deps.out(
      `  no skill surface was found under ${root} ${EM_DASH} check the path, ` +
        'or that `agents/skills/` has not been renamed.',
    );
  }

  const exampleOutcome = gateOutcome(exampleResult, 'advisory', {
    noun: 'documented example(s)',
  });
  deps.out(`examples: ${exampleOutcome.summaryLine}`);
  if (exampleOutcome.abstained) {
    deps.out(
      `  zero documented commands were executed ${EM_DASH} nothing here is ` +
        'proven. Add a help-shaped example in a shell fence to a SKILL.md, or ' +
        'build the engine so the runner has a CLI to spawn.',
    );
  }
}

function verifyCmd(opts: VerifyOptions, deps: MainDeps): void {
  const root = resolve(opts.root ?? deps.cwd());
  const surfaces = collectSurfaces(root);
  const surfaceResult = checkSurfaces(root);
  const exampleResult = exampleHalf(opts, surfaces, root);

  if (opts.json) {
    deps.out(verifyJson(root, surfaceResult, exampleResult));
    return;
  }
  verifyReport(root, surfaceResult, exampleResult, deps);
}

/** Python `str.partition(sep)` -> `[before, sep, after]`. */
function partition(s: string, sep: string): [string, string, string] {
  const i = s.indexOf(sep);
  if (i < 0) return [s, '', ''];
  return [s.slice(0, i), sep, s.slice(i + sep.length)];
}

/** Build the `skills` sub-app wired to `deps`. */
export function buildSkillsCommand(deps: MainDeps): Command {
  const program = new Command('skills');
  program
    .description('List and invoke discoverable Canary skills.')
    .exitOverride(normalizeUsageExit);

  program
    .command('list')
    .description('List every skill discoverable from the current directory.')
    .option('-v, --verbose', 'Also print the SKILL.md path for each skill.')
    .action((opts: ListOptions) => {
      listCmd(opts, deps);
    });

  program
    .command('run')
    .description("Invoke a code-bearing skill's declared cli or entry target.")
    .argument('<name>', 'Name of the skill to invoke.')
    .argument('[args...]', "Arguments forwarded to the skill's cli/entry.")
    .option(
      '--allow-executable-skills',
      'Opt-in to invoking cli:/entry: skills in non-interactive (CI) contexts.',
    )
    .action(async (name: string, args: string[], opts: RunOptions) => {
      await runCmd(name, args ?? [], opts, deps);
    });

  program
    .command('verify')
    .description(
      'Check that skill surfaces agree and that documented examples still run.',
    )
    .option('--root <path>', 'Repository root to inspect (default: cwd).')
    .option('--json', 'Emit both denominators and every finding as JSON.')
    .option(
      '--no-run-examples',
      'Inspect declarations only; do not execute documented examples.',
    )
    .option('--canary-bin <path>', 'CLI to spawn for documented examples.')
    .action((opts: VerifyOptions) => {
      verifyCmd(opts, deps);
    });

  for (const sub of program.commands) {
    sub.exitOverride(normalizeUsageExit);
  }

  return program;
}
