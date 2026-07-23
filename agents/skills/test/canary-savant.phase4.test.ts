// Phase 4 for canary-savant: vitest as a Tier-2 target + pytest node-id
// fidelity (class-based layouts).
//
// vitest shuffle is built-in (no plugin) and its JUnit uses the same
// classname::name shape pytest does, so victim CLASSIFICATION reuses the Phase 2
// machinery. But vitest has no CLI-driven ordered per-test execution, so
// polluter BISECT (Phase 3) stays pytest-only - a documented limitation.
//
// pytest node-id capture: `--collect-only -q` yields authoritative node ids, and
// nodeId -> classname::name is a deterministic transform, so a correct key->id
// map replaces the fragile classname heuristic (fixes class-based re-runs).

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as runner from '../claude-code/canary-savant/scripts/runner.mjs';
import { renderConfirm } from '../claude-code/canary-savant/scripts/cli.mjs';

// --- detectFramework -------------------------------------------------------

describe('detectFramework', () => {
  it('picks pytest from a .py path', () => {
    expect(runner.detectFramework(['tests/test_x.py'])).toBe('pytest');
  });
  it('picks vitest from a .test.ts path', () => {
    expect(runner.detectFramework(['src/a.test.ts'])).toBe('vitest');
  });
  it('falls back to config files for a bare directory', () => {
    const exists = (f: string) => f === 'vitest.config.ts';
    expect(runner.detectFramework(['tests'], { exists })).toBe('vitest');
    const existsPy = (f: string) => f === 'pyproject.toml';
    expect(runner.detectFramework(['tests'], { exists: existsPy })).toBe(
      'pytest',
    );
  });
  it('returns null when it cannot tell', () => {
    expect(
      runner.detectFramework(['tests'], { exists: () => false }),
    ).toBeNull();
  });
});

// --- vitest command builders ----------------------------------------------

describe('vitest command builders', () => {
  it('baseline runs in declared order with a junit report', () => {
    const cmd = runner.buildVitestBaselineCmd(['tests'], '/tmp/j.xml');
    expect(cmd).toContain('vitest');
    expect(cmd).toContain('run');
    expect(cmd).toContain('--reporter=junit');
    expect(cmd).toContain('--outputFile=/tmp/j.xml');
    expect(cmd.join(' ')).not.toContain('shuffle');
  });
  it('shuffle pins the seed via built-in sequence flags', () => {
    const cmd = runner.buildVitestShuffleCmd(['tests'], '/tmp/j.xml', 42);
    expect(cmd).toContain('--sequence.shuffle');
    expect(cmd).toContain('--sequence.seed=42');
  });
});

// --- parseJunitXml handles vitest output -----------------------------------

describe('parseJunitXml on vitest output', () => {
  it('keys by file::name and detects failures', () => {
    const xml = `<?xml version="1.0"?><testsuites><testsuite name="a.test.ts">
      <testcase classname="a.test.ts" name="one" time="0.001"/>
      <testcase classname="a.test.ts" name="two" time="0.002"><failure message="x">boom</failure></testcase>
    </testsuite></testsuites>`;
    const out = runner.parseJunitXml(xml);
    expect(out['a.test.ts::one']).toBe('passed');
    expect(out['a.test.ts::two']).toBe('failed');
  });
});

// --- confirm() on a vitest target ------------------------------------------

describe('confirm on vitest', () => {
  const fixedRuns = (...maps: Record<string, string>[]) => {
    const calls = [...maps];
    return () => calls.shift()!;
  };

  it('detects a victim with no shuffle plugin required', () => {
    const run = fixedRuns(
      { 'a.test.ts::x': 'passed', 'a.test.ts::y': 'passed' }, // baseline
      { 'a.test.ts::x': 'passed', 'a.test.ts::y': 'failed' }, // shuffle 1
      { 'a.test.ts::x': 'passed', 'a.test.ts::y': 'failed' }, // shuffle 2
    );
    const result = runner.confirm(['tests'], {
      seed: 42,
      framework: 'vitest',
      runSuite: run,
    });
    expect(result.status).toBe('ok');
    expect(result.framework).toBe('vitest');
    expect(result.victims.map((v) => v.victim)).toEqual(['a.test.ts::y']);
  });
});

// --- renderConfirm: vitest note + unknown-framework skip -------------------

describe('renderConfirm framework branches', () => {
  it('notes that polluter bisect is pytest-only for vitest victims', () => {
    const text = renderConfirm({
      status: 'ok',
      seed: 1,
      framework: 'vitest',
      victims: [{ victim: 'a.test.ts::y' }],
      nondeterministic: [],
      reproduce: 'npx vitest run --sequence.shuffle --sequence.seed=1',
    });
    expect(text).toContain('pytest-only');
    expect(text).toContain('reproduce:');
  });

  it('skips with a message when the framework is unknown', () => {
    const text = renderConfirm({
      status: 'unknown_framework',
      message: 'could not detect pytest or vitest',
      victims: [],
      nondeterministic: [],
    });
    expect(text).toContain('skipped');
  });
});

// --- pytest node-id fidelity -----------------------------------------------

describe('nodeIdToKey', () => {
  it('maps a module-level node id to its JUnit key', () => {
    expect(runner.nodeIdToKey('tests/test_x.py::test_a')).toBe(
      'tests.test_x::test_a',
    );
  });
  it('maps a class-based node id (the Phase 3 gap) to its JUnit key', () => {
    expect(runner.nodeIdToKey('tests/test_x.py::TestG::test_a')).toBe(
      'tests.test_x.TestG::test_a',
    );
  });
  it('handles a root-level file', () => {
    expect(runner.nodeIdToKey('test_x.py::test_a')).toBe('test_x::test_a');
  });
});

describe('buildNodeIdMap', () => {
  it('maps JUnit keys back to runnable node ids', () => {
    const map = runner.buildNodeIdMap([
      'tests/test_x.py::TestG::test_a',
      'tests/test_x.py::test_b',
    ]);
    expect(map['tests.test_x.TestG::test_a']).toBe(
      'tests/test_x.py::TestG::test_a',
    );
    expect(map['tests.test_x::test_b']).toBe('tests/test_x.py::test_b');
  });
});

// --- integration: collect real node ids (incl. class-based) ----------------

describe('collectPytestNodeIds (integration)', () => {
  it('returns authoritative node ids that round-trip to JUnit keys', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'savant-p4-'));
    const cwd = process.cwd();
    try {
      fs.writeFileSync(
        path.join(tmp, 'test_cls.py'),
        [
          'class TestGroup:',
          '    def test_alpha(self): assert True',
          'def test_top(): assert True',
          '',
        ].join('\n'),
      );
      process.chdir(tmp);
      const ids = runner.collectPytestNodeIds(['test_cls.py']);
      expect(ids).toContain('test_cls.py::TestGroup::test_alpha');
      expect(ids).toContain('test_cls.py::test_top');
      const map = runner.buildNodeIdMap(ids);
      // The JUnit key pytest would emit maps back to the runnable node id.
      expect(map['test_cls.TestGroup::test_alpha']).toBe(
        'test_cls.py::TestGroup::test_alpha',
      );
    } finally {
      process.chdir(cwd);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
