/**
 * #1208 — a swallowed `check-arch` capture is only safe while a fail-closed
 * consumer downstream of it still gates.
 *
 * Two workflows run `harness check-arch --json > arch-report.json || true`:
 * `harness.yml` (the summariser reinterprets the absolute exit) and
 * `refresh-arch-baseline.yml` (the refresh script reads the same report). On
 * main the command exits 1 on the ABSOLUTE count (12 pre-existing complexity
 * violations, 0 new, on d4b5681f with harness 12.10.1). The swallow is
 * deliberate, and it is safe only because a later step in the same job reads
 * that file and fails the job itself:
 *
 * - `harness-report-summary.mjs --arch`: `newViolations` non-empty → exit 1
 *   (#968); a missing, empty or field-less report → exit 3.
 * - `refresh-arch-baseline.mjs`: a missing, empty or field-less report → exit 3
 *   (pinned in refresh-arch-baseline.test.ts).
 *
 * Every piece of that pairing is a separate line of YAML. Remove one and the
 * `|| true` goes back to masking, with every exit-code test of those scripts
 * still green (they run the script, not the workflow). So this file binds the
 * PAIRING, for every swallowed capture in EVERY workflow:
 *
 *   1. A later step in the SAME job invokes a declared consumer IN COMMAND
 *      POSITION (the logical line starts with `node scripts/<consumer>.mjs`)
 *      and reads the file the capture wrote. A capture with no declared
 *      consumer fails.
 *   2. The consumer can fail the job: no `||` fallback of any kind, no pipe, no
 *      `set +e`, no trailing `; true`, and no `continue-on-error` at step or
 *      job level unless it is absent or literally false.
 *   3. The consumer survives a failed earlier step: its `if:`, with `${{ }}`
 *      and whitespace stripped, is EXACTLY `!cancelled()` or `always()`. A
 *      default (absent) condition is accepted only when the capture has no
 *      condition either and the consumer runs immediately after it, so that
 *      the capture having run (and swallowed) implies the consumer runs.
 *   4. For the summariser, the job's `harness ci check` does not skip `arch`.
 *      Before #1369 the summariser consulted the arch detail only when the CI
 *      report carried an `arch` entry, and exited 0 over a planted new
 *      violation without it. It now abstains (exit 3) on a missing entry, so a
 *      skip would turn every run red rather than green. This rule catches the
 *      skip at test time, before it can reach CI.
 *
 * Fail-closed on parse problems: a workflow YAML that does not parse, or parses
 * to something without a `jobs` map, throws. A job with neither `steps` nor a
 * reusable-workflow `uses:` throws. Both denominators — files parsed and
 * captures found — must be non-zero on the real tree.
 *
 * Offline: parses workflow YAML. Never runs `harness`.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as loadYaml } from 'js-yaml';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORKFLOW_DIR = join(REPO_ROOT, '.github', 'workflows');

interface Step {
  name?: string;
  run?: string;
  if?: unknown;
  'continue-on-error'?: unknown;
}
interface Job {
  steps?: Step[];
  uses?: string;
  'continue-on-error'?: unknown;
}
interface Workflow {
  jobs: Record<string, Job>;
}
type WorkflowSet = Array<[string, Workflow]>;

/** Continuation lines joined, blanks and comments dropped. */
function logicalLines(script: unknown): string[] {
  if (script === undefined) return [];
  return String(script)
    .replace(/\\\r?\n\s*/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** `continue-on-error` that is anything but absent or literally false. */
function softFlag(value: unknown): boolean {
  return value !== undefined && value !== false && value !== 'false';
}

/** Every reason this step's failure would not fail the job. */
function softReasons(step: Step, job: Job): string[] {
  const reasons: string[] = [];
  if (softFlag(step['continue-on-error']))
    reasons.push('step continue-on-error');
  if (softFlag(job['continue-on-error'])) reasons.push('job continue-on-error');
  for (const line of logicalLines(step.run)) {
    if (/\|\|/.test(line)) reasons.push(`|| fallback in \`${line}\``);
    if (/(^|[^|])\|([^|]|$)/.test(line)) reasons.push(`pipe in \`${line}\``);
    if (/\bset\s+(\+e\b|\+o\s+errexit\b)/.test(line))
      reasons.push(`errexit disabled in \`${line}\``);
    if (/;\s*(true|:)\s*$/.test(line))
      reasons.push(`trailing no-op in \`${line}\``);
  }
  return reasons;
}

/** `${{ … }}` and whitespace stripped; '' when there is no condition. */
function normalisedIf(step: Step): string {
  if (step.if === undefined) return '';
  return String(step.if)
    .trim()
    .replace(/^\$\{\{/, '')
    .replace(/\}\}$/, '')
    .replace(/\s+/g, '');
}

/** The consumers known to fail closed on a missing, empty or field-less report. */
const CONSUMERS = [
  {
    name: 'harness-report-summary.mjs',
    invokes: (file: string) =>
      new RegExp(
        `^node scripts/harness-report-summary\\.mjs\\s(?:.*\\s)?--arch\\s+${escape(file)}(?:\\s|$)`,
      ),
    needsArchInCiCheck: true,
  },
  {
    name: 'refresh-arch-baseline.mjs',
    invokes: (file: string) =>
      new RegExp(
        `^node scripts/refresh-arch-baseline\\.mjs\\s+${escape(file)}(?:\\s|$)`,
      ),
    needsArchInCiCheck: false,
  },
] as const;

function stepsOf(file: string, jobId: string, job: Job): Step[] {
  if (Array.isArray(job.steps)) return job.steps;
  if (typeof job.uses === 'string') return [];
  throw new Error(
    `${file} › ${jobId}: job has neither steps nor a reusable-workflow uses`,
  );
}

type Consumer = (typeof CONSUMERS)[number];

/** The first later step in `steps` that invokes a declared consumer of `target`. */
function findConsumer(
  steps: Step[],
  from: number,
  target: string,
): { at: number; consumer: Consumer } | null {
  for (let at = from + 1; at < steps.length; at++) {
    const lines = logicalLines(steps[at]!.run);
    const consumer = CONSUMERS.find((c) =>
      lines.some((l) => c.invokes(target).test(l)),
    );
    if (consumer) return { at, consumer };
  }
  return null;
}

/** Whether the consumer runs on every run in which the capture ran. */
function consumerReachable(
  steps: Step[],
  captureAt: number,
  consumerAt: number,
): boolean {
  const condition = normalisedIf(steps[consumerAt]!);
  if (condition === '!cancelled()' || condition === 'always()') return true;
  return (
    condition === '' &&
    normalisedIf(steps[captureAt]!) === '' &&
    consumerAt === captureAt + 1
  );
}

function ciCheckSkipsArch(steps: Step[]): boolean {
  return steps.some((s) =>
    logicalLines(s.run).some(
      (l) =>
        /\bharness ci check\b/.test(l) && /--skip(\s+|=)\S*\barch\b/.test(l),
    ),
  );
}

/** The violations for one swallowed capture at `steps[index]`. */
function captureViolations(
  where: string,
  job: Job,
  steps: Step[],
  index: number,
  archLine: string,
): string[] {
  const target = /(?<![0-9=])>\s*(\S+)/.exec(archLine)?.[1];
  if (target === undefined) {
    return [`${where}: swallows check-arch without writing a report file`];
  }
  const found = findConsumer(steps, index, target);
  if (!found) {
    return [
      `${where}: no later step in the job invokes a declared fail-closed consumer of ${target}`,
    ];
  }
  const out: string[] = [];
  const name = found.consumer.name;
  const soft = softReasons(steps[found.at]!, job);
  if (soft.length > 0) {
    out.push(
      `${where}: the ${name} step that reads ${target} cannot fail the job (${soft.join('; ')})`,
    );
  }
  if (!consumerReachable(steps, index, found.at)) {
    const condition = normalisedIf(steps[found.at]!) || '(default success())';
    out.push(
      `${where}: the ${name} step's condition \`${condition}\` can skip it after the capture ran`,
    );
  }
  if (found.consumer.needsArchInCiCheck && ciCheckSkipsArch(steps)) {
    out.push(
      `${where}: harness ci check skips arch, so the summariser never consults ${target}`,
    );
  }
  return out;
}

/**
 * Every way a swallowed check-arch capture in `set` is left unguarded, as
 * human-readable reasons, plus both denominators so a caller can refuse to
 * read zero as a pass.
 */
function archCaptureContract(set: WorkflowSet): {
  files: number;
  captures: number;
  violations: string[];
} {
  const violations: string[] = [];
  let captures = 0;
  for (const [file, wf] of set) {
    for (const [jobId, job] of Object.entries(wf.jobs)) {
      const steps = stepsOf(file, jobId, job);
      steps.forEach((step, index) => {
        const archLine = logicalLines(step.run).find((l) =>
          /\bharness\s+check-arch\b/.test(l),
        );
        if (!archLine || softReasons(step, job).length === 0) return;
        captures++;
        const where = `${file} › ${jobId} › ${step.name ?? `step ${index}`}`;
        violations.push(
          ...captureViolations(where, job, steps, index, archLine),
        );
      });
    }
  }
  return { files: set.length, captures, violations };
}

/** Every workflow file, parsed. Throws rather than skipping one it cannot read. */
function realWorkflows(): WorkflowSet {
  return readdirSync(WORKFLOW_DIR)
    .filter((f) => /\.ya?ml$/.test(f))
    .sort()
    .map((f) => {
      const parsed = loadYaml(
        readFileSync(join(WORKFLOW_DIR, f), 'utf-8'),
      ) as Partial<Workflow> | null;
      if (
        parsed === null ||
        typeof parsed !== 'object' ||
        parsed.jobs === null ||
        typeof parsed.jobs !== 'object'
      ) {
        throw new Error(`${f}: parsed to no jobs map`);
      }
      return [f, parsed as Workflow];
    });
}

/** A deep copy of the real set with `mutate` applied to one workflow's job. */
function mutated(
  file: string,
  mutate: (steps: Step[], job: Job, set: WorkflowSet) => void,
): WorkflowSet {
  const set = structuredClone(realWorkflows());
  const entry = set.find(([f]) => f === file);
  if (!entry) throw new Error(`${file} not found`);
  const job = Object.values(entry[1].jobs)[0]!;
  mutate(job.steps!, job, set);
  return set;
}

const isSummariser = (s: Step) =>
  String(s.run ?? '').includes('harness-report-summary.mjs');
const isRefresh = (s: Step) =>
  String(s.run ?? '').includes('refresh-arch-baseline.mjs');
const summariser = (steps: Step[]) => steps.find(isSummariser)!;
const refresher = (steps: Step[]) => steps.find(isRefresh)!;

type Case = [
  string,
  string,
  (s: Step[], j: Job, set: WorkflowSet) => void,
  RegExp,
];

describe('#1208 — every swallowed check-arch capture has a fail-closed consumer', () => {
  describe('the predicate catches every way the pairing breaks', () => {
    // Planted positives: each fixture is the real workflow set with one line of
    // the contract broken. Without them, a predicate that never fires would
    // pass the real-tree assertion below for the wrong reason.
    const H = 'harness.yml';
    const R = 'refresh-arch-baseline.yml';
    const cases: Case[] = [
      // Original pairing breaks.
      [
        'the summariser step is removed',
        H,
        (s) => void s.splice(s.indexOf(summariser(s)), 1),
        /no later step/,
      ],
      [
        'the summariser is continue-on-error: true',
        H,
        (s) => void (summariser(s)['continue-on-error'] = true),
        /cannot fail the job/,
      ],
      [
        'the summariser swallows its own exit with || true',
        H,
        (s) => void (summariser(s).run += ' || true'),
        /cannot fail the job/,
      ],
      [
        'the summariser loses its condition',
        H,
        (s) => void delete summariser(s).if,
        /can skip it/,
      ],
      [
        'the summariser reads a different file',
        H,
        (s) =>
          void (summariser(s).run = summariser(s).run!.replace(
            '--arch arch-report.json',
            '--arch other.json',
          )),
        /no later step/,
      ],
      [
        'the summariser step is moved ahead of the capture step',
        H,
        (s) => {
          const sum = summariser(s);
          s.splice(s.indexOf(sum), 1);
          s.splice(
            s.findIndex((x) => String(x.run).includes('check-arch')),
            0,
            sum,
          );
        },
        /no later step/,
      ],
      [
        'the summariser moves to another job',
        H,
        (s, _j, set) => {
          const sum = summariser(s);
          s.splice(s.indexOf(sum), 1);
          set.find(([f]) => f === H)![1].jobs.other = { steps: [sum] };
        },
        /no later step/,
      ],
      [
        'harness ci check skips arch',
        H,
        (s) => {
          const ci = s.find((x) => String(x.run).includes('harness ci check'))!;
          ci.run = ci.run!.replace(
            '--skip phase-gate',
            '--skip phase-gate,arch',
          );
        },
        /skips arch/,
      ],
      // F1 — scope: every workflow, not just harness.yml.
      [
        'F1: the refresh consumer is removed',
        R,
        (s) => void s.splice(s.indexOf(refresher(s)), 1),
        /refresh-arch-baseline\.yml.*no later step/,
      ],
      [
        'F1: a step slips between the capture and a default-condition refresh',
        R,
        (s) => void s.splice(s.indexOf(refresher(s)), 0, { run: 'echo hi' }),
        /can skip it/,
      ],
      [
        'F1: a new workflow swallows check-arch with no consumer',
        H,
        (_s, _j, set) =>
          void set.push([
            'rogue.yml',
            {
              jobs: {
                x: {
                  steps: [
                    {
                      name: 'cap',
                      run: 'harness check-arch --json > a.json || true',
                    },
                  ],
                },
              },
            },
          ]),
        /rogue\.yml.*no later step/,
      ],
      // F2 — soft detection.
      [
        'F2: the summariser falls back with || echo',
        H,
        (s) => void (summariser(s).run += ' || echo "arch summary failed"'),
        /\|\| fallback/,
      ],
      [
        'F2: the summariser disables errexit',
        H,
        (s) => void (summariser(s).run = `set +e\n${summariser(s).run}`),
        /errexit disabled/,
      ],
      [
        'F2: the summariser ends with ; true',
        H,
        (s) =>
          void (summariser(s).run = `${summariser(s).run!.trimEnd()} ; true`),
        /trailing no-op/,
      ],
      [
        'F2: the summariser pipes into tee',
        H,
        (s) =>
          void (summariser(s).run =
            `${summariser(s).run!.trimEnd()} | tee summary.log`),
        /pipe/,
      ],
      [
        "F2: continue-on-error is the string 'true'",
        H,
        (s) => void (summariser(s)['continue-on-error'] = 'true'),
        /step continue-on-error/,
      ],
      [
        'F2: continue-on-error is an expression',
        H,
        (s) => void (summariser(s)['continue-on-error'] = '${{ true }}'),
        /step continue-on-error/,
      ],
      [
        'F2: the job is continue-on-error',
        H,
        (_s, j) => void (j['continue-on-error'] = true),
        /job continue-on-error/,
      ],
      // F3 — condition must be exact.
      [
        'F3: the condition is `false && !cancelled()`',
        H,
        (s) => void (summariser(s).if = '${{ false && !cancelled() }}'),
        /can skip it/,
      ],
      [
        'F3: the condition is success()',
        H,
        (s) => void (summariser(s).if = '${{ success() }}'),
        /can skip it/,
      ],
      // F4 — command position.
      [
        'F4: the summariser line is only echoed',
        H,
        (s) =>
          void (summariser(s).run =
            'echo node scripts/harness-report-summary.mjs harness-report.json --arch arch-report.json'),
        /no later step/,
      ],
      [
        'F4: the refresh line is only echoed',
        R,
        (s) =>
          void (refresher(s).run =
            'echo node scripts/refresh-arch-baseline.mjs arch-report.json'),
        /no later step/,
      ],
    ];

    for (const [label, file, mutate, reason] of cases) {
      it(`flags it when ${label}`, () => {
        const { violations } = archCaptureContract(mutated(file, mutate));
        expect(violations.join('\n')).toMatch(reason);
      });
    }

    it('does not count a hard (non-swallowed) check-arch as a capture', () => {
      const set: WorkflowSet = [
        [
          'a.yml',
          {
            jobs: {
              a: { steps: [{ run: 'harness check-arch --json > r.json' }] },
            },
          },
        ],
      ];
      expect(archCaptureContract(set)).toEqual({
        files: 1,
        captures: 0,
        violations: [],
      });
    });

    it('flags a swallowed check-arch that writes no file', () => {
      const set: WorkflowSet = [
        [
          'a.yml',
          {
            jobs: {
              a: { steps: [{ name: 'x', run: 'harness check-arch || true' }] },
            },
          },
        ],
      ];
      expect(archCaptureContract(set).violations.join('\n')).toMatch(
        /without writing a report file/,
      );
    });

    it('throws on a job with neither steps nor uses, rather than iterating zero steps', () => {
      const set = [['a.yml', { jobs: { a: {} } }]] as WorkflowSet;
      expect(() => archCaptureContract(set)).toThrow(/neither steps nor/);
    });
  });

  it('holds on every real workflow, over non-zero denominators', () => {
    const { files, captures, violations } =
      archCaptureContract(realWorkflows());
    // Zero files or zero captures would mean the scan read nothing; that is an
    // abstention, not a pass. Two captures today: harness.yml and
    // refresh-arch-baseline.yml.
    expect(files).toBeGreaterThan(0);
    expect(captures).toBeGreaterThanOrEqual(2);
    expect(violations).toEqual([]);
  });
});
