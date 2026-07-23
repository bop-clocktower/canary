// Tier-2 dynamic-confirmer suite for canary-savant (Phase 2).
//
// Phase 2 ships baseline -> shuffle -> classify, pytest-first, with honest
// degradation when a shuffle plugin is absent. Isolation and polluter bisect
// are Phase 3 and are not exercised here. The orchestrator takes an injectable
// runSuite so classification, the baseline-red guard, and the clean path are
// deterministic in-process; the real spawn/parse wiring is covered by one
// integration test needing only an in-order baseline (no shuffle plugin).

import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as runner from '../claude-code/canary-savant/scripts/runner.mjs';
import {
  main,
  renderConfirm,
} from '../claude-code/canary-savant/scripts/cli.mjs';

const XML = `<?xml version="1.0"?>
<testsuites><testsuite name="pytest" tests="4">
  <testcase classname="test_m" name="test_ok" time="0.0"/>
  <testcase classname="test_m" name="test_bad" time="0.0"><failure message="x">boom</failure></testcase>
  <testcase classname="test_m" name="test_err" time="0.0"><error message="e">kaboom</error></testcase>
  <testcase classname="test_m" name="test_skip" time="0.0"><skipped/></testcase>
</testsuite></testsuites>`;

describe('parseJunitXml', () => {
  it('maps each outcome', () => {
    const o = runner.parseJunitXml(XML);
    expect(o['test_m::test_ok']).toBe('passed');
    expect(o['test_m::test_bad']).toBe('failed');
    expect(o['test_m::test_err']).toBe('error');
    expect(o['test_m::test_skip']).toBe('skipped');
  });

  it('empty suite is an empty map', () => {
    expect(
      runner.parseJunitXml('<?xml version="1.0"?><testsuites></testsuites>'),
    ).toEqual({});
  });
});

describe('detectShufflePlugin', () => {
  const probe = (available: Set<string>) => (name: string) =>
    available.has(name);

  it('prefers pytest-randomly', () => {
    expect(
      runner.detectShufflePlugin(probe(new Set(['randomly', 'random_order']))),
    ).toBe('pytest-randomly');
  });

  it('falls back to random-order', () => {
    expect(runner.detectShufflePlugin(probe(new Set(['random_order'])))).toBe(
      'pytest-random-order',
    );
  });

  it('returns null when absent', () => {
    expect(runner.detectShufflePlugin(probe(new Set()))).toBeNull();
  });
});

describe('command building', () => {
  it('baseline disables randomly only for that plugin', () => {
    const cmd = runner.buildBaselineCmd(
      ['tests'],
      '/tmp/j.xml',
      'pytest-randomly',
    );
    expect(cmd).toContain('pytest');
    expect(cmd).toContain('--junitxml=/tmp/j.xml');
    expect(cmd[cmd.indexOf('-p') + 1]).toBe('no:randomly');
  });

  it('baseline for random-order needs no disable flag', () => {
    const cmd = runner.buildBaselineCmd(
      ['tests'],
      '/tmp/j.xml',
      'pytest-random-order',
    );
    expect(cmd).not.toContain('no:randomly');
  });

  it('shuffle pins the seed for randomly', () => {
    const cmd = runner.buildShuffleCmd(
      ['tests'],
      '/tmp/j.xml',
      424242,
      'pytest-randomly',
    );
    expect(cmd).toContain('randomly');
    expect(cmd).toContain('--randomly-seed=424242');
  });

  it('shuffle pins the seed for random-order', () => {
    const cmd = runner.buildShuffleCmd(
      ['tests'],
      '/tmp/j.xml',
      424242,
      'pytest-random-order',
    );
    expect(cmd).toContain('--random-order');
    expect(cmd).toContain('--random-order-seed=424242');
  });
});

describe('classify', () => {
  it('flags an order-dependent victim', () => {
    const baseline = { 't::a': 'passed', 't::b': 'passed' };
    const shuffled = { 't::a': 'passed', 't::b': 'failed' };
    const findings = runner.classify(baseline, shuffled, shuffled, 1);
    const victims = findings.filter(
      (f) => f.classification === 'order-dependent',
    );
    expect(victims.map((f) => f.victim)).toEqual(['t::b']);
  });

  it('calls disagreeing same-seed reruns nondeterministic', () => {
    const findings = runner.classify(
      { 't::a': 'passed' },
      { 't::a': 'failed' },
      { 't::a': 'passed' },
      1,
    );
    expect(findings[0].classification).toBe('nondeterministic');
  });

  it('a clean suite yields nothing', () => {
    const b = { 't::a': 'passed', 't::b': 'passed' };
    expect(runner.classify(b, { ...b }, { ...b }, 1)).toEqual([]);
  });

  it('only considers tests green in baseline', () => {
    const baseline = { 't::a': 'failed' };
    expect(
      runner.classify(baseline, { 't::a': 'failed' }, { 't::a': 'failed' }, 1),
    ).toEqual([]);
  });
});

describe('confirm orchestrator', () => {
  const fixedRuns = (...maps: Record<string, string>[]) => {
    const calls = [...maps];
    return () => calls.shift()!;
  };

  it('degrades honestly without a plugin', () => {
    const result = runner.confirm(['tests'], { seed: 1, plugin: null });
    expect(result.status).toBe('no_plugin');
    expect(result.victims).toEqual([]);
  });

  it('reports baseline_red and stops', () => {
    const run = fixedRuns({ 't::a': 'failed', 't::b': 'passed' });
    const result = runner.confirm(['tests'], {
      seed: 1,
      plugin: 'pytest-randomly',
      runSuite: run,
    });
    expect(result.status).toBe('baseline_red');
    expect(result.baselineFailures).toContain('t::a');
  });

  it('finds an order-dependent victim end-to-end', () => {
    const run = fixedRuns(
      { 't::a': 'passed', 't::b': 'passed' }, // baseline
      { 't::a': 'passed', 't::b': 'failed' }, // shuffle 1
      { 't::a': 'passed', 't::b': 'failed' }, // shuffle 2 (agrees)
    );
    const result = runner.confirm(['tests'], {
      seed: 424242,
      plugin: 'pytest-randomly',
      runSuite: run,
    });
    expect(result.status).toBe('ok');
    expect(result.victims.map((v) => v.victim)).toEqual(['t::b']);
    expect(result.seed).toBe(424242);
    expect(result.reproduce).toContain('424242');
  });

  it('a clean suite reports ok with no victims', () => {
    const b = { 't::a': 'passed' };
    const run = fixedRuns({ ...b }, { ...b }, { ...b });
    const result = runner.confirm(['tests'], {
      seed: 1,
      plugin: 'pytest-randomly',
      runSuite: run,
    });
    expect(result.status).toBe('ok');
    expect(result.victims).toEqual([]);
  });
});

describe('renderConfirm output', () => {
  it('names victims and prints the reproduce command', () => {
    const text = renderConfirm({
      status: 'ok',
      seed: 424242,
      victims: [{ victim: 't::b', classification: 'order-dependent' }],
      nondeterministic: [
        { victim: 't::c', classification: 'nondeterministic' },
      ],
      reproduce: 'python3 -m pytest -p randomly --randomly-seed=424242 tests',
    });
    expect(text).toContain('order-dependent: t::b');
    expect(text).toContain('reproduce:');
    expect(text).toContain('424242');
    expect(text).toContain('nondeterministic');
  });

  it('says none confirmed on a clean dynamic run', () => {
    const text = renderConfirm({
      status: 'ok',
      seed: 1,
      victims: [],
      nondeterministic: [],
      reproduce: 'x',
    });
    expect(text).toContain('No order-dependence confirmed');
  });

  it('explains the skip on baseline_red', () => {
    const text = renderConfirm({
      status: 'baseline_red',
      message: 'suite not green',
      victims: [],
      nondeterministic: [],
    });
    expect(text).toContain('skipped');
  });
});

describe('cli --confirm', () => {
  afterEach(() => vi.restoreAllMocks());

  it('is advisory and explains when no shuffle plugin is present', () => {
    // No shuffle plugin is installed in this repo, so --confirm exercises the
    // real honest-degradation path.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'savant-cli-'));
    try {
      fs.writeFileSync(
        path.join(tmp, 'test_x.py'),
        'def test_a():\n    assert True\n',
      );
      const out: string[] = [];
      vi.spyOn(console, 'log').mockImplementation((s?: unknown) => {
        out.push(String(s));
      });
      const rc = main([tmp, '--confirm', '--seed', '7']);
      expect(rc).toBe(0); // advisory by default
      expect(out.join('\n').toLowerCase()).toContain('plugin');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('real pytest baseline (integration, no plugin needed)', () => {
  it('spawns pytest and parses the JUnit report', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'savant-dyn-'));
    try {
      const suite = path.join(tmp, 'test_demo.py');
      fs.writeFileSync(
        suite,
        'def test_pass():\n    assert True\ndef test_fail():\n    assert False\n',
      );
      const junit = path.join(tmp, 'j.xml');
      const outcomes = runner.runPytestSuite(
        runner.buildBaselineCmd([suite], junit, null),
        junit,
      );
      expect(outcomes['test_demo::test_pass']).toBe('passed');
      expect(outcomes['test_demo::test_fail']).toBe('failed');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
