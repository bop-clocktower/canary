/**
 * Top-level `canary` command handlers -- faithful ports of the module-level
 * commands in `agent/cli.py` (recommend, frameworks, feedback, run, init, setup,
 * migrate, review-test, flake-check, heal-test, version, upgrade, overlay,
 * doctor, ticket-update). The commander wiring (options/args/defaults) lives in
 * `cli.ts`; these functions are the thin handlers it dispatches to.
 *
 * Conventions mirror `guardian/cli.ts`: `CliExitError` for business exits,
 * `jsonIndent2` for `json.dumps(indent=2)`, picocolors for rich markup (color
 * strips on a non-TTY sink so plain text is byte-exact), and output glyphs as
 * `\u{...}` escapes emitted verbatim.
 */

import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';

import pc from 'picocolors';

import { CliExitError, jsonIndent2 } from './cli-common.js';
import {
  EXIT_ABSTAINED,
  gateOutcome,
  type GateResult,
  type SkipEntry,
} from './core/gate-result.js';
import { promotionVerdict } from './core/promotion-verdict.js';
import { scanVacuity, type VacuityFinding } from './core/vacuity-scanner.js';
import { ckInitCmd } from './company-knowledge-cli.js';
import { extractFrameworkHint } from './core/classifier.js';
import { VALID_CATEGORIES, buildFeedback } from './core/feedback.js';
import {
  OverlayNotFound,
  listOverlays,
  resolveOverlay,
} from './core/overlays.js';
import { JS_TEST_EXTENSIONS, frameworkForPath } from './core/static-linter.js';
import type { LintFinding } from './core/static-linter.js';
import { RunSummary } from './core/ticket-updater.js';
import { renderBanner } from './ui/banner.js';
import {
  ARROW,
  CHECK,
  CHECK_MARK,
  CROSS,
  EM_DASH,
  HAMMER,
  NEXT,
  REDX,
  ROCKET,
  WARN,
  WRENCH,
  type MainDeps,
} from './main-deps.js';

function resolveVersion(deps: MainDeps): string {
  try {
    return deps.pkgVersion();
  } catch {
    return 'unknown';
  }
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Directories never worth walking. A dependency's own test suite is not the
 * consumer's to fix: before #566, `node_modules` accounted for 254 of 256
 * findings in one downstream run, and the only `critical` sat inside vendored
 * code. `pattern-matcher.ts` has carried this set since the Python port; this
 * walk was the copy that never got it.
 */
const IGNORED_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  '__pycache__',
  '.venv',
  'venv',
  'dist',
  'build',
  '.next',
  '.nuxt',
]);

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (!IGNORED_DIRS.has(e.name)) out.push(...walkFiles(full));
    } else if (e.isFile()) out.push(full);
  }
  return out;
}

/**
 * `test_*.py` plus `*.test.*` / `*.spec.*` over every extension the scanners
 * can actually read -- `.mjs` and `.cjs` included, which is the half of #566
 * that made a directory of ESM tests collect zero files.
 */
const JS_TEST_FILE_RE = new RegExp(
  `\\.(test|spec)\\.(${JS_TEST_EXTENSIONS.map((e) => e.slice(1)).join('|')})$`,
);

/** Recursive test-file glob matching Python's `rglob` union, sorted by path. */
function collectTestFiles(dir: string): string[] {
  return walkFiles(dir)
    .filter((p) => {
      const b = basename(p);
      return (
        (b.startsWith('test_') && b.endsWith('.py')) || JS_TEST_FILE_RE.test(b)
      );
    })
    .sort();
}

// --- recommend ---------------------------------------------------------------

interface RecommendOptions {
  json?: boolean;
}

export function recommendFrameworkCmd(
  promptText: string,
  opts: RecommendOptions,
  deps: MainDeps,
): void {
  const classifier = deps.makeClassifier();
  const recommender = deps.makeRecommender();

  const classification = classifier.classify(promptText);
  const results = recommender.recommend(
    classification,
    null,
    extractFrameworkHint(promptText),
  );
  const result =
    results[0] ??
    ({
      framework: null as string | null,
      file_extension: 'ts',
      reason: ['No matching framework found'],
    } as {
      framework: string | null;
      file_extension: string;
      reason: string[];
      warning?: string;
      license?: string | null;
    });
  const alternatives = results.slice(1).map((r) => r.framework);

  if (opts.json) {
    const execInfo =
      (deps.makeRegistry().executionInfo(result.framework as string) as {
        execution_command?: string | null;
        ci_flags?: string[];
      } | null) ?? {};
    const payload: Record<string, unknown> = {
      status: 'success',
      test_type: classification.test_type,
      framework: result.framework,
      file_extension: result.file_extension,
      execution_command: execInfo.execution_command ?? null,
      ci_flags: execInfo.ci_flags ?? [],
      reasoning: result.reason,
      alternatives,
    };
    if ((result as { warning?: string }).warning) {
      payload['license'] = (result as { license?: string | null }).license;
      payload['warning'] = (result as { warning?: string }).warning;
    }
    deps.out(jsonIndent2(payload));
    return;
  }

  deps.out(`${pc.bold(pc.green(`${CHECK_MARK} Canary Recommendation`))}\n`);
  deps.out(`${pc.bold('Test Type:')} ${classification.test_type}`);
  deps.out(
    `${pc.bold('Framework:')} ${result.framework === null ? 'None' : result.framework}`,
  );
  deps.out(`\n${pc.bold('Reasoning:')}`);
  for (const r of result.reason) deps.out(` - ${r}`);
  if ((result as { warning?: string }).warning) {
    deps.out(
      `\n${pc.yellow(`${WARN} License: ${(result as { warning?: string }).warning}`)}`,
    );
  }
  if (alternatives.length) {
    deps.out(`\n${pc.bold('Alternatives:')} ${alternatives.join(', ')}`);
  }
}

// --- frameworks --------------------------------------------------------------

interface FrameworksOptions {
  json?: boolean;
}

const TIER_STYLE: Record<string, (s: string) => string> = {
  full: pc.green,
  executable: pc.cyan,
  catalog: pc.yellow,
};

export function listFrameworksCmd(
  opts: FrameworksOptions,
  deps: MainDeps,
): void {
  const summaries = deps.makeRegistry().summaries();

  if (opts.json) {
    deps.out(jsonIndent2({ frameworks: summaries }));
    return;
  }

  deps.out(`${pc.bold(pc.green('Canary Frameworks'))}\n`);
  for (const f of summaries) {
    const status = f.status ? ` ${pc.dim(`(${f.status})`)}` : '';
    const tier = f.tier || 'catalog';
    const tierLabel = (TIER_STYLE[tier] ?? pc.white)(tier);
    deps.out(
      `${pc.bold(f.name)} ${tierLabel}${status} ${EM_DASH} ${f.category || 'n/a'}`,
    );
    const cmd = f.execution_command || '(no run command)';
    deps.out(`  run: ${cmd}`);
    if (f.ci_flags.length) {
      deps.out(`  ci:  ${f.ci_flags.join(' ')}`);
    }
  }
  deps.out(
    `\n${pc.dim(`tier: full=scaffold+run \u{00b7} executable=run only \u{00b7} catalog=listed only.`)}`,
  );
  deps.out(
    pc.dim('`{file}` in a run command is the test-file path placeholder.'),
  );
}

// --- feedback ----------------------------------------------------------------

interface FeedbackOptions {
  category: string;
  json?: boolean;
  open?: boolean;
}

export function feedbackCmd(
  message: string | undefined,
  opts: FeedbackOptions,
  deps: MainDeps,
): void {
  if (!(VALID_CATEGORIES as readonly string[]).includes(opts.category)) {
    deps.out(
      `${pc.bold(pc.red(CROSS))} Unknown --category '${opts.category}'. Choose one of: ${VALID_CATEGORIES.join(', ')}.`,
    );
    throw new CliExitError(1);
  }
  if (!message || !message.trim()) {
    deps.out(
      `${pc.bold(pc.red(CROSS))} A feedback message is required.\nUsage: ${pc.bold('canary feedback "<message>" [--category bug|ux|docs|idea]')}`,
    );
    throw new CliExitError(1);
  }

  const fb = buildFeedback(message.trim(), opts.category, resolveVersion(deps));

  if (opts.json) {
    deps.out(jsonIndent2(fb));
    return;
  }

  deps.out(`${pc.bold(pc.green('Canary Feedback'))}\n`);
  deps.out(`${pc.bold('Category:')} ${fb.category}`);
  deps.out(`${pc.bold('Message:')} ${fb.message}`);
  deps.out(`\n${pc.bold('Attached context')} (no env vars, no file contents):`);
  for (const [k, v] of Object.entries(fb.context)) {
    deps.out(`  - ${k}: ${v}`);
  }
  deps.out(`\n${pc.bold('Open this pre-filled issue to submit:')}`);
  deps.out(fb.issue_url);

  if (opts.open) {
    deps.openBrowser(fb.issue_url);
    deps.out(
      `\n${pc.dim(`Opened in your browser ${EM_DASH} review and submit there.`)}`,
    );
  }
}

// --- run ---------------------------------------------------------------------

export function runCmd(
  filePath: string,
  framework: string,
  deps: MainDeps,
): void {
  deps.out(
    `\n${pc.bold(pc.cyan(`${ROCKET} Canary Executing ${framework} Test...`))}\n`,
  );

  const [exitCode, stdout, stderr] = deps
    .makeExecutor()
    .execute(filePath, framework);

  const colorize = exitCode === 0 ? pc.green : pc.red;
  deps.out(
    colorize(
      `Result: ${exitCode === 0 ? 'Success' : 'Failure'} (Exit ${exitCode})`,
    ),
  );

  if (stderr) deps.out(`\n${pc.red('Error:')}\n${stderr}`);
  if (stdout) deps.out(`\n${pc.dim('Output:')}\n${stdout}`);
}

// --- init / setup ------------------------------------------------------------

function companyJsonPresent(deps: MainDeps): boolean {
  return existsSync(join(deps.cwd(), '.canary', 'company.json'));
}

function printInitSignpost(deps: MainDeps): void {
  deps.out(
    `\n${pc.bold(pc.cyan('canary init'))} ${EM_DASH} what would you like to do?\n`,
  );
  if (!companyJsonPresent(deps)) {
    deps.out(
      `${pc.yellow(`This repo has no ${pc.bold('.canary/company.json')} yet ${EM_DASH} agents that rely on it run degraded.`)}\n`,
    );
  }
  deps.out(
    `${pc.bold('Set up canary in this repo')} (recommended first step):`,
  );
  deps.out(
    `  ${pc.bold(pc.green('canary setup'))}  ${pc.dim('alias for `canary company-knowledge init`')}\n`,
  );
  deps.out(pc.bold('Scaffold a test suite:'));
  deps.out(
    `  ${pc.bold(pc.green('canary init <framework>'))}  ${pc.dim('playwright | vitest | pytest | k6')}\n`,
  );
}

export function initCmd(framework: string | undefined, deps: MainDeps): void {
  if (framework === undefined) {
    printInitSignpost(deps);
    return;
  }

  deps.out(
    `\n${pc.bold(pc.cyan(`${HAMMER} Canary Initializing ${framework} Scaffold...`))}\n`,
  );

  try {
    const result = deps.makeScaffolder().scaffold(framework) as {
      status?: string;
      guidance?: string;
      created_dirs?: string[];
      created_files?: string[];
      skipped_files?: string[];
    };

    if (result.status === 'unsupported') {
      deps.out(pc.bold(pc.yellow(`${WARN} ${result.guidance}`)));
      return;
    }

    deps.out(`${pc.bold(pc.green(`${CHECK_MARK} Scaffolding Complete`))}\n`);

    if (result.created_dirs && result.created_dirs.length) {
      deps.out(pc.bold('Directories Created:'));
      for (const d of result.created_dirs) deps.out(`  + ${d}`);
    }
    if (result.created_files && result.created_files.length) {
      deps.out(`\n${pc.bold('Files Created:')}`);
      for (const f of result.created_files) deps.out(`  + ${f}`);
    }
    if (result.skipped_files && result.skipped_files.length) {
      deps.out(`\n${pc.bold(pc.yellow('Files Skipped (Already Exist):'))}`);
      for (const f of result.skipped_files) deps.out(`  - ${f}`);
    }

    deps.out(`\n${pc.bold(pc.cyan(`${NEXT} Next Steps:`))}`);
    const fw = framework.toLowerCase();
    if (fw === 'playwright') {
      deps.out(
        `  1. Run: ${pc.bold(pc.green('npm install -D @playwright/test'))}`,
      );
      deps.out(`  2. Run: ${pc.bold(pc.green('npx playwright install'))}`);
    } else if (fw === 'vitest') {
      deps.out(`  1. Run: ${pc.bold(pc.green('npm install -D vitest'))}`);
    } else if (fw === 'pytest') {
      deps.out(`  1. Run: ${pc.bold(pc.green('pip install pytest'))}`);
    } else if (fw === 'k6') {
      deps.out(
        `  1. Install k6: ${pc.bold(pc.green('https://k6.io/docs/getting-started/installation/'))}`,
      );
    }
  } catch (e) {
    // Python catches ValueError (unknown framework); the TS scaffolder throws a
    // plain Error for the same case.
    deps.out(
      `\n${pc.bold(pc.red(`${REDX} Error: ${e instanceof Error ? e.message : String(e)}`))}`,
    );
    deps.out(pc.yellow('Supported frameworks: playwright, vitest, pytest, k6'));
  }
}

interface SetupOptions {
  force?: boolean;
}

export function setupCmd(opts: SetupOptions, deps: MainDeps): void {
  ckInitCmd({ force: opts.force ?? false }, deps);
}

// --- migrate -----------------------------------------------------------------

interface MigrateOptions {
  path: string;
  framework?: string;
  from?: string;
  overlay?: string;
  apply?: boolean;
  check?: boolean;
  force?: boolean;
  json?: boolean;
}

function resolveMigrateOverlay(
  fromOverlay: string | undefined,
  overlay: string | undefined,
  deps: MainDeps,
): string | null {
  if (fromOverlay) {
    if (overlay) {
      deps.out(
        pc.yellow(
          'Both --from and --overlay given; using --from and ignoring --overlay.',
        ),
      );
    }
    try {
      return resolveOverlay(fromOverlay, deps.home());
    } catch (e) {
      if (e instanceof OverlayNotFound) {
        deps.out(`\n${pc.bold(pc.red(CROSS))} ${e.message}`);
        throw new CliExitError(1);
      }
      throw e;
    }
  }

  if (overlay) {
    deps.out(
      pc.yellow(
        `--overlay is deprecated; use ${pc.bold('--from <overlay-name|path>')} instead.`,
      ),
    );
    return resolve(overlay);
  }

  const tracked = listOverlays(deps.home());
  if (tracked.length === 1) {
    deps.out(
      pc.dim(
        `Using tracked overlay '${tracked[0]}' (the only one registered).`,
      ),
    );
    return resolveOverlay(tracked[0]!, deps.home());
  }
  if (tracked.length > 1) {
    const names = tracked.join(', ');
    deps.out(
      `\n${pc.bold(pc.red(CROSS))} ${tracked.length} tracked overlays registered (${names}).\nChoose one with ${pc.bold('--from <name>')}.`,
    );
    throw new CliExitError(1);
  }
  return null;
}

function migrateCheck(
  migrator: ReturnType<MainDeps['makeMigrator']>,
  root: string,
  overlayPath: string | null,
  json: boolean,
  deps: MainDeps,
): void {
  if (overlayPath === null) {
    deps.out(
      `\n${pc.yellow('No overlay to check against.')} Track one with ${pc.bold('canary overlay add')} or pass ${pc.bold('--from <overlay>')}.`,
    );
    throw new CliExitError(0);
  }

  let report;
  try {
    report = migrator.checkFreshness(root, { overlayPath });
  } catch (e) {
    deps.out(
      `\n${pc.bold(pc.red(CROSS))} ${e instanceof Error ? e.message : String(e)}`,
    );
    throw new CliExitError(1);
  }

  if (json) {
    deps.out(jsonIndent2(report.to_dict()));
  } else {
    deps.out(report.to_markdown());
  }

  throw new CliExitError(report.exit_code());
}

export function migrateCmd(opts: MigrateOptions, deps: MainDeps): void {
  const root = resolve(opts.path);
  const overlayPath = resolveMigrateOverlay(opts.from, opts.overlay, deps);
  const migrator = deps.makeMigrator();

  if (opts.check) {
    migrateCheck(migrator, root, overlayPath, opts.json ?? false, deps);
    return; // unreachable -- migrateCheck always throws CliExitError
  }

  let ctx;
  try {
    ctx = migrator.detect(root);
  } catch (e) {
    deps.out(
      `\n${pc.bold(pc.red('Detection error:'))} ${e instanceof Error ? e.message : String(e)}`,
    );
    throw new CliExitError(1);
  }

  if (!ctx.is_harness_project) {
    if (ctx.not_test_project_reason) {
      deps.out(`\n${pc.bold(pc.red(CROSS))} ${ctx.not_test_project_reason}`);
    } else {
      deps.out(
        `\n${pc.bold(pc.red(CROSS))} No harness project detected at ${pc.bold(root)}.\nExpected ${pc.dim('harness.config.json')} and ${pc.dim('.harness/')} directory.`,
      );
    }
    throw new CliExitError(1);
  }

  const dryRun = !opts.apply;
  const modeLabel = dryRun ? pc.dim('(dry run)') : pc.green('(apply)');
  deps.out(`\n${pc.bold(pc.cyan('Canary Migrate'))} ${modeLabel}\n`);

  if (!dryRun) deps.out(`${pc.yellow('Writing files to disk...')}\n`);

  let report;
  try {
    report = migrator.migrate(root, {
      dryRun,
      framework: opts.framework || null,
      overlayPath,
      force: opts.force ?? false,
    });
  } catch (e) {
    deps.out(
      `\n${pc.bold(pc.red('Error:'))} ${e instanceof Error ? e.message : String(e)}`,
    );
    throw new CliExitError(1);
  }

  if (opts.json) {
    deps.out(
      jsonIndent2({
        framework: report.framework,
        shape: report.shape,
        dry_run: report.dry_run,
        created_files: report.created_files,
        created_dirs: report.created_dirs,
        skipped_configs: report.skipped_configs,
        preserved_files: report.preserved_files,
        would_create: report.would_create,
        manual_followups: report.manual_followups,
        config_warnings: report.config_warnings,
        deployed_skills: report.deployed_skills.map((r) => ({
          skill_name: r.skill_name,
          status: r.status,
          note: r.note,
        })),
        installed_workflows: report.installed_workflows.map((r) => r.to_dict()),
      }),
    );
    return;
  }

  deps.out(report.to_markdown());

  if (dryRun && report.would_create.length) {
    deps.out(
      `\n${pc.dim(`Re-run with ${pc.bold('--apply')} to write these files.`)}`,
    );
  }
}

// --- review-test / flake-check -----------------------------------------------

interface LintOptions {
  static?: boolean;
  framework?: string;
  json?: boolean;
}

const SEV_COLOR: Record<string, (s: string) => string> = {
  critical: pc.red,
  warning: pc.yellow,
  info: pc.dim,
};
const SEV_ORDER: Record<string, number> = { critical: 0, warning: 1, info: 2 };

function findingPayload(f: LintFinding): Record<string, unknown> {
  return {
    file: f.file,
    line: f.line,
    rule: f.rule,
    severity: f.severity,
    message: f.message,
    suggestion: f.suggestion,
  };
}

/** Human-readable list of what the collectors look for, for remedy text. */
const SCANNABLE_DESC = `test_*.py, *.test|spec.{${JS_TEST_EXTENSIONS.map((e) =>
  e.slice(1),
).join(',')}}`;

/** Emit the abstention notice in the caller's output mode, then exit 3. */
function abstain(remedy: string, deps: MainDeps, json: boolean): never {
  const outcome = gateOutcome({ checked: 0, findings: [] }, 'gate');
  if (json) {
    deps.out(jsonIndent2([]));
    deps.err(`${outcome.summaryLine} ${remedy}`);
  } else {
    deps.out(pc.bold(pc.yellow(outcome.summaryLine)));
    deps.out(`  ${remedy}`);
  }
  throw new CliExitError(outcome.exitCode);
}

/**
 * The denominator guard shared by the file-scanning gates (#508 Wave 4a).
 *
 * `review-test` and `flake-check` used to render a green all-clear whenever
 * their finding list was empty -- indistinguishable from a run that scanned a
 * directory matching zero test files. That is the #503 shape: a gate that
 * verified nothing reporting a pass. Both are GATES (they carry an exit-code
 * contract), so a collapsed denominator exits 3.
 *
 * Returns without throwing when at least one file was collected; the caller's
 * normal rendering continues. `--json` keeps a parseable array on stdout -- only
 * the exit code and the stderr notice carry the abstention.
 */
function abstainOnZeroFiles(
  files: readonly string[],
  path: string,
  deps: MainDeps,
  json: boolean,
): void {
  if (files.length > 0) return;
  abstain(
    `No test file matched under ${path} (looked for ${SCANNABLE_DESC}). ` +
      `Point at a directory that holds tests, or pass a single file directly.`,
    deps,
    json,
  );
}

/**
 * The single-file half of the same guard (#566).
 *
 * `abstainOnZeroFiles` only ever fires on a directory: a single file is passed
 * straight through as a one-element list, so its denominator is never zero. It
 * can still be unmeasurable -- an extension no ruleset parses used to fall back
 * to the Python scanners, which find nothing in ESM JavaScript and so rendered
 * "No issues found" over a file that was never actually read. Zero findings
 * from a scanner that could not parse the input is an abstention, not a pass.
 */
function abstainOnUnlintableFile(
  path: string,
  deps: MainDeps,
  json: boolean,
): void {
  if (frameworkForPath(path) !== null) return;
  const ext = extname(path) || basename(path);
  abstain(
    `Cannot lint ${ext} — no ruleset parses it, so a clean result would be ` +
      `meaningless (looked for ${SCANNABLE_DESC}).`,
    deps,
    json,
  );
}

export function reviewTestCmd(
  path: string,
  opts: LintOptions,
  deps: MainDeps,
): void {
  const json = opts.json === true;
  const files = isDir(path) ? collectTestFiles(path) : [path];
  abstainOnZeroFiles(files, path, deps, json);
  if (!isDir(path) && !opts.framework)
    abstainOnUnlintableFile(path, deps, json);
  const linter = deps.makeLinter();
  const allFindings: LintFinding[] = [];
  for (const f of files) allFindings.push(...linter.lint(f, opts.framework));

  // `--json` renders the machine payload and then falls through to the same
  // exit-code decision as human mode. It used to `return` here, so a consumer
  // gating on `$?` saw every finding-bearing run as clean (#566).
  if (json) {
    deps.out(jsonIndent2(allFindings.map(findingPayload)));
    if (allFindings.some((f) => f.severity === 'critical')) {
      throw new CliExitError(1);
    }
    return;
  }

  if (allFindings.length === 0) {
    deps.out(pc.bold(pc.green(`${CHECK_MARK} No issues found.`)));
    return;
  }

  allFindings.sort(
    (a, b) =>
      cmpStr(a.file, b.file) ||
      a.line - b.line ||
      (SEV_ORDER[a.severity] ?? 9) - (SEV_ORDER[b.severity] ?? 9),
  );

  const counts: Record<string, number> = { critical: 0, warning: 0, info: 0 };
  for (const f of allFindings) {
    counts[f.severity] = (counts[f.severity] ?? 0) + 1;
    const color = SEV_COLOR[f.severity] ?? pc.white;
    deps.out(
      `${color(`[${f.severity.toUpperCase()}]`)} ${f.file}:${f.line} ${pc.dim(`(${f.rule})`)}`,
    );
    deps.out(`  ${f.message}`);
    deps.out(`  ${pc.dim(`${ARROW} ${f.suggestion}`)}\n`);
  }

  const parts: string[] = [];
  if (counts['critical']) parts.push(pc.red(`${counts['critical']} critical`));
  if (counts['warning']) parts.push(pc.yellow(`${counts['warning']} warning`));
  if (counts['info']) parts.push(pc.dim(`${counts['info']} info`));
  deps.out(
    `${pc.bold(`${allFindings.length} finding(s):`)} ${parts.join(', ')}`,
  );

  if (counts['critical']) throw new CliExitError(1);
}

export function flakeCheckCmd(
  path: string,
  opts: { json?: boolean },
  deps: MainDeps,
): void {
  const json = opts.json === true;
  const files = isDir(path) ? collectTestFiles(path) : [path];
  abstainOnZeroFiles(files, path, deps, json);
  if (!isDir(path)) abstainOnUnlintableFile(path, deps, json);
  const linter = deps.makeLinter();
  const allFindings: LintFinding[] = [];
  for (const f of files) allFindings.push(...linter.flakeCheck(f));

  // Exit-code parity with human mode, same reason as `review-test` above.
  if (json) {
    deps.out(jsonIndent2(allFindings.map(findingPayload)));
    if (allFindings.length > 0) throw new CliExitError(1);
    return;
  }

  if (allFindings.length === 0) {
    deps.out(
      pc.bold(pc.green(`${CHECK_MARK} No flakiness patterns detected.`)),
    );
    return;
  }

  for (const f of allFindings) {
    const color = f.severity === 'critical' ? pc.red : pc.yellow;
    deps.out(
      `${color(`[${f.severity.toUpperCase()}]`)} ${f.file}:${f.line} ${pc.dim(`(${f.rule})`)}`,
    );
    deps.out(`  ${f.message}`);
    deps.out(`  ${pc.dim(`${ARROW} ${f.suggestion}`)}\n`);
  }

  deps.out(pc.bold(`${allFindings.length} flakiness pattern(s) found.`));
  throw new CliExitError(1);
}

// --- vacuity-check (canary-cassandra, #612) ----------------------------------

/**
 * The CLI surface of the vacuity scanner.
 *
 * Registered as an **advisory** command, not a gate: this repo's established
 * shape for a brand-new detector is advisory first, ratchet to strict only after
 * triage (the dogfooding jobs, #485). So findings exit 0.
 *
 * The abstention half is NOT advisory, and the asymmetry is the whole #508
 * doctrine. "I found weak tests" is information a repo absorbs over time; "I
 * verified nothing" is a broken instrument, and a vacuity detector that reported
 * its own silence as success would be the exact false-green class it exists to
 * find. Two distinct zeros are guarded: no file matched, and files matched but
 * held no tests -- a scanner that only checked the first prints a clean tick on
 * the second.
 */
export function vacuityCheckCmd(
  path: string,
  opts: { json?: boolean },
  deps: MainDeps,
): void {
  const json = opts.json === true;
  const files = isDir(path) ? collectTestFiles(path) : [path];

  const findings: VacuityFinding[] = [];
  const skipped: SkipEntry[] = [];
  let checked = 0;
  for (const f of files) {
    const r = scanVacuity(f);
    checked += r.checked;
    findings.push(...r.findings);
    if (r.skipped) skipped.push(...r.skipped);
  }
  if (files.length === 0) {
    skipped.push({
      name: path,
      reason: `no test file matched (looked for ${SCANNABLE_DESC})`,
    });
  }

  const result: GateResult<VacuityFinding> = { checked, findings };
  if (skipped.length > 0) result.skipped = skipped;
  const outcome = gateOutcome(result, 'advisory', { noun: 'test(s)' });
  // `advisory` keeps findings at exit 0; the abstention still has to be loud, so
  // the exit code for a zero denominator is taken from the gate contract.
  const exitCode = outcome.abstained ? EXIT_ABSTAINED : 0;

  if (json) {
    deps.out(
      jsonIndent2({
        checked,
        abstained: outcome.abstained,
        findings,
        skipped,
      }),
    );
    if (exitCode !== 0) throw new CliExitError(exitCode);
    return;
  }

  for (const f of findings) {
    const color = f.severity === 'critical' ? pc.red : pc.yellow;
    const tier = f.fidelity ? pc.dim(` [${f.fidelity}]`) : '';
    deps.out(
      `${color(`[${f.severity.toUpperCase()}]`)} ${f.file}:${f.line} ${pc.dim(`(${f.rule})`)}${tier}`,
    );
    deps.out(`  ${f.test}: ${f.message}`);
    deps.out(`  ${pc.dim(`${ARROW} ${f.suggestion}`)}\n`);
  }
  deps.out(
    outcome.abstained
      ? pc.bold(pc.yellow(outcome.summaryLine))
      : `${pc.bold(outcome.summaryLine)}`,
  );
  if (exitCode !== 0) throw new CliExitError(exitCode);
}

// --- promote-check (#477) ----------------------------------------------------

/**
 * The gate `canary-promote-test` Phase 1 consumes.
 *
 * Unlike `vacuity-check` this IS a gate, and deliberately so: it does not scan a
 * repository, it decides whether ONE generated draft may enter the committed
 * suite. A blocking finding there is not a backlog item to triage, it is a
 * reason not to import the draft. Nothing existing turns red -- the command is
 * new and only ever pointed at `tests/generated/`.
 */
export function promoteCheckCmd(
  path: string,
  opts: { json?: boolean },
  deps: MainDeps,
): void {
  const verdict = promotionVerdict(path);
  if (opts.json === true) {
    deps.out(jsonIndent2(verdict as unknown as Record<string, unknown>));
    if (verdict.exitCode !== 0) throw new CliExitError(verdict.exitCode);
    return;
  }

  for (const axis of verdict.axes) {
    for (const f of axis.findings) {
      const blocking = axis.gating && verdict.blocked.includes(f.rule);
      const label = blocking ? pc.red('[BLOCK]') : pc.yellow('[ADVISORY]');
      const tier = f.fidelity ? pc.dim(` [${f.fidelity}]`) : '';
      deps.out(
        `${label} ${verdict.file}:${f.line} ${pc.dim(`(${f.rule}/${axis.axis})`)}${tier}`,
      );
      deps.out(`  ${f.message}`);
      deps.out(`  ${pc.dim(`${ARROW} ${f.suggestion}`)}\n`);
    }
  }

  const banner: Record<string, string> = {
    promote: pc.green(`${CHECK_MARK} PROMOTE`),
    block: pc.red(`${REDX} BLOCK`),
    abstain: pc.yellow(`${WARN} ABSTAIN`),
  };
  deps.out(
    `${pc.bold(banner[verdict.decision]!)} ${EM_DASH} ${verdict.summaryLine}`,
  );
  if (verdict.remedy) deps.out(`  ${verdict.remedy}`);
  if (verdict.exitCode !== 0) throw new CliExitError(verdict.exitCode);
}

// --- heal-test ---------------------------------------------------------------

interface HealOptions {
  pattern?: boolean;
  dryRun?: boolean;
  json?: boolean;
}

export function healTestCmd(
  path: string,
  opts: HealOptions,
  deps: MainDeps,
): void {
  if (!isFile(path)) {
    deps.out(pc.red(`Error: ${path} is not a file.`));
    throw new CliExitError(1);
  }

  const result = deps.makeHealer().heal(path);

  if (opts.json) {
    const payload = {
      file: result.file,
      changed: result.changed,
      changes: result.changes.map((c) => ({
        line: c.line,
        rule: c.rule,
        description: c.description,
        before: c.before.trim(),
        after: c.after.trim(),
      })),
      skipped: result.skipped,
    };
    deps.out(jsonIndent2(payload));
    if (result.changed && !opts.dryRun) {
      writeFileSync(path, result.patched_content, 'utf-8');
    }
    return;
  }

  if (!result.changed) {
    deps.out(
      pc.bold(pc.green(`${CHECK_MARK} No auto-fixable patterns found.`)),
    );
    for (const s of result.skipped) {
      deps.out(`${pc.yellow(`${WARN} Skipped:`)} ${s}`);
    }
    return;
  }

  deps.out(`${pc.bold(pc.cyan(`${WRENCH} Pattern fixes for ${path}`))}\n`);
  for (const c of result.changes) {
    deps.out(
      `${pc.green(`line ${c.line}`)} ${pc.dim(`(${c.rule})`)} ${c.description}`,
    );
    deps.out(`  ${pc.red(`- ${c.before.trim()}`)}`);
    deps.out(`  ${pc.green(`+ ${c.after.trim()}`)}\n`);
  }

  for (const s of result.skipped) {
    deps.out(`${pc.yellow(`${WARN} Skipped:`)} ${s}\n`);
  }

  if (opts.dryRun) {
    deps.out(
      pc.dim(
        `${result.changes.length} fix(es) ready. Re-run without --dry-run to apply.`,
      ),
    );
  } else {
    writeFileSync(path, result.patched_content, 'utf-8');
    deps.out(
      pc.bold(
        pc.green(
          `${CHECK_MARK} ${result.changes.length} fix(es) applied to ${path}`,
        ),
      ),
    );
  }
}

// --- version / upgrade -------------------------------------------------------

export function versionCmd(deps: MainDeps): void {
  deps.out(renderBanner(resolveVersion(deps)));
}

interface UpgradeOptions {
  dryRun?: boolean;
}

export function upgradeCmd(opts: UpgradeOptions, deps: MainDeps): void {
  const current = resolveVersion(deps);
  deps.out(pc.dim(`Current version: ${current}`));

  if (opts.dryRun) {
    deps.out(
      pc.dim(`Dry run ${EM_DASH} run without --dry-run to apply the upgrade.`),
    );
    return;
  }

  const report = (): void => {
    const updated = resolveVersion(deps);
    if (updated !== current) {
      deps.out(pc.green(`${CHECK} ${current} ${ARROW} ${updated}`));
    } else {
      deps.out(pc.dim(`Already up to date (${current})`));
    }
  };

  const pipx = deps.runSubprocess('pipx', ['upgrade', 'canary-test-ai']);
  if (pipx.status === 0) {
    report();
    return;
  }

  deps.out(pc.yellow(`pipx not found ${EM_DASH} trying pip...`));
  const pip = deps.runSubprocess(deps.pythonExe(), [
    '-m',
    'pip',
    'install',
    '--upgrade',
    'canary-test-ai',
  ]);
  if (pip.status === 0) {
    report();
  } else {
    deps.out(`${pc.red('Upgrade failed.')}\n${pip.stderr.trim()}`);
    throw new CliExitError(1);
  }
}

// --- overlay / doctor (npm-shim pointers) ------------------------------------

export function overlayCmd(deps: MainDeps): void {
  deps.out(
    `${pc.yellow('`canary overlay` is provided by the npm install of Canary.')}\nInstall it with:  ${pc.bold('npm install -g canary-test-cli')}\nThe pipx/Python entry point does not include the overlay commands.`,
  );
  throw new CliExitError(1);
}

export function doctorCmd(deps: MainDeps): void {
  deps.out(
    `${pc.yellow('`canary doctor` is provided by the npm install of Canary.')}\nInstall it with:  ${pc.bold('npm install -g canary-test-cli')}\nThe pipx/Python entry point does not include the doctor command.`,
  );
  throw new CliExitError(1);
}

// --- ticket-update -----------------------------------------------------------

interface TicketUpdateOptions {
  testFile?: string;
  result?: string;
  dryRun?: boolean;
  commentOnly?: boolean;
  transitionOnly?: boolean;
  project?: string;
  ticket?: string;
}

export async function ticketUpdateCmd(
  opts: TicketUpdateOptions,
  deps: MainDeps,
): Promise<void> {
  let reportData: Record<string, unknown> = {};
  if (opts.result) {
    try {
      reportData = JSON.parse(readFileSync(opts.result, 'utf-8')) as Record<
        string,
        unknown
      >;
    } catch (exc) {
      deps.out(
        pc.red(
          `Could not read result file '${opts.result}': ${exc instanceof Error ? exc.message : String(exc)}`,
        ),
      );
      throw new CliExitError(1);
    }
  }

  const testFile = opts.testFile;
  const suiteName =
    (reportData['suite_name'] as string) ?? (testFile || 'unknown');
  const envName =
    (reportData['env'] as string) ?? deps.env['CANARY_ENV'] ?? 'unknown';
  let rawResult = String(reportData['result'] ?? 'FAIL').toUpperCase();
  if (!['PASS', 'FAIL', 'PARTIAL'].includes(rawResult)) rawResult = 'FAIL';

  const passedNames = (reportData['passed_names'] as string[]) ?? [];
  const failedPairs = (reportData['failed_names'] as unknown[]) ?? [];
  const failedNames: [string, string][] = failedPairs.map((item) =>
    Array.isArray(item) && item.length >= 2
      ? [String(item[0]), String(item[1])]
      : [String(item), 'unknown'],
  );

  const summary = new RunSummary({
    suite_name: suiteName,
    env: envName,
    result: rawResult as 'PASS' | 'FAIL' | 'PARTIAL',
    passed: (reportData['passed'] as number) ?? passedNames.length,
    total:
      (reportData['total'] as number) ??
      passedNames.length + failedNames.length,
    flaky_count: (reportData['flaky_count'] as number) ?? 0,
    duration_s: Number(reportData['duration_s'] ?? 0.0),
    test_file: testFile ?? (reportData['test_file'] as string) ?? '',
    report_url: (reportData['report_url'] as string | null) ?? null,
    passed_names: passedNames,
    failed_names: failedNames,
    ticket_key: opts.ticket ?? null,
    project_key: opts.project ?? null,
  });

  const updater = deps.makeTicketUpdater();
  const updateResult = await updater.update(summary, {
    dryRun: opts.dryRun ?? false,
    commentOnly: opts.commentOnly ?? false,
    transitionOnly: opts.transitionOnly ?? false,
  });

  for (const msg of updateResult.messages) deps.out(msg);

  if (!opts.dryRun) {
    if (updateResult.comment_posted) {
      deps.out(
        `${pc.green(CHECK)} Comment posted to ${updateResult.ticket_key}`,
      );
    }
    const tr = updateResult.transition;
    if (tr.attempted && tr.succeeded) {
      deps.out(
        `${pc.green(CHECK)} Transitioned ${updateResult.ticket_key}: "${tr.from_status}" ${ARROW} "${tr.to_status}"`,
      );
    } else if (tr.attempted && !tr.succeeded) {
      deps.out(`${pc.yellow(WARN)}  Transition failed: ${tr.reason}`);
    }
  }

  if (updateResult.transition.reason.startsWith(WARN)) {
    throw new CliExitError(1);
  }
}

/** Python string `<`/`>` comparison (stable code-unit order). */
function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
