/**
 * #1208 — the `|| true` on the check-arch capture is only safe while the
 * summariser downstream of it still gates.
 *
 * `harness.yml` runs `harness check-arch --json > arch-report.json || true`.
 * Read alone, that line swallows a red gate: on main the command exits 1 on the
 * ABSOLUTE count (12 pre-existing complexity violations, 0 new, on d4b5681f
 * with harness 12.10.1). The swallow is deliberate — the absolute exit is the
 * verdict the summariser exists to reinterpret — and it is safe only because a
 * later step in the same job reads that file and fails the job itself:
 * `newViolations` non-empty → exit 1 (#968); a missing, empty or field-less
 * report → exit 3, an abstention.
 *
 * Every piece of that is a separate line of YAML, and removing any one of them
 * turns the `|| true` back into the masking it looks like, with every
 * exit-code test in arch-verdict.test.ts still green (they run the script, not
 * the workflow). So this file binds the PAIRING, per capture step:
 *
 *   1. A later step in the SAME job runs `harness-report-summary.mjs` with
 *      `--arch <the file the capture wrote>`.
 *   2. That step can fail the job: no `|| true` / `|| :` / `|| exit 0`, no
 *      `continue-on-error: true`.
 *   3. It survives a failed earlier step: its `if:` contains `!cancelled()` or
 *      `always()`. `harness ci check` exits 1 on a metric regression, and a
 *      summariser with the default `success()` condition would then be SKIPPED
 *      — the one run where the new-violation gate matters most.
 *   4. The job's `harness ci check` does not `--skip arch`. The summariser only
 *      consults the arch detail when the CI report carries an `arch` entry;
 *      with that entry absent it exits 0 even over a planted new violation.
 *
 * The script's own exit-code rows are pinned in arch-verdict.test.ts
 * (`#968 — the summariser blocks new arch violations`, `abstains on the empty
 * file a crashed check-arch leaves behind`, `abstains, after rendering the
 * summary, on an unreadable arch report`). This file does not duplicate them.
 *
 * Offline: parses workflow YAML. Never runs `harness`.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as loadYaml } from 'js-yaml';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HARNESS_YML = join(REPO_ROOT, '.github', 'workflows', 'harness.yml');

interface Step {
  name?: string;
  run?: string;
  if?: string;
  'continue-on-error'?: boolean;
}
interface Workflow {
  jobs?: Record<string, { steps?: Step[] }>;
}

/** Continuation lines joined, blanks and comments dropped. */
function logicalLines(script: string): string[] {
  return script
    .replace(/\\\r?\n\s*/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

const SWALLOW = /\|\|\s*(true|:|exit 0)\b/;

function isSoft(step: Step): boolean {
  return (
    step['continue-on-error'] === true ||
    logicalLines(step.run ?? '').some((l) => SWALLOW.test(l))
  );
}

/** A check-arch capture whose own failure cannot fail the job. */
function softArchCapture(step: Step): string | undefined {
  const line = logicalLines(step.run ?? '').find((l) =>
    /\bharness check-arch\b/.test(l),
  );
  if (!line || !isSoft(step)) return undefined;
  return /(?<![0-9=])>\s*(\S+)/.exec(line)?.[1] ?? '';
}

/**
 * Every way a soft check-arch capture in `wf` is left unguarded, as
 * human-readable reasons. Empty means every capture is paired with a gating
 * summariser. `captures` is the denominator, so a caller can refuse to read
 * zero captures as a pass.
 */
function archCaptureContract(wf: Workflow): {
  captures: number;
  violations: string[];
} {
  const violations: string[] = [];
  let captures = 0;
  for (const [jobId, job] of Object.entries(wf.jobs ?? {})) {
    const steps = job.steps ?? [];
    steps.forEach((step, index) => {
      const target = softArchCapture(step);
      if (target === undefined) return;
      captures++;
      const where = `${jobId} › ${step.name ?? `step ${index}`}`;
      if (!target) {
        violations.push(
          `${where}: swallows check-arch without writing a report file`,
        );
        return;
      }
      const summariser = steps
        .slice(index + 1)
        .find((s) =>
          logicalLines(s.run ?? '').some(
            (l) =>
              l.includes('harness-report-summary.mjs') &&
              new RegExp(
                `--arch\\s+${target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`,
              ).test(l),
          ),
        );
      if (!summariser) {
        violations.push(
          `${where}: no later step in job ${jobId} runs harness-report-summary.mjs --arch ${target}`,
        );
        return;
      }
      if (isSoft(summariser)) {
        violations.push(
          `${where}: the summariser that reads ${target} cannot fail the job`,
        );
      }
      if (!/!cancelled\(\)|always\(\)/.test(summariser.if ?? '')) {
        violations.push(
          `${where}: the summariser has no !cancelled()/always() condition, so a failed ci check skips it`,
        );
      }
      const skipsArch = steps.some((s) =>
        logicalLines(s.run ?? '').some(
          (l) =>
            /\bharness ci check\b/.test(l) &&
            /--skip(\s+|=)\S*\barch\b/.test(l),
        ),
      );
      if (skipsArch) {
        violations.push(
          `${where}: harness ci check skips arch, so the summariser never consults ${target}`,
        );
      }
    });
  }
  return { captures, violations };
}

function realWorkflow(): Workflow {
  return loadYaml(readFileSync(HARNESS_YML, 'utf-8')) as Workflow;
}

/** A deep copy of harness.yml with `mutate` applied to its summariser step. */
function mutated(
  mutate: (summariser: Step, steps: Step[], wf: Workflow) => void,
): Workflow {
  const wf = structuredClone(realWorkflow());
  const steps = wf.jobs!.harness!.steps!;
  const summariser = steps.find((s) =>
    s.run?.includes('harness-report-summary.mjs'),
  )!;
  mutate(summariser, steps, wf);
  return wf;
}

describe('#1208 — the check-arch capture is paired with a gating summariser', () => {
  describe('the predicate catches every way the pairing breaks', () => {
    // Planted positives: each fixture is the real harness.yml with one line of
    // the contract broken. Without them, a predicate that never fires would
    // pass the real-workflow assertion below for the wrong reason.
    const cases: Array<
      [string, (s: Step, steps: Step[], wf: Workflow) => void, RegExp]
    > = [
      [
        'the summariser step is removed',
        (s, steps) => steps.splice(steps.indexOf(s), 1),
        /no later step/,
      ],
      [
        'the summariser is continue-on-error',
        (s) => {
          s['continue-on-error'] = true;
        },
        /cannot fail the job/,
      ],
      [
        'the summariser swallows its own exit',
        (s) => {
          s.run = `${s.run!.trimEnd()} || true\n`;
        },
        /cannot fail the job/,
      ],
      [
        'the summariser loses its !cancelled() condition',
        (s) => {
          delete s.if;
        },
        /!cancelled\(\)/,
      ],
      [
        'the summariser reads a different file',
        (s) => {
          s.run = s.run!.replace(
            '--arch arch-report.json',
            '--arch other.json',
          );
        },
        /no later step/,
      ],
      [
        'the summariser step is moved ahead of the capture step',
        (s, steps) => {
          steps.splice(steps.indexOf(s), 1);
          const capture = steps.findIndex((x) => x.run?.includes('check-arch'));
          steps.splice(capture, 0, s);
        },
        /no later step/,
      ],
      [
        'the summariser moves to another job',
        (s, steps, wf) => {
          steps.splice(steps.indexOf(s), 1);
          wf.jobs!.other = { steps: [s] };
        },
        /no later step/,
      ],
      [
        'harness ci check skips arch',
        (_s, steps) => {
          const ci = steps.find((x) => x.run?.includes('harness ci check'))!;
          ci.run = ci.run!.replace(
            '--skip phase-gate',
            '--skip phase-gate,arch',
          );
        },
        /skips arch/,
      ],
    ];

    for (const [label, mutate, reason] of cases) {
      it(`flags it when ${label}`, () => {
        const { captures, violations } = archCaptureContract(mutated(mutate));
        expect(captures).toBe(1);
        expect(violations.join('\n')).toMatch(reason);
      });
    }

    it('does not count a hard (non-swallowed) check-arch as a capture', () => {
      const wf: Workflow = {
        jobs: { a: { steps: [{ run: 'harness check-arch --json > r.json' }] } },
      };
      expect(archCaptureContract(wf)).toEqual({ captures: 0, violations: [] });
    });

    it('flags a swallowed check-arch that writes no file', () => {
      const wf: Workflow = {
        jobs: {
          a: { steps: [{ name: 'x', run: 'harness check-arch || true' }] },
        },
      };
      expect(archCaptureContract(wf).violations.join('\n')).toMatch(
        /without writing a report file/,
      );
    });
  });

  it('holds on the real harness.yml, over a non-zero denominator', () => {
    const { captures, violations } = archCaptureContract(realWorkflow());
    // Zero captures would mean the swallow moved or was renamed out of reach;
    // that is an abstention, not a pass.
    expect(captures).toBeGreaterThan(0);
    expect(violations).toEqual([]);
  });
});
