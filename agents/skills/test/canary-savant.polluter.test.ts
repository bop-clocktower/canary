// Tier-2 Phase 3 for canary-savant: isolation re-run + polluter bisect.
//
// The differentiator over a stock shuffle plugin: once a victim is found, run
// it alone to confirm the failure is external (shared-state leak), then bisect
// the prefix of tests-that-ran-before-it to NAME the culprit. Algorithms are
// pure/injectable so they are deterministic in-process; the real subprocess
// seams are covered by one integration test needing only in-order pytest runs.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as runner from '../claude-code/canary-savant/scripts/runner.mjs';
import { renderConfirm } from '../claude-code/canary-savant/scripts/cli.mjs';

// --- isolationConfirms -----------------------------------------------------

describe('isolationConfirms', () => {
  it('confirms when the victim passes every alone-run', () => {
    expect(runner.isolationConfirms(['passed', 'passed', 'passed'])).toBe(true);
  });
  it('does not confirm if any alone-run fails', () => {
    expect(runner.isolationConfirms(['passed', 'failed', 'passed'])).toBe(
      false,
    );
  });
  it('does not confirm on an empty set', () => {
    expect(runner.isolationConfirms([])).toBe(false);
  });
});

// --- bisectPolluter --------------------------------------------------------

describe('bisectPolluter', () => {
  const prefix = ['t0', 't1', 't2', 't3', 't4', 't5', 't6', 't7'];

  it('names the single culprit somewhere in the middle', () => {
    const b = runner.bisectPolluter(prefix, (subset) => subset.includes('t5'));
    expect(b.polluter).toBe('t5');
    expect(b.exhausted).toBe(false);
    expect(b.minimalPrefix).toEqual(['t0', 't1', 't2', 't3', 't4', 't5']);
  });

  it('names the culprit when it ran first', () => {
    const b = runner.bisectPolluter(prefix, (subset) => subset.includes('t0'));
    expect(b.polluter).toBe('t0');
    expect(b.minimalPrefix).toEqual(['t0']);
  });

  it('names the culprit when it ran last', () => {
    const b = runner.bisectPolluter(prefix, (subset) => subset.includes('t7'));
    expect(b.polluter).toBe('t7');
  });

  it('reports exhaustion (no single culprit) on a non-monotonic predicate', () => {
    // reproduces only for an exact prefix length -> not shrinkable to one test
    const b = runner.bisectPolluter(prefix, (subset) => subset.length === 3);
    expect(b.polluter).toBeNull();
    expect(b.exhausted).toBe(true);
    expect(b.minimalPrefix.length).toBeGreaterThan(0);
  });

  it('respects the step budget', () => {
    const big = Array.from({ length: 128 }, (_, i) => `t${i}`);
    const b = runner.bisectPolluter(big, (subset) => subset.includes('t60'), {
      maxSteps: 1,
    });
    expect(b.steps).toBeLessThanOrEqual(1 + 2); // loop cap + the two verify calls
  });
});

// --- command builders ------------------------------------------------------

describe('polluter-run command builders', () => {
  it('isolate cmd runs one test in-order with junit output', () => {
    const cmd = runner.buildIsolateCmd('tests/t.py::test_x', '/tmp/j.xml');
    expect(cmd).toContain('tests/t.py::test_x');
    expect(cmd[cmd.indexOf('-p') + 1]).toBe('no:randomly');
    expect(cmd).toContain('--junitxml=/tmp/j.xml');
  });

  it('ordered-subset cmd preserves the given node-id order', () => {
    const ids = ['a::x', 'b::y', 'c::z'];
    const cmd = runner.buildOrderedSubsetCmd(ids, '/tmp/j.xml');
    const positions = ids.map((id) => cmd.indexOf(id));
    expect(positions).toEqual([...positions].sort((m, n) => m - n));
    expect(cmd[cmd.indexOf('-p') + 1]).toBe('no:randomly');
  });
});

// --- locatePolluters (orchestration, injected seams) -----------------------

describe('locatePolluters', () => {
  const order = ['t::a', 't::polluter', 't::b', 't::victim'];
  const victims = [{ victim: 't::victim', classification: 'order-dependent' }];

  it('names the polluter for a victim that passes alone', () => {
    const seams = {
      runVictimAlone: () => 'passed',
      reproducesInPrefix: (subset: string[]) => subset.includes('t::polluter'),
      isolateRepeats: 2,
    };
    const [ev] = runner.locatePolluters(victims, order, seams);
    expect(ev.passesAlone).toBe(true);
    expect(ev.polluter).toBe('t::polluter');
    expect(ev.reproduce).toContain('t::polluter');
    expect(ev.reproduce).toContain('t::victim');
  });

  it('does not blame anyone when the victim fails in isolation', () => {
    const seams = {
      runVictimAlone: () => 'failed',
      reproducesInPrefix: () => true,
    };
    const [ev] = runner.locatePolluters(victims, order, seams);
    expect(ev.passesAlone).toBe(false);
    expect(ev.polluter).toBeNull();
    expect(ev.note).toMatch(/isolation/i);
  });

  it('notes when the victim ran first (no prefix to blame)', () => {
    const firstOrder = ['t::victim', 't::a'];
    const seams = {
      runVictimAlone: () => 'passed',
      reproducesInPrefix: () => true,
    };
    const [ev] = runner.locatePolluters(victims, firstOrder, seams);
    expect(ev.passesAlone).toBe(true);
    expect(ev.polluter).toBeNull();
    expect(ev.note).toMatch(/first/i);
  });

  it('falls back to the minimal prefix when no single culprit isolates', () => {
    // Non-monotonic reproduction (fires only at an exact prefix length the
    // binary search steps over) -> no single culprit, honest fallback.
    const longOrder = ['a', 'b', 'c', 'd', 'e', 'f', 't::victim'];
    const seams = {
      runVictimAlone: () => 'passed',
      reproducesInPrefix: (subset: string[]) => subset.length === 2,
    };
    const [ev] = runner.locatePolluters(victims, longOrder, seams);
    expect(ev.passesAlone).toBe(true);
    expect(ev.polluter).toBeNull();
    expect(ev.exhausted).toBe(true);
    expect(Array.isArray(ev.minimalPrefix)).toBe(true);
  });
});

// --- renderConfirm surfaces the Phase 3 verdict ----------------------------

describe('renderConfirm with polluter data', () => {
  const base = {
    status: 'ok',
    seed: 7,
    nondeterministic: [],
    reproduce: 'shuf',
  };

  it('names the polluter and its reproduce command', () => {
    const text = renderConfirm({
      ...base,
      victims: [
        {
          victim: 't::v',
          polluter: 't::p',
          reproduce: 'python3 -m pytest -p no:randomly t::p t::v',
        },
      ],
    });
    expect(text).toContain('polluted by: t::p');
    expect(text).toContain(
      'reproduce: python3 -m pytest -p no:randomly t::p t::v',
    );
  });

  it('shows the isolation note when the victim fails alone', () => {
    const text = renderConfirm({
      ...base,
      victims: [
        { victim: 't::v', polluter: null, note: 'fails in isolation - broken' },
      ],
    });
    expect(text).toContain('fails in isolation');
  });

  it('reports the minimal prefix when no single culprit isolates', () => {
    const text = renderConfirm({
      ...base,
      victims: [
        {
          victim: 't::v',
          polluter: null,
          exhausted: true,
          minimalPrefix: ['a', 'b'],
        },
      ],
    });
    expect(text).toContain('no single culprit');
    expect(text).toContain('2 test');
  });
});

// --- confirm() exposes the shuffled order (Phase 3 needs it) ---------------

describe('confirm exposes shuffled order', () => {
  it('returns the execution order of the shuffle run', () => {
    const b = { 't::a': 'passed', 't::b': 'passed' };
    const runs = [b, b, b];
    const result = runner.confirm(['tests'], {
      seed: 1,
      plugin: 'pytest-randomly',
      runSuite: () => runs.shift()!,
    });
    expect(result.order).toEqual(['t::a', 't::b']);
  });
});

// --- realPolluterSeams (integration, no shuffle plugin needed) -------------

describe('realPolluterSeams (integration)', () => {
  it('runs a victim alone and detects reproduction via a real prefix run', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'savant-pol-'));
    const cwd = process.cwd();
    try {
      // A planted leak: test_victim only passes if test_polluter set the flag.
      fs.writeFileSync(
        path.join(tmp, 'test_leak.py'),
        [
          'import os',
          'def test_polluter():',
          "    os.environ['SAVANT_FLAG'] = '1'",
          'def test_victim():',
          "    assert os.environ.get('SAVANT_FLAG') == '1'",
          '',
        ].join('\n'),
      );
      // Canonical ids as they'd arrive from the shuffle report (classname::name).
      const victim = 'test_leak::test_victim';
      const polluter = 'test_leak::test_polluter';
      process.chdir(tmp); // seams translate classname -> relative path node id
      const seams = runner.realPolluterSeams(
        ['test_leak.py'],
        path.join(tmp, 'pj.xml'),
      );
      // Victim alone: the flag is unset, so it fails in isolation.
      expect(seams.runVictimAlone(victim)).toBe('failed');
      // Alone it fails -> "reproduces"; with the polluter first it passes -> not.
      expect(seams.reproducesInPrefix([], victim)).toBe(true);
      expect(seams.reproducesInPrefix([polluter], victim)).toBe(false);
    } finally {
      process.chdir(cwd);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
