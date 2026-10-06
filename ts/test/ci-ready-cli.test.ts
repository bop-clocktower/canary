/**
 * `canary ci-ready` — the deterministic half of the canary-ci-ready skill.
 *
 * The skill defines five checks. Flakiness and suite runtime (p95 of recorded
 * run durations, since #956) read the run-history store; coverage-depth,
 * assertion-quality and critical-paths read the inventory that
 * `canary inventory` writes (#957). A check without its input -- including
 * suite runtime when no stored run carries a duration -- reports `skip` with
 * the missing input named. It must never pass.
 *
 * The verdict contract these tests pin:
 *   - abstained  (exit 3): every check skipped. "Checked nothing" is not ready.
 *   - not-ready  (exit 1): any check failed.
 *   - incomplete (exit 0): nothing failed, but at least one check skipped.
 *   - ready      (exit 0): all five checks passed.
 */
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EXIT_ABSTAINED } from '../src/core/gate-result.js';
import { NdjsonHistoryStore } from '../src/history/ndjson-store.js';
import { invokeCanary, mkTmp, rmTmp } from './canary-cli-testkit.js';

interface Measure {
  value: number;
  unit: 'ratio' | 'count' | 'ms';
  denominator: number;
}
interface Check {
  name: string;
  verdict: 'pass' | 'warn' | 'fail' | 'skip';
  reason: string;
  measure: Measure | null;
}
interface Report {
  verdict: 'ready' | 'incomplete' | 'not-ready' | 'abstained';
  checked: number;
  checks: Check[];
}

const HISTORY = join('test-results', 'reports', 'history-v2.jsonl');

/**
 * One stored run per entry; `flakyIn` lists the run indexes where `t1` flaked,
 * and `durations[i]` (when defined) is run i's `duration_ms`. A run with no
 * entry is written without the field, like a legacy record.
 */
function writeHistory(
  root: string,
  runs: number,
  flakyIn: number[] = [],
  durations: (number | undefined)[] = [],
): void {
  mkdirSync(join(root, 'test-results', 'reports'), { recursive: true });
  const lines: string[] = [];
  for (let i = 0; i < runs; i++) {
    const flaky = flakyIn.includes(i);
    lines.push(
      JSON.stringify({
        run_id: `api-${i}`,
        suite: 'api',
        branch: 'main',
        commit_sha: `abc1234${i}`,
        timestamp: `2026-06-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
        total: 1,
        passed: flaky ? 0 : 1,
        failed: 0,
        flaky: flaky ? 1 : 0,
        skipped: 0,
        ...(durations[i] === undefined ? {} : { duration_ms: durations[i] }),
        schema_version: 2,
        tests: [
          {
            test_name: 't1',
            test_file: 'tests/t1.spec.ts',
            status: flaky ? 'flaky' : 'passed',
          },
        ],
      }),
    );
  }
  writeFileSync(join(root, HISTORY), lines.join('\n') + '\n', 'utf-8');
}

function check(report: Report, name: string): Check {
  const c = report.checks.find((x) => x.name === name);
  if (!c) throw new Error(`no check named ${name}`);
  return c;
}

async function runJson(
  root: string,
): Promise<{ code: number; report: Report }> {
  const res = await invokeCanary(['ci-ready', '--root', root, '--json']);
  return { code: res.code, report: JSON.parse(res.stdout) as Report };
}

describe('canary ci-ready', () => {
  let root: string;
  beforeEach(() => {
    root = mkTmp();
  });
  afterEach(() => {
    rmTmp(root);
  });

  it('abstains with exit 3 when no input exists, and never claims readiness', async () => {
    const { code, report } = await runJson(root);
    expect(code).toBe(EXIT_ABSTAINED);
    expect(report.verdict).toBe('abstained');
    expect(report.checked).toBe(0);
    expect(report.checks.map((c) => c.name)).toEqual([
      'coverage-depth',
      'flakiness',
      'assertion-quality',
      'critical-paths',
      'suite-runtime',
    ]);
    expect(report.checks.every((c) => c.verdict === 'skip')).toBe(true);
    // A skipped check measured nothing: null, never 0 (#1151 phase 2, P1).
    expect(report.checks.map((c) => c.measure)).toEqual([
      null,
      null,
      null,
      null,
      null,
    ]);

    const text = await invokeCanary(['ci-ready', '--root', root]);
    expect(text.code).toBe(EXIT_ABSTAINED);
    expect(text.stdout).not.toMatch(/\bready\b(?!ness)/i);
  });

  // #604 G2: a 5-run window is too thin to pass. `0 flaky across 5 run(s)` was
  // a false green -- zero out of five is an abstention. The minimum is 10 runs
  // (Decision D5/H2), and below it the check WARNS so it stays visible.
  it('warns, not passes, flakiness on a clean but thin window', async () => {
    writeHistory(root, 5);
    const { code, report } = await runJson(root);
    const f = check(report, 'flakiness');
    expect(f.verdict).toBe('warn');
    expect(f.reason).toContain('insufficient history: 5 of 10 runs');
    expect(report.checked).toBe(1);
    expect(report.verdict).toBe('incomplete');
    expect(code).toBe(0);
  });

  it('passes flakiness on clean history but reports incomplete, not ready', async () => {
    writeHistory(root, 10);
    const { code, report } = await runJson(root);
    expect(check(report, 'flakiness').verdict).toBe('pass');
    expect(report.checked).toBe(1);
    expect(report.verdict).toBe('incomplete');
    expect(code).toBe(0);
  });

  it('fails flakiness when a test flakes at or above 10% of the window', async () => {
    writeHistory(root, 5, [2]); // 1 of 5 runs = 20%
    const { code, report } = await runJson(root);
    expect(check(report, 'flakiness').verdict).toBe('fail');
    expect(report.verdict).toBe('not-ready');
    expect(code).toBe(1);
  });

  it('warns on flakiness below 10% of the window', async () => {
    writeHistory(root, 20, [7]); // 1 of 20 runs = 5%
    const { code, report } = await runJson(root);
    expect(check(report, 'flakiness').verdict).toBe('warn');
    expect(report.verdict).toBe('incomplete');
    expect(code).toBe(0);
  });

  it('skips flakiness, naming the store, when the history file holds no runs', async () => {
    mkdirSync(join(root, 'test-results', 'reports'), { recursive: true });
    writeFileSync(join(root, HISTORY), '', 'utf-8');
    const { report } = await runJson(root);
    const f = check(report, 'flakiness');
    expect(f.verdict).toBe('skip');
    expect(f.reason).toMatch(/history-v2\.jsonl/);
  });

  describe('suite runtime (p95 of recorded run durations, #956)', () => {
    const MIN = 60_000;

    it('skips, naming the store, when no stored run carries a duration', async () => {
      writeHistory(root, 5);
      const { report } = await runJson(root);
      const r = check(report, 'suite-runtime');
      expect(r.verdict).toBe('skip');
      expect(r.reason).toMatch(/duration/i);
      expect(r.reason).toMatch(/history-v2\.jsonl/);
    });

    it('passes when the p95 is under 5 minutes, and says what it measured', async () => {
      // One legacy run (no field) and one zero duration are not counted.
      writeHistory(root, 6, [], [undefined, 0, MIN, MIN, 2 * MIN, 90_000]);
      const { report } = await runJson(root);
      const r = check(report, 'suite-runtime');
      expect(r.verdict).toBe('pass');
      expect(r.reason).toMatch(/p95/);
      expect(r.reason).toMatch(/2m 0s/);
      expect(r.reason).toMatch(/4 run\(s\)/);
      expect(r.reason).toMatch(/vs\. absolute threshold/);
      expect(report.checked).toBe(2);
    });

    it('warns when the p95 is between 5 and 10 minutes', async () => {
      // Nearest-rank p95 of 20 runs is the 19th smallest: a 400s run.
      const durations = [...Array(18).fill(MIN), 400_000, 400_000];
      writeHistory(root, 20, [], durations);
      const { report } = await runJson(root);
      expect(check(report, 'suite-runtime').verdict).toBe('warn');
    });

    it('fails when the p95 is over 10 minutes', async () => {
      writeHistory(root, 5, [], Array(5).fill(11 * MIN));
      const { code, report } = await runJson(root);
      expect(check(report, 'suite-runtime').verdict).toBe('fail');
      expect(report.verdict).toBe('not-ready');
      expect(code).toBe(1);
    });

    it('warns at exactly 5 and 10 minutes, and fails 1ms past 10', async () => {
      for (const [ms, verdict] of [
        [5 * MIN, 'warn'],
        [10 * MIN, 'warn'],
        [10 * MIN + 1, 'fail'],
      ] as const) {
        writeHistory(root, 3, [], Array(3).fill(ms));
        const { report } = await runJson(root);
        expect(check(report, 'suite-runtime').verdict).toBe(verdict);
      }
    });

    it('scores only the last 30 runs that carry a duration', async () => {
      const durations = [...Array(10).fill(20 * MIN), ...Array(30).fill(MIN)];
      writeHistory(root, 40, [], durations);
      const { report } = await runJson(root);
      const r = check(report, 'suite-runtime');
      expect(r.verdict).toBe('pass');
      expect(r.reason).toMatch(/30 run\(s\)/);
    });
  });

  it('skips the inventory checks and names test-inventory.json as the missing input', async () => {
    mkdirSync(join(root, '.canary'), { recursive: true });
    writeFileSync(
      join(root, '.canary', 'critical-areas.json'),
      JSON.stringify({
        generated: '2026-09-14T00:00:00Z',
        areas: [{ path: 'src/a.ts', risk_score: 0.9, signals: [] }],
      }),
      'utf-8',
    );
    const { report } = await runJson(root);
    for (const name of [
      'coverage-depth',
      'assertion-quality',
      'critical-paths',
    ]) {
      const c = check(report, name);
      expect(c.verdict).toBe('skip');
      expect(c.reason).toMatch(/test-inventory\.json/);
      expect(c.reason).toMatch(/canary inventory/);
    }
  });

  it('scores the three inventory checks once `canary inventory` has run', async () => {
    mkdirSync(join(root, 'tests'), { recursive: true });
    writeFileSync(
      join(root, 'tests', 'cart.test.ts'),
      "import { add } from '../src/cart.js';\nit('adds', () => {\n  expect(add(1)).toBe(1);\n});\n",
      'utf-8',
    );
    mkdirSync(join(root, '.canary'), { recursive: true });
    writeFileSync(
      join(root, '.canary', 'critical-areas.json'),
      JSON.stringify({ areas: [{ path: 'src/cart.ts', risk_score: 0.9 }] }),
      'utf-8',
    );
    expect((await invokeCanary(['inventory', '--root', root])).code).toBe(0);

    const { code, report } = await runJson(root);
    for (const name of [
      'coverage-depth',
      'assertion-quality',
      'critical-paths',
    ]) {
      expect(check(report, name).verdict).toBe('pass');
    }
    expect(report.checked).toBe(3);
    expect(report.verdict).toBe('incomplete');
    expect(code).toBe(0);
  });

  // #1129: an input that EXISTS but cannot be read (a directory planted at the
  // path, a 0-perm file) crashed the command with a raw EISDIR/EACCES stack.
  // It is an unusable input like a missing or unparseable one: reported with
  // its path and errno code, and the exit code follows the normal contract.
  describe('an unreadable .canary input (#1129)', () => {
    it('reports a directory at test-inventory.json as unusable, naming path and EISDIR', async () => {
      mkdirSync(join(root, '.canary', 'test-inventory.json'), {
        recursive: true,
      });
      const { code, report } = await runJson(root);
      for (const name of [
        'coverage-depth',
        'assertion-quality',
        'critical-paths',
      ]) {
        const c = check(report, name);
        expect(c.verdict).toBe('skip');
        expect(c.reason).toMatch(/\.canary\/test-inventory\.json/);
        expect(c.reason).toMatch(/EISDIR/);
      }
      expect(report.verdict).toBe('abstained');
      expect(code).toBe(EXIT_ABSTAINED);
    });

    it('reports a directory at critical-areas.json as unusable, naming path and EISDIR', async () => {
      mkdirSync(join(root, 'tests'), { recursive: true });
      writeFileSync(
        join(root, 'tests', 'cart.test.ts'),
        "import { add } from '../src/cart.js';\nit('adds', () => {\n  expect(add(1)).toBe(1);\n});\n",
        'utf-8',
      );
      expect((await invokeCanary(['inventory', '--root', root])).code).toBe(0);
      mkdirSync(join(root, '.canary', 'critical-areas.json'), {
        recursive: true,
      });

      const { code, report } = await runJson(root);
      const critical = check(report, 'critical-paths');
      expect(critical.verdict).toBe('skip');
      expect(critical.reason).toMatch(/\.canary\/critical-areas\.json/);
      expect(critical.reason).toMatch(/EISDIR/);
      // The inventory itself is readable, so its two checks still score.
      expect(check(report, 'coverage-depth').verdict).not.toBe('skip');
      expect(report.verdict).toBe('incomplete');
      expect(code).toBe(0);
    });

    it('renders text output instead of a stack trace', async () => {
      mkdirSync(join(root, '.canary', 'test-inventory.json'), {
        recursive: true,
      });
      mkdirSync(join(root, '.canary', 'critical-areas.json'), {
        recursive: true,
      });
      const res = await invokeCanary(['ci-ready', '--root', root]);
      expect(res.code).toBe(EXIT_ABSTAINED);
      expect(res.stdout).toMatch(/test-inventory\.json could not be read/);
      expect(res.stdout).not.toMatch(/at readFileSync/);
    });

    // chmod cannot revoke read access on Windows, and root reads anything.
    const canRevokeRead =
      process.platform !== 'win32' && process.getuid?.() !== 0;
    it.skipIf(!canRevokeRead)(
      'reports a 0-perm test-inventory.json as unusable, naming EACCES',
      async () => {
        mkdirSync(join(root, '.canary'), { recursive: true });
        const path = join(root, '.canary', 'test-inventory.json');
        writeFileSync(path, '{}', 'utf-8');
        chmodSync(path, 0o000);
        try {
          const { code, report } = await runJson(root);
          const c = check(report, 'coverage-depth');
          expect(c.verdict).toBe('skip');
          expect(c.reason).toMatch(/\.canary\/test-inventory\.json/);
          expect(c.reason).toMatch(/EACCES/);
          expect(code).toBe(EXIT_ABSTAINED);
        } finally {
          chmodSync(path, 0o644);
        }
      },
    );
  });

  // #1132: the run-history store had the same crash shape. A store that EXISTS
  // but cannot be read is a skip with a reason on both history checks -- never
  // a stack, and never "no runs recorded", which would read as absent.
  describe('an unreadable run-history store (#1132)', () => {
    const HISTORY_CHECKS = ['flakiness', 'suite-runtime'];

    it('skips flakiness and suite-runtime naming the store and EISDIR when it is a directory', async () => {
      mkdirSync(join(root, HISTORY), { recursive: true });
      const { code, report } = await runJson(root);
      for (const name of HISTORY_CHECKS) {
        const c = check(report, name);
        expect(c.verdict).toBe('skip');
        expect(c.reason).toBe(`${HISTORY} could not be read (EISDIR)`);
      }
      expect(report.verdict).toBe('abstained');
      expect(code).toBe(EXIT_ABSTAINED);
    });

    it('still scores a readable inventory beside the unreadable store', async () => {
      mkdirSync(join(root, 'tests'), { recursive: true });
      writeFileSync(
        join(root, 'tests', 'cart.test.ts'),
        "import { add } from '../src/cart.js';\nit('adds', () => {\n  expect(add(1)).toBe(1);\n});\n",
        'utf-8',
      );
      expect((await invokeCanary(['inventory', '--root', root])).code).toBe(0);
      mkdirSync(join(root, HISTORY), { recursive: true });

      const { code, report } = await runJson(root);
      expect(check(report, 'flakiness').reason).toMatch(/EISDIR/);
      expect(check(report, 'coverage-depth').verdict).not.toBe('skip');
      expect(report.verdict).toBe('incomplete');
      expect(code).toBe(0);
    });

    it('renders text output instead of a stack trace', async () => {
      mkdirSync(join(root, HISTORY), { recursive: true });
      const res = await invokeCanary(['ci-ready', '--root', root]);
      expect(res.code).toBe(EXIT_ABSTAINED);
      expect(res.stdout).toMatch(/history-v2\.jsonl could not be read/);
      expect(res.stdout).not.toMatch(/no runs recorded/);
      expect(res.stdout).not.toMatch(/at readFileSync/);
    });

    // chmod cannot revoke read access on Windows, and root reads anything.
    const canRevokeRead =
      process.platform !== 'win32' && process.getuid?.() !== 0;
    it.skipIf(!canRevokeRead)(
      'skips both history checks naming EACCES for a 0-perm store',
      async () => {
        writeHistory(root, 3, [], [1000, 1000, 1000]);
        const path = join(root, HISTORY);
        chmodSync(path, 0o000);
        try {
          const { code, report } = await runJson(root);
          for (const name of HISTORY_CHECKS) {
            const c = check(report, name);
            expect(c.verdict).toBe('skip');
            expect(c.reason).toBe(`${HISTORY} could not be read (EACCES)`);
          }
          expect(code).toBe(EXIT_ABSTAINED);
        } finally {
          chmodSync(path, 0o644);
        }
      },
    );
  });

  // #1156: a corrupt or unsupported-schema store is a skip with a reason, the
  // same contract #1132 set for an unreadable one -- never a raw stack, and
  // never the readable lines scored with the bad one dropped.
  describe('a corrupt or unsupported-schema run-history store (#1156)', () => {
    const HISTORY_CHECKS = ['flakiness', 'suite-runtime'];

    function corruptLine(line: string): void {
      // Three good runs first: none of them may be scored around the bad line.
      writeHistory(root, 3, [], [1000, 1000, 1000]);
      writeFileSync(join(root, HISTORY), `${line}\n`, { flag: 'a' });
    }

    it('skips both history checks naming the store and the line of invalid JSON', async () => {
      corruptLine('{broken');
      const { code, report } = await runJson(root);
      for (const name of HISTORY_CHECKS) {
        const c = check(report, name);
        expect(c.verdict).toBe('skip');
        expect(c.reason).toBe(
          `${HISTORY} could not be parsed (line 4: invalid JSON)`,
        );
      }
      expect(report.verdict).toBe('abstained');
      expect(code).toBe(EXIT_ABSTAINED);
    });

    it('skips both history checks naming an unsupported schema version', async () => {
      corruptLine(
        JSON.stringify({ run_id: 'x', suite: 'api', schema_version: 9 }),
      );
      const { code, report } = await runJson(root);
      for (const name of HISTORY_CHECKS) {
        expect(check(report, name).reason).toBe(
          `${HISTORY} has unsupported schema 9 (line 4; supported: 2, 3)`,
        );
      }
      expect(code).toBe(EXIT_ABSTAINED);
    });

    it('still scores a readable inventory beside the corrupt store', async () => {
      mkdirSync(join(root, 'tests'), { recursive: true });
      writeFileSync(
        join(root, 'tests', 'cart.test.ts'),
        "import { add } from '../src/cart.js';\nit('adds', () => {\n  expect(add(1)).toBe(1);\n});\n",
        'utf-8',
      );
      expect((await invokeCanary(['inventory', '--root', root])).code).toBe(0);
      corruptLine('null');

      const { code, report } = await runJson(root);
      expect(check(report, 'flakiness').reason).toBe(
        `${HISTORY} could not be parsed (line 4: not a JSON object)`,
      );
      expect(check(report, 'coverage-depth').verdict).not.toBe('skip');
      expect(report.verdict).toBe('incomplete');
      expect(code).toBe(0);
    });

    it('renders text output instead of a stack trace', async () => {
      corruptLine('{broken');
      const res = await invokeCanary(['ci-ready', '--root', root]);
      expect(res.code).toBe(EXIT_ABSTAINED);
      expect(res.stdout).toMatch(/history-v2\.jsonl could not be parsed/);
      expect(res.stdout).not.toMatch(
        /no runs recorded|SyntaxError|at JSON\.parse/,
      );
    });

    it('still surfaces an error that is not a content problem', async () => {
      corruptLine('{"run_id":"x","suite":"api"}');
      const spy = vi
        .spyOn(NdjsonHistoryStore.prototype, 'readAll')
        .mockImplementation(() => {
          throw new TypeError('a programming error');
        });
      try {
        await expect(
          invokeCanary(['ci-ready', '--root', root]),
        ).rejects.toThrow('a programming error');
      } finally {
        spy.mockRestore();
      }
    });
  });

  it('abstains on an inventory that lists zero tests rather than passing it', async () => {
    mkdirSync(join(root, '.canary'), { recursive: true });
    writeFileSync(
      join(root, '.canary', 'test-inventory.json'),
      JSON.stringify({
        schema_version: 1,
        generated: 'x',
        files: [],
        skipped: [],
      }),
      'utf-8',
    );
    const { code, report } = await runJson(root);
    expect(check(report, 'coverage-depth').reason).toMatch(/0 tests/);
    expect(report.verdict).toBe('abstained');
    expect(code).toBe(EXIT_ABSTAINED);
  });
});
