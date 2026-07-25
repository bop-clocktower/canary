/**
 * Tests for the `reporter` port (`agent/core/reporter.py`, `tests/unit/
 * test_reporter.py`). Every Python case is preserved; the one Python-only case
 * (`Path` coercion via `default=str`) is ported to its JS analog (BigInt), the
 * only value `JSON.stringify` would otherwise throw on.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Reporter, SUPPORTED_FORMATS } from '../src/core/reporter.js';

const GENERATION_ONLY: Record<string, unknown> = {
  output_file: 'tests/test_auth.py',
  test_type: 'python_unit',
  framework: 'pytest',
  reasoning: ['Python source file detected', 'Standard unit test'],
};

const WITH_EXECUTION_PASS: Record<string, unknown> = {
  ...GENERATION_ONLY,
  execution: { exit_code: 0, stdout: '1 passed', stderr: '', fixed: false },
};

const WITH_EXECUTION_FAIL: Record<string, unknown> = {
  ...GENERATION_ONLY,
  execution: {
    exit_code: 1,
    stdout: '',
    stderr: 'AssertionError: expected True',
    fixed: false,
  },
};

const WITH_EXECUTION_FIXED: Record<string, unknown> = {
  ...GENERATION_ONLY,
  execution: { exit_code: 0, stdout: '1 passed', stderr: '', fixed: true },
};

describe('SUPPORTED_FORMATS', () => {
  it('json and sarif supported', () => {
    expect(SUPPORTED_FORMATS).toContain('json');
    expect(SUPPORTED_FORMATS).toContain('sarif');
  });
});

describe('toJson', () => {
  const reporter = new Reporter();

  it('returns valid JSON', () => {
    const parsed = JSON.parse(reporter.toJson(GENERATION_ONLY));
    expect(parsed.framework).toBe('pytest');
  });

  it('pretty printed', () => {
    expect(reporter.toJson(GENERATION_ONLY)).toContain('\n');
  });

  it('non-serialisable values coerced to str (BigInt analog of Path)', () => {
    const result = { ...GENERATION_ONLY, extra: 10n };
    const parsed = JSON.parse(reporter.toJson(result));
    expect(parsed.extra).toBe('10');
  });
});

describe('toSarif', () => {
  const reporter = new Reporter();
  const parsed = (result: Record<string, unknown>): any =>
    JSON.parse(reporter.toSarif(result));

  it('sarif version', () => {
    expect(parsed(GENERATION_ONLY).version).toBe('2.1.0');
  });

  it('schema key present', () => {
    expect(parsed(GENERATION_ONLY)).toHaveProperty('$schema');
  });

  it('single run', () => {
    expect(parsed(GENERATION_ONLY).runs).toHaveLength(1);
  });

  it('tool name', () => {
    expect(parsed(GENERATION_ONLY).runs[0].tool.driver.name).toBe('Canary');
  });

  it('rules list not empty', () => {
    expect(
      parsed(GENERATION_ONLY).runs[0].tool.driver.rules.length,
    ).toBeGreaterThan(0);
  });

  it('generation result always present', () => {
    const ruleIds = parsed(GENERATION_ONLY).runs[0].results.map(
      (r: any) => r.ruleId,
    );
    expect(ruleIds).toContain('canary/test-generation');
  });

  it('generation only: one result without execution', () => {
    expect(parsed(GENERATION_ONLY).runs[0].results).toHaveLength(1);
  });

  it('generation level is none', () => {
    expect(parsed(GENERATION_ONLY).runs[0].results[0].level).toBe('none');
  });

  it('generation properties include framework', () => {
    expect(
      parsed(GENERATION_ONLY).runs[0].results[0].properties.framework,
    ).toBe('pytest');
  });

  it('generation includes location when output_file set', () => {
    const locs = parsed(GENERATION_ONLY).runs[0].results[0].locations;
    expect(locs).toHaveLength(1);
    expect(locs[0].physicalLocation.artifactLocation.uri).toBe(
      'tests/test_auth.py',
    );
  });

  it('generation no location when no output_file', () => {
    const locs = parsed({ ...GENERATION_ONLY, output_file: '' }).runs[0]
      .results[0].locations;
    expect(locs).toEqual([]);
  });

  it('execution result present when execution in result', () => {
    const ruleIds = parsed(WITH_EXECUTION_PASS).runs[0].results.map(
      (r: any) => r.ruleId,
    );
    expect(ruleIds).toContain('canary/test-execution');
  });

  const execResult = (result: Record<string, unknown>): any =>
    parsed(result).runs[0].results.find(
      (r: any) => r.ruleId === 'canary/test-execution',
    );

  it('execution level none on pass', () => {
    expect(execResult(WITH_EXECUTION_PASS).level).toBe('none');
  });

  it('execution level error on fail', () => {
    expect(execResult(WITH_EXECUTION_FAIL).level).toBe('error');
  });

  it('execution message contains exit code', () => {
    expect(execResult(WITH_EXECUTION_FAIL).message.text).toContain(
      'exit code 1',
    );
  });

  it('execution message contains stderr preview', () => {
    expect(execResult(WITH_EXECUTION_FAIL).message.text).toContain(
      'AssertionError',
    );
  });

  it('stderr truncated at 300 chars', () => {
    const result = {
      ...GENERATION_ONLY,
      execution: {
        exit_code: 1,
        stdout: '',
        stderr: 'x'.repeat(400),
        fixed: false,
      },
    };
    expect(execResult(result).message.text).toContain('…');
  });

  it('fixed flag in execution message', () => {
    expect(execResult(WITH_EXECUTION_FIXED).message.text).toContain(
      'Self-healed',
    );
  });

  it('execution properties include exit code', () => {
    expect(execResult(WITH_EXECUTION_PASS).properties.exit_code).toBe(0);
  });

  it('two results when execution present', () => {
    expect(parsed(WITH_EXECUTION_PASS).runs[0].results).toHaveLength(2);
  });
});

describe('write', () => {
  let dir: string;
  const reporter = new Reporter();

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'canary-reporter-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('write json returns path', () => {
    const dest = join(dir, 'out.json');
    expect(reporter.write(GENERATION_ONLY, 'json', dest)).toBe(dest);
  });

  it('write json file exists', () => {
    const dest = join(dir, 'out.json');
    reporter.write(GENERATION_ONLY, 'json', dest);
    expect(existsSync(dest)).toBe(true);
  });

  it('write json content is valid json', () => {
    const dest = join(dir, 'out.json');
    reporter.write(GENERATION_ONLY, 'json', dest);
    expect(JSON.parse(readFileSync(dest, 'utf-8')).framework).toBe('pytest');
  });

  it('write sarif returns path', () => {
    const dest = join(dir, 'out.sarif');
    expect(reporter.write(GENERATION_ONLY, 'sarif', dest)).toBe(dest);
  });

  it('write sarif content is valid sarif', () => {
    const dest = join(dir, 'out.sarif');
    reporter.write(GENERATION_ONLY, 'sarif', dest);
    expect(JSON.parse(readFileSync(dest, 'utf-8')).version).toBe('2.1.0');
  });

  it('write default path json', () => {
    const original = process.cwd();
    process.chdir(dir);
    try {
      const path = reporter.write(GENERATION_ONLY, 'json');
      expect(basename(path)).toBe('canary-report.json');
    } finally {
      process.chdir(original);
    }
  });

  it('write default path sarif', () => {
    const original = process.cwd();
    process.chdir(dir);
    try {
      const path = reporter.write(GENERATION_ONLY, 'sarif');
      expect(basename(path)).toBe('canary-report.sarif');
    } finally {
      process.chdir(original);
    }
  });

  it('write creates parent dirs', () => {
    const dest = join(dir, 'nested', 'deep', 'out.json');
    reporter.write(GENERATION_ONLY, 'json', dest);
    expect(existsSync(dest)).toBe(true);
  });

  it('write raises for unsupported format', () => {
    expect(() => reporter.write(GENERATION_ONLY, 'xml')).toThrow(/xml/);
  });

  it('write raises mentions supported formats', () => {
    expect(() => reporter.write(GENERATION_ONLY, 'csv')).toThrow(/json/);
    expect(() => reporter.write(GENERATION_ONLY, 'csv')).toThrow(/sarif/);
  });
});
