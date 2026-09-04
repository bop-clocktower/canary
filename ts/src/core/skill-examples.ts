/**
 * Execute the commands the docs promise (#487).
 *
 * #472 added `canary skills run canary-blackhawk -- --help` to a SKILL.md in
 * the same PR that left the command broken: the CLI landed at mode 644, the
 * spawn hit `EACCES`, and that became a bare exit 1 with no output. Nobody had
 * ever run the command the doc documented. #480 answered part of it with a
 * hand-written `spawnSync(cli, ['--help'])` per skill — real execution, which
 * is why the exec-bit bug surfaced at all — but the block is duplicated across
 * five test files, so a seventh skill is covered only when somebody remembers
 * to add a sixth copy (#479).
 *
 * This module is the discovery-driven form. It consumes the surface inventory
 * from {@link ./skill-surfaces.js} — deliberately, rather than walking the skill
 * tree a second time: two walkers with two notions of what a skill is would
 * disagree eventually, and that disagreement is the very bug class both checks
 * exist to catch.
 *
 * ## Which examples are executable
 *
 * #487 left this as an open scope decision. The answer taken here is
 * conservative and mechanical, because the alternative — a fenced-block
 * annotation — asks every SKILL.md author to opt in, and an opt-in that is
 * forgotten reads exactly like a skill with no examples:
 *
 *   - The command must live in a **shell-info fenced block** (` ```bash `,
 *     `sh`, `shell`, `zsh`, `console`). Prose backticks are illustrative.
 *   - It must be a **`canary` invocation**. Running arbitrary `npm`/`git` lines
 *     out of a doc is a different and much larger blast radius.
 *   - It must carry **no placeholder or shell metacharacter** (`<path>`, `$VAR`,
 *     a pipe, a glob). A placeholder command was never meant to run verbatim.
 *   - It must be **help-shaped** (`--help` / `-h` / `--version`, or a pure
 *     listing command). This is what keeps a documented `katana scan` from
 *     writing a ledger into whatever directory CI happens to be sitting in.
 *
 * Everything else is {@link ExampleVerdict.Unverifiable}, **with its reason
 * recorded**. That is the load-bearing half of the design, and it is the same
 * distinction `reachability.ts` draws between a dead link and a slow one: an
 * outcome the checker is not entitled to assert on gets its own status instead
 * of being folded into either pass or fail.
 *
 * ## Denominator
 *
 * `checked` counts the examples **actually executed** — never the examples
 * found. Unverifiable examples travel in `GateResult.skipped`, so `gateOutcome`
 * renders them in every summary line (D7) and an all-illustrative corpus
 * ABSTAINS rather than reporting "all 0 examples passed" (#508).
 */

import { spawnSync } from 'node:child_process';

import type { GateResult, SkipEntry } from './gate-result.js';
import { SurfaceKind, type SurfaceDeclaration } from './skill-surfaces.js';

/** Fence info strings whose contents are shell commands. */
const SHELL_FENCES = new Set(['bash', 'sh', 'shell', 'zsh', 'console']);

/**
 * Characters that make a command line unsafe to run verbatim: placeholder
 * brackets, variable expansion, redirection, pipes, subshells, globs.
 */
const PLACEHOLDER = /[<>${}|`*\\]/;

/** Flags that make an invocation a pure read of the CLI's own surface. */
const HELP_FLAGS = new Set(['--help', '-h', '--version', '-V']);

/** Non-mutating subcommands worth executing even without a help flag. */
const READ_ONLY_COMMANDS = new Set(['canary skills list']);

/**
 * The author's declaration that a block is illustrative (#707).
 *
 * Placed on its own line immediately above the fence it governs:
 *
 *     <!-- canary:illustrative -->
 *     ```bash
 *     canary katana scan --since HEAD~1
 *     ```
 *
 * Two facts land in the same "unverifiable" bucket and they are not the same
 * fact: "nobody could run this" and "this was never meant to be run". The
 * first is a gap in the corpus; the second is a deliberate authoring choice.
 * Collapsing them is what let 88% of the corpus read as coverage debt when
 * some of it was prose doing its job — and, worse, hid the real gaps inside
 * the pile.
 *
 * Marking is NOT an escape hatch from the executable-example rule. It changes
 * the reason on one block; a code-bearing skill still has to carry at least
 * one example that actually runs (`no-executable-example`), so a skill cannot
 * mark its way to green.
 */
const ILLUSTRATIVE_MARKER = /^\s*<!--\s*canary:illustrative\s*-->\s*$/;

/**
 * The reason carried by a declared-illustrative example.
 *
 * Exported because the summary line splits the unverifiable bucket on it
 * (see {@link countDeclaredIllustrative}). A string literal compared in two
 * files is a drift waiting to happen, and the drift would be silent: the
 * split would quietly read 0 declared and the distinction this issue exists
 * to draw would be gone with nothing red.
 */
export const ILLUSTRATIVE_REASON =
  'declared illustrative by the author, so it is not run';

/**
 * How many of a gate's skipped examples were skipped BY DECLARATION.
 *
 * The rest are the honest gap: examples nobody could run and nobody said
 * were prose.
 */
export function countDeclaredIllustrative(skipped: SkipEntry[]): number {
  return skipped.filter((s) => s.reason === ILLUSTRATIVE_REASON).length;
}

/** One command line a SKILL.md tells the reader to run. */
export interface DocumentedExample {
  /** The skill whose SKILL.md carries it. */
  skill: string;
  /** Absolute path of the declaring file. */
  path: string;
  /** The command, prompt-stripped and trimmed. */
  command: string;
  /** 1-based source line, so a finding points at the doc that lied. */
  line: number;
  executable: boolean;
  /**
   * The author marked this block illustrative (#707), so it is unverifiable
   * BY DECLARATION rather than because the classifier could not run it.
   */
  declaredIllustrative: boolean;
  /** Why it cannot be executed. Set exactly when `executable` is false. */
  reason: string | null;
}

/** How an example turned out. */
export enum ExampleVerdict {
  /** Ran and exited 0 — the doc is proven. */
  Executed = 'executed',
  /** Ran and did not exit 0 — the doc promises something broken. */
  Failed = 'failed',
  /** Could not be run at all; the reason travels with it. */
  Unverifiable = 'unverifiable',
}

export interface ExampleResult {
  example: DocumentedExample;
  verdict: ExampleVerdict;
  detail: string;
}

export enum ExampleFindingKind {
  /** A documented command was executed and failed. */
  ExampleFailed = 'example-failed',
  /** A code-bearing skill's doc offers no command to execute at all. */
  NoDocumentedExample = 'no-documented-example',
  /**
   * A code-bearing skill documents commands, but not one of them can be run
   * (#707). Distinct from {@link NoDocumentedExample}, and it was the larger
   * hole: 5 of 9 `cli:` skills sat here while the corpus looked documented.
   * A skill in this state can break in every documented way and CI stays
   * green, which is the false-green shape the whole check exists to close.
   */
  NoExecutableExample = 'no-executable-example',
}

export interface ExampleFinding {
  kind: ExampleFindingKind;
  skill: string;
  path: string;
  detail: string;
}

/**
 * Injected execution seam. `command` is the documented line verbatim; the
 * runner decides how to turn it into a process and where to run it.
 *
 * A `status` of `null` means the process never started (the #472 shape: a
 * missing interpreter or an unexecutable target). It is a FAILURE, never a
 * pass — mapping "no status" to 0 is how a broken command reads as a working
 * one.
 */
export type ExampleRunner = (
  command: string,
  cwd: string,
) => { status: number | null; output: string };

/**
 * Whether `line` closes the currently open fence.
 *
 * A fence closes only on a BARE delimiter run at least as long as the opener,
 * so a ```` block may legitimately contain ``` -- the same fence rule
 * `scripts/check_doc_links.mjs` had to get right for #686.
 */
function closesFence(
  line: string,
  delimiter: RegExpExecArray | null,
  fence: string,
): boolean {
  if (delimiter === null) return false;
  const run = delimiter[1]!;
  return (
    run[0] === fence[0] && run.length >= fence.length && line.trim() === run
  );
}

/** Shell-fenced lines with their 1-based source line numbers. */
function fencedShellLines(
  text: string,
): { line: number; raw: string; illustrative: boolean }[] {
  const out: { line: number; raw: string; illustrative: boolean }[] = [];
  const lines = text.split('\n');
  let fence: string | null = null;
  let shell = false;
  let illustrative = false;
  // The marker governs the NEXT fence, so it survives the blank line authors
  // naturally leave between a comment and a block, and is spent by the fence
  // it opens — a marker cannot leak onto a later, unrelated example.
  let pendingMarker = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const delimiter = /^\s*(`{3,}|~{3,})\s*([A-Za-z0-9_+-]*)/.exec(line);
    if (fence === null) {
      // A fence opens on a delimiter run; the info string decides whether the
      // body is shell. Anything else (json, ts, text) is not a command.
      if (delimiter) {
        fence = delimiter[1]!;
        shell = SHELL_FENCES.has((delimiter[2] ?? '').toLowerCase());
        illustrative = pendingMarker;
        pendingMarker = false;
        continue;
      }
      if (ILLUSTRATIVE_MARKER.test(line)) pendingMarker = true;
      else if (line.trim() !== '') pendingMarker = false;
      continue;
    }
    if (closesFence(line, delimiter, fence)) {
      fence = null;
      shell = false;
      illustrative = false;
      continue;
    }
    if (shell) out.push({ line: i + 1, raw: line, illustrative });
  }
  return out;
}

/** Classify one command line: executable, or unverifiable with a reason. */
function classify(command: string): {
  executable: boolean;
  reason: string | null;
} {
  if (PLACEHOLDER.test(command)) {
    return {
      executable: false,
      reason:
        'contains a placeholder or shell metacharacter, so it was never ' +
        'meant to run verbatim',
    };
  }
  if (READ_ONLY_COMMANDS.has(command))
    return { executable: true, reason: null };
  const tokens = command.split(/\s+/);
  if (tokens.some((t) => HELP_FLAGS.has(t))) {
    return { executable: true, reason: null };
  }
  return {
    executable: false,
    reason:
      'not help-shaped, so running it could write files, need credentials, ' +
      'or reach the network',
  };
}

/**
 * Extract the documented `canary` commands from one document.
 *
 * `text` is the raw file body (the inventory already read it), `skill` and
 * `path` are carried through onto each example so a finding is attributable.
 */
export function extractExamples(
  text: string,
  skill: string,
  path: string,
): DocumentedExample[] {
  const out: DocumentedExample[] = [];
  for (const { line, raw, illustrative } of fencedShellLines(text)) {
    // Strip a `$ ` or `> ` shell prompt; a doc that shows a prompt is still
    // documenting the command after it.
    const command = raw
      .trim()
      .replace(/^[$>]\s+/, '')
      .trim();
    if (command === '' || command.startsWith('#')) continue;
    if (command !== 'canary' && !command.startsWith('canary ')) continue;
    // A declaration beats an inference. The author saying "this is prose"
    // is a better fact than the classifier guessing why it could not run,
    // and it is the fact a reader of the skipped list needs.
    if (illustrative) {
      out.push({
        skill,
        path,
        command,
        line,
        executable: false,
        declaredIllustrative: true,
        reason: ILLUSTRATIVE_REASON,
      });
      continue;
    }
    const { executable, reason } = classify(command);
    out.push({
      skill,
      path,
      command,
      line,
      executable,
      declaredIllustrative: false,
      reason,
    });
  }
  return out;
}

/** Execute the executable examples; report a verdict for every example. */
export function runExamples(
  examples: DocumentedExample[],
  run: ExampleRunner,
  cwd: string,
): ExampleResult[] {
  return examples.map((example) => {
    if (!example.executable) {
      return {
        example,
        verdict: ExampleVerdict.Unverifiable,
        detail: example.reason ?? 'unverifiable',
      };
    }
    const { status, output } = run(example.command, cwd);
    if (status === 0) {
      return { example, verdict: ExampleVerdict.Executed, detail: 'exit 0' };
    }
    return {
      example,
      verdict: ExampleVerdict.Failed,
      detail:
        status === null
          ? `the process never started: ${output.trim() || '(no output)'}`
          : `exit ${status}: ${output.trim() || '(no output)'}`,
    };
  });
}

/** A skill declaration that ships code, and can therefore ship broken code. */
function codeBearing(decl: SurfaceDeclaration): boolean {
  return (
    (decl.kind === SurfaceKind.Skill || decl.kind === SurfaceKind.FlatSkill) &&
    decl.cli !== null
  );
}

/**
 * Run every documented example across the surface inventory.
 *
 * Classified **advisory**: this lands on a corpus whose examples have never
 * been executed, so its precision is not yet known and promoting it to blocking
 * before the first triage is how a check gets muted (ADR 0010). The
 * zero-denominator abstention is loud regardless of that classification.
 */
/** The accumulating tally one declaration's results fold into. */
interface ExampleTally {
  checked: number;
  findings: ExampleFinding[];
  skipped: SkipEntry[];
}

/** Fold one skill declaration's results into `tally`. */
function tallyDeclaration(
  decl: SurfaceDeclaration,
  results: ExampleResult[],
  tally: ExampleTally,
): void {
  for (const result of results) {
    // `<skill>:<line>` rather than the absolute path: a skill's SKILL.md is
    // unambiguous from its name, and 29 absolute paths turned the D7 skip
    // suffix into a summary line no reader would finish. Still fully
    // attributable; `--json` carries the paths.
    const where = `${decl.name}:${result.example.line}`;
    if (result.verdict === ExampleVerdict.Unverifiable) {
      // Never silently dropped: a skip renders in the summary line, so an
      // example nobody can run stays visible instead of leaving the corpus.
      tally.skipped.push({ name: where, reason: result.detail });
      continue;
    }
    tally.checked += 1;
    if (result.verdict === ExampleVerdict.Failed) {
      tally.findings.push({
        kind: ExampleFindingKind.ExampleFailed,
        skill: decl.name,
        path: decl.path,
        detail: `\`${result.example.command}\` (line ${result.example.line}) ${result.detail}`,
      });
    }
  }
}

export function checkExamples(
  surfaces: SurfaceDeclaration[],
  run: ExampleRunner,
  cwd: string,
): GateResult<ExampleFinding> {
  const tally: ExampleTally = { checked: 0, findings: [], skipped: [] };

  for (const decl of surfaces) {
    if (
      decl.kind !== SurfaceKind.Skill &&
      decl.kind !== SurfaceKind.FlatSkill
    ) {
      continue;
    }
    const examples = extractExamples(decl.text, decl.name, decl.path);
    // #487 acceptance: a code-bearing skill with no runnable command in its
    // doc is UNPROVEN, not clean. A markdown-only skill has no command that a
    // mode bit could break, so it is not held to this.
    if (examples.length === 0) {
      if (codeBearing(decl)) {
        tally.findings.push({
          kind: ExampleFindingKind.NoDocumentedExample,
          skill: decl.name,
          path: decl.path,
          detail:
            'declares a `cli:` but its SKILL.md documents no command in a ' +
            'shell fence, so nothing about it has ever been executed from ' +
            'the doc',
        });
      }
      continue;
    }
    // #707: documenting commands is not the same as documenting a RUNNABLE
    // one. The cheapest fix is the skill's own `--help`, which needs no
    // fixtures, credentials or network — and marking blocks illustrative
    // cannot satisfy this, so the declaration stays honest.
    if (codeBearing(decl) && !examples.some((e) => e.executable)) {
      tally.findings.push({
        kind: ExampleFindingKind.NoExecutableExample,
        skill: decl.name,
        path: decl.path,
        detail:
          `declares a \`cli:\` and documents ${examples.length} command(s), ` +
          'but none is executable, so nothing in its doc has ever been run. ' +
          'Add one placeholder-free help-shaped example (its own `--help`).',
      });
    }
    tallyDeclaration(decl, runExamples(examples, run, cwd), tally);
  }

  return tally;
}

/**
 * The production runner: spawn the documented command against the repo's own
 * built CLI, in `cwd`.
 *
 * Two deliberate substitutions, both narrow:
 *
 *   - The leading `canary` token becomes `node <canaryBin>`, because a doc
 *     writes the installed name and CI has a checkout.
 *   - `--allow-executable-skills` is inserted into a `skills run` invocation,
 *     ahead of any `--` separator. `isExecutableSkillAllowed` refuses `cli:`
 *     skills without a TTY, which a spawned process never has, so without the
 *     flag every example would exit 3 and the check would measure the sandbox
 *     rather than the doc. The flag is an execution-context opt-in and changes
 *     nothing about the command's behaviour once it runs. See
 *     {@link exampleArgv} for why the position matters.
 */
export function exampleArgv(command: string, canaryBin: string): string[] {
  const [, ...rest] = command.split(/\s+/);
  if (rest[0] !== 'skills' || rest[1] !== 'run') return [canaryBin, ...rest];
  // The flag must land BEFORE `--`, or canary forwards it to the skill and the
  // executable-skill guard still refuses. Appending it was the first bug this
  // checker found, in itself: all four documented `skills run ... -- --help`
  // examples reported exit 3, which measured the sandbox rather than the doc.
  const sep = rest.indexOf('--');
  const at = sep === -1 ? rest.length : sep;
  return [
    canaryBin,
    ...rest.slice(0, at),
    '--allow-executable-skills',
    ...rest.slice(at),
  ];
}

export function spawnRunner(canaryBin: string): ExampleRunner {
  return (command, cwd) => {
    const res = spawnSync(process.execPath, exampleArgv(command, canaryBin), {
      cwd,
      encoding: 'utf-8',
      timeout: 60_000,
    });
    return {
      status: res.status,
      output: `${res.stdout ?? ''}${res.stderr ?? ''}`,
    };
  };
}
