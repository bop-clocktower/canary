/**
 * A Cobertura `filename` attribute is XML: `&amp;`, `&apos;`, `&quot;`, `&lt;`,
 * `&gt;` and numeric character references must be decoded before the path is
 * matched against the diff. Undecoded, `src/a&amp;b.py` never matches the
 * changed `src/a&b.py`, so the unit silently drops to a lower tier and the
 * run blames a stale report or a scope gap for what is a parse defect.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveFromReport } from '../src/guardian/coverage.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'canary-cob-entity-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function cobertura(filename: string): string {
  const path = join(dir, 'coverage.xml');
  writeFileSync(
    path,
    '<?xml version="1.0"?>\n<coverage><packages><package><classes>' +
      `<class name="m" filename="${filename}"><lines>` +
      '<line number="1" hits="3"/></lines></class>' +
      '</classes></package></packages></coverage>\n',
    'utf-8',
  );
  return path;
}

describe('Cobertura filename entity decoding', () => {
  it('matches a changed path containing & against &amp; in the report', () => {
    const report = cobertura('src/a&amp;b.py');
    const results = resolveFromReport(
      [{ path: 'src/a&b.py', added_ranges: [[1, 1]] }],
      report,
    );
    expect(results?.map((r) => r.unit.path)).toEqual(['src/a&b.py']);
  });

  it("matches a changed path containing ' against a numeric reference", () => {
    const report = cobertura('src/it&#39;s.py');
    const results = resolveFromReport(
      [{ path: "src/it's.py", added_ranges: [[1, 1]] }],
      report,
    );
    expect(results?.map((r) => r.unit.path)).toEqual(["src/it's.py"]);
  });

  it('leaves a reference named after an Object.prototype member as written', () => {
    const report = cobertura('src/a&constructor;.py');
    const results = resolveFromReport(
      [{ path: 'src/a&constructor;.py', added_ranges: [[1, 1]] }],
      report,
    );
    expect(results?.map((r) => r.unit.path)).toEqual(['src/a&constructor;.py']);
  });

  it('decodes in one pass, so &amp;lt; names a literal &lt;', () => {
    const report = cobertura('src/a&amp;lt;b.py');
    const results = resolveFromReport(
      [{ path: 'src/a&lt;b.py', added_ranges: [[1, 1]] }],
      report,
    );
    expect(results?.map((r) => r.unit.path)).toEqual(['src/a&lt;b.py']);
  });
});
