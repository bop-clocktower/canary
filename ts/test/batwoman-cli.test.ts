/**
 * `canary batwoman --issue N [--json]` (spec Phase 4).
 *
 * The command is the first surface a human meets, so the assertions here are
 * about what a reader is told rather than about internals. Two rules bind
 * hardest at this layer:
 *
 * **Criterion 2 reaches the JSON.** `--json` is the CI wrapper's input, and a
 * machine shape is exactly where a convenient `passed: true` would get added
 * later. There is none, and the summary counts every status.
 *
 * **Criterion 3 reaches the JSON.** The two non-answers stay countable in the
 * machine output too. A consumer that wants a subtotal has to add them up in
 * the open.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildBatwomanCommand } from '../src/batwoman-cli.js';
import { defaultMainDeps, type MainDeps } from '../src/main-deps.js';
import type { Closure } from '../src/analysis/batwoman/closure.js';
import type {
  RunHistory,
  RunHistoryPort,
} from '../src/analysis/batwoman/verdict.js';
import { FIXTURE_REGISTRY } from './batwoman-testkit.js';

const MERGED_AT = new Date('2026-08-23T18:34:04Z');

/** #749's real closure, as the adapter would return it. */
const CLOSURE: Closure = {
  header: {
    issue: 749,
    mergeSha: '1e0c05b20aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    mergeSubject:
      'fix(ci): make the refresh-baseline label refresh the baseline',
    mergedAt: MERGED_AT,
  },
  pullRequest: 751,
  files: [
    '.github/workflows/refresh-arch-baseline.yml',
    'AGENTS.md',
    'CHANGELOG.md',
    'harness.config.json',
    'scripts/refresh-arch-baseline.mjs',
    'ts/test/refresh-arch-baseline.test.ts',
    'ts/test/workflow-false-green.test.ts',
  ],
  deleted: new Set<string>(),
};

/** Dormant: one run, well before the merge. #749's actual situation. */
const DORMANT: RunHistoryPort = {
  runsForWorkflow: (): Promise<RunHistory> =>
    Promise.resolve({
      runs: [
        { createdAt: new Date('2026-08-10T09:00:00Z'), conclusion: 'success' },
      ],
      complete: true,
    }),
};

/**
 * A real repo root holding #749's workflow, so the trigger clause has a file
 * to read. Without one the probe correctly degrades to the bare run-history
 * sentence -- which is right, but is not what this suite is checking.
 */
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'batwoman-cli-'));
  mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
  writeFileSync(
    join(root, '.github/workflows/refresh-arch-baseline.yml'),
    'name: R\non:\n  pull_request:\n    types: [labeled]\n',
  );
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

interface Captured {
  out: string;
  err: string;
  code: number | undefined;
}

async function run(
  argv: string[],
  overrides: Partial<Parameters<typeof buildBatwomanCommand>[1]> = {},
): Promise<Captured> {
  let out = '';
  let err = '';
  const deps: MainDeps = {
    ...defaultMainDeps(),
    out: (s) => {
      out += `${s}\n`;
    },
    err: (s) => {
      err += `${s}\n`;
    },
  };
  const command = buildBatwomanCommand(deps, {
    resolveClosure: () => Promise.resolve(CLOSURE),
    runHistory: () => DORMANT,
    repo: () => 'bop-clocktower/canary',
    root: () => root,
    registry: FIXTURE_REGISTRY,
    ...overrides,
  });
  let code: number | undefined;
  try {
    await command.parseAsync(['node', 'batwoman', ...argv]);
  } catch (e) {
    code = (e as { exitCode?: number }).exitCode ?? 1;
  }
  return { out, err, code };
}

describe('canary batwoman', () => {
  it('requires an issue number rather than guessing one', async () => {
    const { code } = await run([]);
    expect(code).toBeDefined();
  });

  it('renders the closure header and every changed file', async () => {
    const { out } = await run(['--issue', '749']);

    expect(out).toContain('749');
    expect(out).toContain('1e0c05b');
    expect(out).toContain('refresh-baseline label');
    // All seven changed files are accounted for, not just the interesting two.
    for (const file of CLOSURE.files) {
      expect(out).toContain(file);
    }
  });

  it('reports the dormant workflow with its cause', async () => {
    const { out } = await run(['--issue', '749']);

    expect(out).toContain('refresh-arch-baseline.yml');
    expect(out).toMatch(/2026-08-10/);
    expect(out).toMatch(/label is added to a pull request/i);
  });

  it('prints no success token on any path', async () => {
    const { out } = await run(['--issue', '749']);
    expect(out).not.toMatch(/[✓✅]|\bOK\b|\ball clear\b/i);
  });

  describe('--json', () => {
    it('emits parseable JSON carrying every changed file', async () => {
      const { out } = await run(['--issue', '749', '--json']);

      const parsed = JSON.parse(out) as {
        issue: number;
        files: Array<{ file: string; status: string; explanation: string }>;
      };
      expect(parsed.issue).toBe(749);
      expect(parsed.files).toHaveLength(CLOSURE.files.length);
      for (const row of parsed.files) {
        expect(row.explanation.trim()).not.toBe('');
      }
    });

    it('counts all five statuses and sums them to the changed total', async () => {
      const { out } = await run(['--issue', '749', '--json']);
      const parsed = JSON.parse(out) as {
        summary: { changed: number; byStatus: Record<string, number> };
      };

      const sum = Object.values(parsed.summary.byStatus).reduce(
        (a, b) => a + b,
        0,
      );
      expect(sum).toBe(parsed.summary.changed);
      expect(parsed.summary.changed).toBe(CLOSURE.files.length);
      // The two non-answers are named in the machine shape too, not folded
      // away into something that looks like coverage (criterion 3).
      expect(parsed.summary.byStatus).toHaveProperty('abstain');
      expect(parsed.summary.byStatus).toHaveProperty('no-probe');
    });

    it('exposes no aggregate a consumer could mistake for a pass', async () => {
      const { out } = await run(['--issue', '749', '--json']);
      const parsed = JSON.parse(out) as { summary: Record<string, unknown> };

      expect(Object.keys(parsed.summary).sort()).toEqual([
        'byStatus',
        'changed',
      ]);
      for (const forbidden of ['passed', 'ok', 'clean', 'assessed', 'score']) {
        expect(parsed.summary[forbidden]).toBeUndefined();
      }
    });

    it('is persona-independent', async () => {
      // The machine shape must not shift with whoever happens to be running,
      // or a CI consumer's parser would depend on a detected persona.
      const { out } = await run(['--issue', '749', '--json']);
      const parsed = JSON.parse(out) as Record<string, unknown>;
      expect(parsed['persona']).toBeUndefined();
    });
  });

  describe('failure', () => {
    it('reports a closure it cannot resolve, and exits non-zero', async () => {
      const { err, out, code } = await run(['--issue', '999'], {
        resolveClosure: () =>
          Promise.reject(new Error('issue 999 has no closing pull request')),
      });

      expect(code).toBeDefined();
      expect(err).toMatch(/no closing pull request/i);
      // It must not print a report it could not produce.
      expect(out.trim()).toBe('');
    });

    it('still reports when the run history is unreadable, as abstentions', async () => {
      // A broken `gh` must not take the whole command down: the closure
      // resolved, the files are known, and "could not tell" is a real report.
      const { out, code } = await run(['--issue', '749'], {
        runHistory: () => ({
          runsForWorkflow: () =>
            Promise.reject(new Error('gh: not authenticated')),
        }),
      });

      expect(code).toBeUndefined();
      expect(out).toMatch(/could not decide|not authenticated/i);
    });
  });
});
