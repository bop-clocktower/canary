/**
 * Tests for the `pattern-healer` port (`agent/core/pattern_healer.py`,
 * `tests/unit/test_pattern_healer.py`). Every Python case is preserved. Python's
 * `textwrap.dedent` inputs contain no leading indentation here, so the literals
 * are written already-dedented.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PatternHealer } from '../src/core/pattern-healer.js';

let tmp: string;
const healer = new PatternHealer();

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'canary-healer-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function pyFile(content: string): string {
  const f = join(tmp, 'test_sample.py');
  writeFileSync(f, content, 'utf-8');
  return f;
}

function tsFile(content: string): string {
  const f = join(tmp, 'sample.spec.ts');
  writeFileSync(f, content, 'utf-8');
  return f;
}

describe('heal sleep', () => {
  it('heals time.sleep', () => {
    const result = healer.heal(pyFile('import time\ntime.sleep(2)\n'));
    expect(result.changed).toBe(true);
    expect(result.changes.some((c) => c.rule === 'HEAL-001')).toBe(true);
    expect(result.patched_content).not.toContain('time.sleep');
    expect(result.patched_content).toContain('TODO(canary)');
  });

  it('preserves indentation', () => {
    const result = healer.heal(pyFile('def test_foo():\n    time.sleep(1)\n'));
    expect(result.changed).toBe(true);
    for (const line of result.patched_content.split('\n')) {
      if (line.includes('TODO(canary)')) {
        expect(line.startsWith('    ')).toBe(true);
      }
    }
  });
});

describe('heal waitForTimeout', () => {
  it('heals wait for timeout', () => {
    const result = healer.heal(tsFile('await page.waitForTimeout(3000);\n'));
    expect(result.changed).toBe(true);
    expect(result.changes.some((c) => c.rule === 'HEAL-002')).toBe(true);
    expect(result.patched_content).not.toContain('waitForTimeout');
    expect(result.patched_content).toContain('TODO(canary)');
  });

  it('heals wait for timeout without await', () => {
    const result = healer.heal(tsFile('page.waitForTimeout(500);\n'));
    expect(result.changed).toBe(true);
    expect(result.changes.some((c) => c.rule === 'HEAL-002')).toBe(true);
  });
});

describe('heal missing await', () => {
  it('heals missing await', () => {
    const result = healer.heal(tsFile("page.click('#btn');\n"));
    expect(result.changed).toBe(true);
    expect(result.changes.some((c) => c.rule === 'HEAL-003')).toBe(true);
    expect(result.patched_content).toContain('await page.click');
  });

  it('no change when await present', () => {
    const result = healer.heal(tsFile("  await page.click('#btn');\n"));
    expect(result.changes.some((c) => c.rule === 'HEAL-003')).toBe(false);
  });

  // Regression (adversarial review, Divergence B): the HEAL-003 description
  // slices the call to 40 chars. Python slices by code point; JS `slice` by
  // UTF-16 unit, so a leading astral char would truncate 2x early. Assert the
  // whole call survives (40 code points >> its length).
  it('description slices by code point, not UTF-16 unit', () => {
    const result = healer.heal(tsFile("page.click('\u{1F600}');\n"));
    const h3 = result.changes.find((c) => c.rule === 'HEAL-003');
    expect(h3).toBeDefined();
    expect(h3!.description).toContain("page.click('\u{1F600}')");
  });
});

// Regression (adversarial review, Divergence C): Python `re.MULTILINE` anchors
// on `\n` ONLY. JS `^`/`$` under `/m` also break on lone `\r` (and U+2028/9),
// which would fire the healer — and rewrite the file — on input the oracle
// leaves untouched. A CR-only "line" must produce no change.
describe('line-terminator fidelity (\\r is not a line boundary)', () => {
  it('does not heal across a lone CR', () => {
    // `\r` is not a Python line boundary, so `time.sleep(1)` here is not a
    // full line by itself and the `$` anchor never matches.
    const result = healer.heal(pyFile('x=1\rtime.sleep(1)\rfoo\n'));
    expect(result.changed).toBe(false);
    expect(result.changes).toEqual([]);
  });

  it('still heals normal \\n lines', () => {
    const result = healer.heal(pyFile('x=1\ntime.sleep(1)\nfoo\n'));
    expect(result.changed).toBe(true);
    expect(result.changes.some((c) => c.rule === 'HEAL-001')).toBe(true);
  });
});

describe('skipped selectors', () => {
  it('skips brittle selectors', () => {
    const result = healer.heal(
      tsFile('await page.locator(".submit-btn").click();\n'),
    );
    expect(result.skipped.length).toBeGreaterThan(0);
    expect(
      result.skipped.some((s) => s.toLowerCase().includes('selector')),
    ).toBe(true);
    expect(result.patched_content).toContain('.submit-btn');
  });
});

describe('apply writes to disk', () => {
  it('apply writes to disk', () => {
    const f = pyFile('time.sleep(1)\n');
    const result = healer.apply(f);
    expect(result.changed).toBe(true);
    expect(readFileSync(f, 'utf-8')).not.toContain('time.sleep');
  });
});

describe('clean file', () => {
  it('clean file no changes', () => {
    const result = healer.heal(
      pyFile('def test_foo():\n    assert 1 + 1 == 2\n'),
    );
    expect(result.changed).toBe(false);
    expect(result.changes).toEqual([]);
  });
});

describe('multiple fixes', () => {
  it('multiple sleep fixes', () => {
    const result = healer.heal(
      pyFile('import time\ntime.sleep(1)\ntime.sleep(2)\n'),
    );
    const heal001 = result.changes.filter((c) => c.rule === 'HEAL-001');
    expect(heal001).toHaveLength(2);
  });
});

describe('HealResult properties', () => {
  it('changed false when no changes', () => {
    const result = healer.heal(pyFile('def test_foo():\n    assert True\n'));
    expect(result.changed).toBe(false);
  });

  it('file path recorded', () => {
    const f = pyFile('time.sleep(1)\n');
    const result = healer.heal(f);
    expect(result.file).toBe(f);
  });
});
