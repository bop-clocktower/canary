/**
 * #1748: three CLI gates that went green while checking nothing.
 *
 * - `review-test` / `flake-check` never collected pytest's `*_test.py`, so a
 *   directory whose only flaky test lived in `bad_test.py` printed a clean
 *   tick. A clean result now also states how many files it read, so a reader
 *   can see a collapsed denominator without re-running.
 * - `review-test --json` printed a bare `[]` for both a clean run and a run
 *   that read nothing; only the exit code told them apart. It now emits
 *   `{files, checked, findings}`, the shape `vacuity-check` already uses.
 * - `ticket-update` moved a ticket to `qa_passed` on a 0-of-0 run: a report
 *   of `{"result":"PASS"}` alone defaulted `total` to 0 and still
 *   transitioned. A run with zero tests now abstains (exit 3) before the
 *   updater is reached, so nothing is posted and nothing moves.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TransitionResult, UpdateResult } from '../src/core/ticket-updater.js';
import { invokeCanary, mkTmp, rmTmp } from './canary-cli-testkit.js';

const EXIT_ABSTAINED = 3;

let base: string;
beforeEach(() => {
  base = mkTmp();
});
afterEach(() => {
  rmTmp(base);
});

/** The issue's reproduction: one clean `test_*.py`, one flaky `*_test.py`. */
function pyDir(): string {
  const dir = join(base, 'py');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'test_good.py'),
    'def test_ok():\n    assert 1 + 1 == 2\n',
    'utf-8',
  );
  writeFileSync(
    join(dir, 'bad_test.py'),
    'import time\n\ndef test_bad():\n    time.sleep(5)\n',
    'utf-8',
  );
  return dir;
}

function cleanDir(): string {
  const dir = join(base, 'clean');
  mkdirSync(dir, { recursive: true });
  for (const name of ['test_a.py', 'b_test.py']) {
    writeFileSync(
      join(dir, name),
      'def test_ok():\n    assert 1 + 1 == 2\n',
      'utf-8',
    );
  }
  return dir;
}

describe('*_test.py is scanned, not silently skipped', () => {
  it('review-test finds the flaky sleep in bad_test.py', async () => {
    const res = await invokeCanary(['review-test', pyDir()]);
    expect(res.stdout).not.toContain('No issues found');
    expect(res.stdout).toContain('bad_test.py');
    expect(res.stdout).toContain('FLAKE-001');
    expect(res.code).toBe(1);
  });

  it('flake-check finds it too', async () => {
    const res = await invokeCanary(['flake-check', pyDir()]);
    expect(res.stdout).not.toContain('No flakiness patterns detected');
    expect(res.stdout).toContain('bad_test.py');
    expect(res.code).toBe(1);
  });
});

describe('a clean result states its denominator', () => {
  it('review-test', async () => {
    const res = await invokeCanary(['review-test', cleanDir()]);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('No issues found (2 file(s) checked).');
  });

  it('flake-check', async () => {
    const res = await invokeCanary(['flake-check', cleanDir()]);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain(
      'No flakiness patterns detected (2 file(s) checked).',
    );
  });
});

describe('review-test --json carries {files, checked, findings}', () => {
  it('a clean run says how much it read', async () => {
    const res = await invokeCanary(['review-test', cleanDir(), '--json']);
    expect(res.code).toBe(0);
    expect(JSON.parse(res.stdout)).toEqual({
      files: 2,
      checked: 2,
      findings: [],
    });
  });

  it('a findings run keeps the findings under `findings`', async () => {
    const res = await invokeCanary(['review-test', pyDir(), '--json']);
    expect(res.code).toBe(1);
    const out = JSON.parse(res.stdout) as {
      files: number;
      checked: number;
      findings: { file: string; rule: string }[];
    };
    expect(out.files).toBe(2);
    expect(out.checked).toBe(2);
    expect(out.findings.some((f) => f.rule === 'FLAKE-001')).toBe(true);
  });

  it('a run that matched nothing is distinguishable from a clean one', async () => {
    const empty = join(base, 'empty');
    mkdirSync(empty, { recursive: true });
    writeFileSync(join(empty, 'README.md'), '# none\n', 'utf-8');
    const res = await invokeCanary(['review-test', empty, '--json']);
    expect(res.code).toBe(EXIT_ABSTAINED);
    expect(JSON.parse(res.stdout)).toEqual({
      files: 0,
      checked: 0,
      findings: [],
    });
  });
});

describe('ticket-update abstains on a run with zero tests', () => {
  function updaterSpy() {
    const calls: unknown[] = [];
    return {
      calls,
      makeTicketUpdater: () =>
        ({
          update: async (summary: unknown) => {
            calls.push(summary);
            return new UpdateResult({
              ticket_key: 'PROJ-1',
              project_key: 'PROJ',
              linkage_source: 'override',
              comment_posted: false,
              transition: new TransitionResult(false, false, null, null, ''),
              dry_run: true,
            });
          },
        }) as never,
    };
  }

  it.each([
    ['PASS with no counts', { result: 'PASS' }],
    ['PASS with total 0', { result: 'PASS', total: 0, passed: 0 }],
    ['PARTIAL with no tests', { result: 'PARTIAL', total: 0 }],
  ])('%s exits 3 and never reaches the updater', async (_name, report) => {
    const file = join(base, 'report.json');
    writeFileSync(file, JSON.stringify(report), 'utf-8');
    const spy = updaterSpy();
    const res = await invokeCanary(
      ['ticket-update', '--ticket', 'PROJ-1', '--result', file],
      { deps: { makeTicketUpdater: spy.makeTicketUpdater } },
    );
    expect(res.code).toBe(EXIT_ABSTAINED);
    expect(spy.calls).toEqual([]);
    expect(res.stdout).toContain('Abstained');
    expect(res.stdout).toContain('0 tests');
    expect(res.stdout).not.toContain('Transitioned');
    expect(res.stdout).not.toContain('Comment posted');
  });

  it('a FAIL with no tests still reaches the updater: a red signal is kept', async () => {
    // FAIL never transitions, and a runner that died before counting is the
    // failure the ticket should hear about; abstaining would hide it.
    const file = join(base, 'report.json');
    writeFileSync(file, JSON.stringify({ result: 'FAIL', total: 0 }), 'utf-8');
    const spy = updaterSpy();
    const res = await invokeCanary(
      ['ticket-update', '--ticket', 'PROJ-1', '--result', file, '--dry-run'],
      { deps: { makeTicketUpdater: spy.makeTicketUpdater } },
    );
    expect(spy.calls).toHaveLength(1);
    expect(res.code).not.toBe(EXIT_ABSTAINED);
  });

  it('a run with tests still reaches the updater', async () => {
    const file = join(base, 'report.json');
    writeFileSync(
      file,
      JSON.stringify({ result: 'PASS', total: 3, passed: 3 }),
      'utf-8',
    );
    const spy = updaterSpy();
    await invokeCanary(
      ['ticket-update', '--ticket', 'PROJ-1', '--result', file, '--dry-run'],
      { deps: { makeTicketUpdater: spy.makeTicketUpdater } },
    );
    expect(spy.calls).toHaveLength(1);
  });
});
