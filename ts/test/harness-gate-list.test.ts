/**
 * The harness gate list is bound to what CI actually runs, and a gate that
 * cannot run is not on it (#1155).
 *
 * `harness check-phase-gate` prints "Phase gates not enabled, skipping." and
 * exits 0 on this repo: there is no phase-gate configuration for it to read,
 * so it checks zero items. It still sat in two places a reader takes as the
 * gate list — a step in `harness-quality.yml` and the `phase-gate` entry
 * inside `harness ci check` (which reported `pass`) — and in the AGENTS.md
 * table of consumed subcommands. A green over zero items reads exactly like a
 * green over a clean tree, which is the false green this repo keeps closing.
 *
 * Two properties, so the gap cannot reopen from either side:
 *
 * 1. A gate known to abstain is neither invoked directly nor left inside a
 *    `harness ci check` run (which must `--skip` it).
 * 2. Every row of the AGENTS.md "Harness dependency surface" table names a
 *    subcommand that an executable line of each named workflow actually runs.
 *    A listed gate that nothing runs fails here instead of reading as covered.
 *
 * Re-enabling a gate is a deliberate change to `ABSTAINING_GATES` plus real
 * configuration, never a silent re-listing.
 *
 * Offline: parses workflow YAML and AGENTS.md. Never runs `harness`.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as loadYaml } from 'js-yaml';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORKFLOW_DIR = join(REPO_ROOT, '.github', 'workflows');

interface Workflow {
  jobs?: Record<string, { steps?: Array<{ run?: string }> }>;
}

/**
 * Harness gates that report a pass while checking nothing on this repo.
 * `subcommand` is the direct CLI form; `ciCheck` is its name inside
 * `harness ci check`.
 */
const ABSTAINING_GATES = [
  {
    subcommand: 'check-phase-gate',
    ciCheck: 'phase-gate',
    reason:
      'no phase-gate configuration exists, so it prints "Phase gates not ' +
      'enabled, skipping." and exits 0 having checked zero items',
  },
] as const;

/** Executable lines of every workflow, as `[workflow, line]`. */
function executableLines(): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const file of readdirSync(WORKFLOW_DIR).filter((f) =>
    /\.ya?ml$/.test(f),
  )) {
    const wf = loadYaml(
      readFileSync(join(WORKFLOW_DIR, file), 'utf-8'),
    ) as Workflow;
    for (const job of Object.values(wf.jobs ?? {})) {
      for (const step of job.steps ?? []) {
        if (typeof step.run !== 'string') continue;
        for (const line of step.run
          .replace(/\\\r?\n\s*/g, ' ')
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l && !l.startsWith('#'))) {
          out.push([file, line]);
        }
      }
    }
  }
  return out;
}

/** Rows of the AGENTS.md "Harness dependency surface" table. */
function surfaceTable(): Array<{ subcommand: string; workflows: string[] }> {
  const agents = readFileSync(join(REPO_ROOT, 'AGENTS.md'), 'utf-8');
  const start = agents.indexOf('### Harness dependency surface');
  const section = agents.slice(start, agents.indexOf('\n### ', start + 1));
  return section
    .split('\n')
    .filter((l) => /^\|\s*`/.test(l))
    .map((l) => {
      const [, cmd, used] = l.split('|');
      return {
        subcommand: cmd!.trim().replace(/`/g, ''),
        workflows: [...used!.matchAll(/`([^`]+\.ya?ml)`/g)].map((m) => m[1]!),
      };
    });
}

const LINES = executableLines();
const HARNESS_LINES = LINES.filter(([, l]) => /\bharness\s+\S/.test(l));
const CI_CHECK_LINES = HARNESS_LINES.filter(([, l]) =>
  /\bharness ci check\b/.test(l),
);

describe('harness gate list matches what CI runs (#1155)', () => {
  it('finds harness invocations to check (zero is an abstention)', () => {
    expect(HARNESS_LINES.length).toBeGreaterThan(0);
    expect(CI_CHECK_LINES.length).toBeGreaterThan(0);
  });

  describe.each(ABSTAINING_GATES)(
    'abstaining gate $subcommand',
    ({ subcommand, ciCheck, reason }) => {
      it('is not invoked directly by any workflow', () => {
        const hits = HARNESS_LINES.filter(([, l]) =>
          new RegExp(`\\bharness ${subcommand}\\b`).test(l),
        );
        expect(hits, `${subcommand} cannot run here: ${reason}`).toEqual([]);
      });

      it('is skipped by every `harness ci check` run', () => {
        const unskipped = CI_CHECK_LINES.filter(([, l]) => {
          const skip = /--skip[=\s]+(\S+)/.exec(l)?.[1] ?? '';
          return !skip.replace(/['"]/g, '').split(',').includes(ciCheck);
        });
        expect(
          unskipped,
          `\`ci check\` would report ${ciCheck} as pass: ${reason}`,
        ).toEqual([]);
      });

      it('is not listed in the AGENTS.md dependency surface', () => {
        expect(surfaceTable().map((r) => r.subcommand)).not.toContain(
          subcommand,
        );
      });
    },
  );

  describe('every AGENTS.md dependency-surface row is really run', () => {
    const rows = surfaceTable();

    it('parses the table (zero rows is an abstention)', () => {
      expect(rows.length).toBeGreaterThan(5);
    });

    it.each(
      rows.flatMap((r) => r.workflows.map((w) => [r.subcommand, w] as const)),
    )('harness %s runs in %s', (subcommand, workflow) => {
      const hits = HARNESS_LINES.filter(
        ([f, l]) =>
          f === workflow && new RegExp(`\\bharness ${subcommand}\\b`).test(l),
      );
      expect(
        hits,
        `AGENTS.md lists ${subcommand} as used by ${workflow}, but no ` +
          'executable line there runs it',
      ).not.toEqual([]);
    });
  });
});
