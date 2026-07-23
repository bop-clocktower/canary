// Unit suite for the canary-katana skill, ported from Python to vitest as the
// skill moves to JS (canary mirrors harness, which is TS/Node). Behavior is
// preserved from the Python version.
//
// canary-katana quarantines deleted and newly-skipped tests: it captures every
// one with provenance, and alarms only when a deletion removes the last
// coverage of a critical-area symbol.

import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import * as diffscan from '../claude-code/canary-katana/scripts/diffscan.mjs';
import * as alarm from '../claude-code/canary-katana/scripts/alarm.mjs';
import * as ledger from '../claude-code/canary-katana/scripts/ledger.mjs';
import { main } from '../claude-code/canary-katana/scripts/cli.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.join(HERE, '..', 'claude-code', 'canary-katana');
const SCRIPTS = path.join(SKILL_DIR, 'scripts');

const tmps: string[] = [];
const mkTmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'katana-'));
  tmps.push(d);
  return d;
};
afterEach(() => {
  vi.restoreAllMocks();
  while (tmps.length) fs.rmSync(tmps.pop()!, { recursive: true, force: true });
});

// --- fixture diffs ---------------------------------------------------------

const PY_REMOVAL = `diff --git a/tests/test_points.py b/tests/test_points.py
index 1111111..2222222 100644
--- a/tests/test_points.py
+++ b/tests/test_points.py
@@ -1,10 +1,6 @@
 import pytest

-def test_earns_points_on_purchase():
-    assert earn(100) == 10
-
-async def test_points_expire():
-    assert True
-
 def test_still_here():
     assert True
`;

const JS_REMOVAL = `diff --git a/tests/checkout.spec.ts b/tests/checkout.spec.ts
index 3333333..4444444 100644
--- a/tests/checkout.spec.ts
+++ b/tests/checkout.spec.ts
@@ -1,12 +1,4 @@
-describe('checkout flow', () => {
-  it('adds to cart', async () => {
-    await addToCart();
-  });
-
-  test("clears the cart", async () => {
-    await clearCart();
-  });
-});
+// checkout tests removed
`;

const PYTEST_SKIP = `diff --git a/tests/test_refunds.py b/tests/test_refunds.py
index 5555555..6666666 100644
--- a/tests/test_refunds.py
+++ b/tests/test_refunds.py
@@ -1,6 +1,8 @@
 import pytest

+@pytest.mark.skip(reason="flaky")
 def test_refunds_are_idempotent():
     assert True

+@pytest.mark.xfail
 def test_refund_partial():
     assert True
`;

const JS_SKIP = `diff --git a/tests/cart.spec.ts b/tests/cart.spec.ts
index 7777777..8888888 100644
--- a/tests/cart.spec.ts
+++ b/tests/cart.spec.ts
@@ -1,8 +1,8 @@
-  it('adds to cart', async () => {
+  it.skip('adds to cart', async () => {
     await addToCart();
   });
-  test('removes from cart', async () => {
+  test.skip('removes from cart', async () => {
     await removeFromCart();
   });
`;

const XIT_AND_ONLY = `diff --git a/tests/wishlist.spec.ts b/tests/wishlist.spec.ts
index 9999999..aaaaaaa 100644
--- a/tests/wishlist.spec.ts
+++ b/tests/wishlist.spec.ts
@@ -1,6 +1,6 @@
-  it('saves a wish', () => {});
+  xit('saves a wish', () => {});
-  it('shares a wish', () => {});
+  it.only('shares a wish', () => {});
`;

const NON_TEST_FILE = `diff --git a/src/points.service.ts b/src/points.service.ts
index bbbbbbb..ccccccc 100644
--- a/src/points.service.ts
+++ b/src/points.service.ts
@@ -1,5 +1,2 @@
-export function testHarness() {
-  it('inline', () => {});
-}
 export const x = 1;
`;

const WHOLE_FILE_REMOVAL = `diff --git a/tests/test_points.py b/tests/test_points.py
deleted file mode 100644
index 1111111..0000000
--- a/tests/test_points.py
+++ /dev/null
@@ -1,4 +0,0 @@
-def test_earns_points():
-    assert True
-def test_points_expire():
-    assert True
`;

const FIXME_CONVERSION = `diff --git a/tests/checkout.spec.ts b/tests/checkout.spec.ts
index 1111111..2222222 100644
--- a/tests/checkout.spec.ts
+++ b/tests/checkout.spec.ts
@@ -1,6 +1,6 @@
-test.describe('Checkout Flow', () => {
+test.describe.fixme('Checkout Flow', () => {
   beforeEach(async ({ page }) => { await page.goto('/'); });
-  test('Verify cart totals update', async () => {
+  test.fixme('Verify cart totals update', async () => {
     await expect(page).toHaveTitle(/Cart/);
   });
`;

const PENDING_SKIP_NO_DEF = `diff --git a/tests/test_orphan.py b/tests/test_orphan.py
--- a/tests/test_orphan.py
+++ b/tests/test_orphan.py
@@ -1,2 +1,6 @@
 import pytest
+@pytest.mark.skip(reason="later")
+
+# a note, not a def
+x = 1
`;

const NO_NEWLINE_AT_EOF = `diff --git a/tests/test_eof.py b/tests/test_eof.py
--- a/tests/test_eof.py
+++ b/tests/test_eof.py
@@ -1,2 +1,1 @@
-def test_gone():
-    assert True
\\ No newline at end of file
`;

const POINTS_REMOVAL = `diff --git a/tests/test_points.py b/tests/test_points.py
--- a/tests/test_points.py
+++ b/tests/test_points.py
@@ -1,5 +1,1 @@
-def test_points_service_earns():
-    assert earn(100) == 10
-
 x = 1
`;

// --- diffscan: test-file classification ------------------------------------

describe('diffscan.isTestFile', () => {
  it.each([
    'tests/test_points.py',
    'pkg/points_test.py',
    'tests/checkout.spec.ts',
    'src/cart.test.tsx',
    'app/__tests__/thing.js',
    'test/legacy/thing.js',
  ])('accepts %s', (p) => {
    expect(diffscan.isTestFile(p)).toBe(true);
  });

  it.each([
    'src/points.service.ts',
    'docs/testing.md',
    'README.md',
    'src/latest/api.py',
  ])('rejects %s', (p) => {
    expect(diffscan.isTestFile(p)).toBe(false);
  });
});

// --- diffscan: removed-test detection --------------------------------------

describe('diffscan removed tests', () => {
  it('finds removed python tests', () => {
    const found = diffscan.findDeletions(PY_REMOVAL);
    expect(found.map((d) => d.name)).toEqual([
      'test_earns_points_on_purchase',
      'test_points_expire',
    ]);
    expect(found.every((d) => d.kind === diffscan.Kind.REMOVED)).toBe(true);
    expect(found.every((d) => d.file === 'tests/test_points.py')).toBe(true);
  });

  it('finds removed js tests including the describe block', () => {
    const names = diffscan
      .findDeletions(JS_REMOVAL)
      .map((d) => d.name)
      .sort();
    expect(names).toEqual(['adds to cart', 'checkout flow', 'clears the cart']);
  });

  it('ignores deletions in non-test files', () => {
    expect(diffscan.findDeletions(NON_TEST_FILE)).toEqual([]);
  });

  it('finds tests in a wholesale-deleted file', () => {
    const found = diffscan.findDeletions(WHOLE_FILE_REMOVAL);
    expect(found.map((d) => d.name)).toEqual([
      'test_earns_points',
      'test_points_expire',
    ]);
    expect(found.every((d) => d.file === 'tests/test_points.py')).toBe(true);
    expect(found.every((d) => d.kind === diffscan.Kind.REMOVED)).toBe(true);
  });

  it('records line numbers for removed tests', () => {
    expect(diffscan.findDeletions(PY_REMOVAL)[0].line).toBe(3);
  });

  it('sorts deletions stably', () => {
    const found = diffscan.findDeletions(PY_REMOVAL + JS_REMOVAL);
    const keys = found.map((d) => [d.file, d.name]);
    expect(keys).toEqual(
      [...keys].sort(
        (a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]),
      ),
    );
  });
});

// --- diffscan: skip-marker detection ---------------------------------------

describe('diffscan skip markers', () => {
  it('finds newly-added pytest skip and xfail', () => {
    const byName = Object.fromEntries(
      diffscan.findDeletions(PYTEST_SKIP).map((d) => [d.name, d]),
    );
    expect(Object.keys(byName).sort()).toEqual([
      'test_refund_partial',
      'test_refunds_are_idempotent',
    ]);
    expect(byName['test_refunds_are_idempotent'].kind).toBe(
      diffscan.Kind.SKIPPED,
    );
    expect(byName['test_refunds_are_idempotent'].marker).toContain(
      'pytest.mark.skip',
    );
    expect(byName['test_refund_partial'].marker).toContain('pytest.mark.xfail');
  });

  it('finds js skip markers', () => {
    const byName = Object.fromEntries(
      diffscan.findDeletions(JS_SKIP).map((d) => [d.name, d]),
    );
    expect(Object.keys(byName).sort()).toEqual([
      'adds to cart',
      'removes from cart',
    ]);
    expect(byName['adds to cart'].marker).toBe('it.skip');
    expect(byName['removes from cart'].marker).toBe('test.skip');
  });

  it('finds xit and .only narrowing', () => {
    const byName = Object.fromEntries(
      diffscan.findDeletions(XIT_AND_ONLY).map((d) => [d.name, d]),
    );
    expect(byName['saves a wish'].marker).toBe('xit');
    expect(byName['shares a wish'].marker).toBe('it.only');
  });

  it('skip supersedes removal of the same test', () => {
    const found = diffscan.findDeletions(JS_SKIP);
    expect(found.length).toBe(2);
    expect(found.every((d) => d.kind === diffscan.Kind.SKIPPED)).toBe(true);
  });

  it('classifies .fixme conversions as skipped, not removed (#400)', () => {
    const byName = Object.fromEntries(
      diffscan.findDeletions(FIXME_CONVERSION).map((d) => [d.name, d]),
    );
    expect(Object.keys(byName).sort()).toEqual([
      'Checkout Flow',
      'Verify cart totals update',
    ]);
    const found = diffscan.findDeletions(FIXME_CONVERSION);
    expect(found.every((d) => d.kind === diffscan.Kind.SKIPPED)).toBe(true);
    expect(found.every((d) => d.marker.includes('fixme'))).toBe(true);
  });

  it('deletion dict is json-safe', () => {
    const d = diffscan.findDeletions(JS_SKIP)[0];
    const payload = diffscan.deletionToDict(d);
    expect(payload.kind).toBe('skipped');
    expect(() => JSON.stringify(payload)).not.toThrow();
  });

  it('drops a pending skip marker with no following def', () => {
    expect(diffscan.findDeletions(PENDING_SKIP_NO_DEF)).toEqual([]);
  });

  it('handles a no-newline-at-eof marker', () => {
    const found = diffscan.findDeletions(NO_NEWLINE_AT_EOF);
    expect(found.map((d) => d.name)).toEqual(['test_gone']);
    expect(found[0].kind).toBe(diffscan.Kind.REMOVED);
  });
});

// --- ledger ----------------------------------------------------------------

const entry = (o: Record<string, string> = {}) =>
  ledger.LedgerEntry({
    test: 'test_a',
    file: 'tests/test_a.py',
    kind: 'removed',
    marker: '',
    commit: 'abc123',
    author: 'Ada Lovelace',
    date: '2026-07-20T10:00:00+00:00',
    reason: 'chore: drop dead feature',
    ...o,
  });

describe('ledger', () => {
  it('load of a missing file returns an empty doc', () => {
    const doc = ledger.load(path.join(mkTmp(), 'nope.json'));
    expect(doc).toEqual({ schema_version: ledger.SCHEMA_VERSION, entries: [] });
  });

  it('append writes the expected shape', () => {
    const p = path.join(mkTmp(), '.canary', 'quarantine.json');
    const doc = ledger.appendEntries(p, [entry()]);
    expect(fs.existsSync(p)).toBe(true);
    const onDisk = JSON.parse(fs.readFileSync(p, 'utf8'));
    expect(onDisk).toEqual(doc);
    expect(onDisk.schema_version).toBe(ledger.SCHEMA_VERSION);
    const row = onDisk.entries[0];
    expect(row.test).toBe('test_a');
    expect(row.file).toBe('tests/test_a.py');
    expect(row.commit).toBe('abc123');
    expect(row.author).toBe('Ada Lovelace');
    expect(row.reason).toBe('chore: drop dead feature');
  });

  it('is append-only', () => {
    const p = path.join(mkTmp(), 'q.json');
    ledger.appendEntries(p, [entry({ test: 'test_a' })]);
    const doc = ledger.appendEntries(p, [entry({ test: 'test_b' })]);
    expect(doc.entries.map((e: { test: string }) => e.test)).toEqual([
      'test_a',
      'test_b',
    ]);
  });

  it('dedupes identical entries', () => {
    const p = path.join(mkTmp(), 'q.json');
    ledger.appendEntries(p, [entry()]);
    const doc = ledger.appendEntries(p, [entry()]);
    expect(doc.entries.length).toBe(1);
  });

  it('sorts new entries for stable ordering', () => {
    const p = path.join(mkTmp(), 'q.json');
    const doc = ledger.appendEntries(p, [
      entry({ test: 'z', file: 'tests/b.py' }),
      entry({ test: 'a', file: 'tests/b.py' }),
      entry({ test: 'm', file: 'tests/a.py' }),
    ]);
    expect(
      doc.entries.map((e: { file: string; test: string }) => [e.file, e.test]),
    ).toEqual([
      ['tests/a.py', 'm'],
      ['tests/b.py', 'a'],
      ['tests/b.py', 'z'],
    ]);
  });

  it('throws on a corrupt file', () => {
    const p = path.join(mkTmp(), 'q.json');
    fs.writeFileSync(p, 'not json');
    expect(() => ledger.load(p)).toThrow();
  });

  it('throws on a non-object top level', () => {
    const p = path.join(mkTmp(), 'q.json');
    fs.writeFileSync(p, '[1, 2]');
    expect(() => ledger.load(p)).toThrow();
  });
});

// --- alarm: critical-area loading and degradation --------------------------

const areasFile = (tmp: string, areas: object[]) => {
  const p = path.join(tmp, 'critical-areas.json');
  fs.writeFileSync(
    p,
    JSON.stringify({ generated: '2026-07-20T00:00:00+00:00', areas }),
  );
  return p;
};

const repoWith = (tmp: string, files: Record<string, string>) => {
  for (const [rel, text] of Object.entries(files)) {
    const p = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
  }
  return tmp;
};

describe('alarm critical-area loading', () => {
  it('missing file is unavailable', () => {
    const r = alarm.loadCriticalAreas(path.join(mkTmp(), 'nope.json'));
    expect(r.available).toBe(false);
    expect(r.areas).toEqual([]);
    expect(r.reason).toContain('not found');
  });

  it('malformed file is unavailable', () => {
    const p = path.join(mkTmp(), 'critical-areas.json');
    fs.writeFileSync(p, '{oops');
    const r = alarm.loadCriticalAreas(p);
    expect(r.available).toBe(false);
    expect(r.reason).toBeTruthy();
  });

  it('reads areas', () => {
    const p = areasFile(mkTmp(), [
      { path: 'src/loyalty/points.service.ts', risk_score: 0.92 },
    ]);
    const r = alarm.loadCriticalAreas(p);
    expect(r.available).toBe(true);
    expect(r.areas[0].path).toBe('src/loyalty/points.service.ts');
  });

  it('degraded area set never alarms', () => {
    const tmp = mkTmp();
    const deletions = diffscan.findDeletions(PY_REMOVAL);
    const unavailable = alarm.loadCriticalAreas(path.join(tmp, 'nope.json'));
    expect(alarm.buildFindings(deletions, unavailable, tmp)).toEqual([]);
  });

  it('degraded notice text is explicit', () => {
    expect(alarm.DEGRADED_NOTICE).toBe(
      'critical-area data unavailable, recording only, not alarming',
    );
  });
});

// --- alarm: last-coverage detection ----------------------------------------

describe('alarm last-coverage detection', () => {
  it('area symbols strip suffixes', () => {
    const syms = alarm.areaSymbols('src/loyalty/points.service.ts');
    expect(syms.has('points.service')).toBe(true);
    expect(syms.has('points')).toBe(true);
  });

  it('fires when the last coverage is removed', () => {
    const tmp = mkTmp();
    const repo = repoWith(tmp, { 'tests/test_points.py': 'x = 1\n' });
    const areas = alarm.loadCriticalAreas(
      areasFile(tmp, [
        { path: 'src/loyalty/points.service.ts', risk_score: 0.92 },
      ]),
    );
    const findings = alarm.buildFindings(
      diffscan.findDeletions(POINTS_REMOVAL),
      areas,
      repo,
    );
    expect(findings.length).toBe(1);
    const f = findings[0];
    expect(f.kind).toBe('last-coverage-removed');
    expect(f.area).toBe('src/loyalty/points.service.ts');
    expect(f.severity).toBe(alarm.Severity.CRITICAL);
    expect(f.fidelity).toBe(alarm.Fidelity.NAME_MATCHED);
  });

  it('does not alarm when other tests still cover the symbol', () => {
    const tmp = mkTmp();
    const repo = repoWith(tmp, {
      'tests/test_points.py': 'x = 1\n',
      'tests/test_points_api.py': 'def test_points_service_api():\n    pass\n',
    });
    const areas = alarm.loadCriticalAreas(
      areasFile(tmp, [
        { path: 'src/loyalty/points.service.ts', risk_score: 0.92 },
      ]),
    );
    expect(
      alarm.buildFindings(diffscan.findDeletions(POINTS_REMOVAL), areas, repo),
    ).toEqual([]);
  });

  it('skips non-utf8 files without crashing (#395)', () => {
    const tmp = mkTmp();
    const repo = repoWith(tmp, { 'tests/test_points.py': 'x = 1\n' });
    const bin = path.join(tmp, 'tests', 'assets', 'logo.png');
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    fs.writeFileSync(
      bin,
      Buffer.from([0xff, 0xfe, 0x00, 0x01, 0x20, 0xff, 0xfe]),
    );
    const areas = alarm.loadCriticalAreas(
      areasFile(tmp, [
        { path: 'src/loyalty/points.service.ts', risk_score: 0.92 },
      ]),
    );
    const findings = alarm.buildFindings(
      diffscan.findDeletions(POINTS_REMOVAL),
      areas,
      repo,
    );
    expect(findings.length).toBe(1);
    expect(findings[0].kind).toBe('last-coverage-removed');
  });

  it('prunes heavy ignored dirs (#395)', () => {
    const tmp = mkTmp();
    const repo = repoWith(tmp, {
      'tests/real.test.js': "it('real', () => {})\n",
      'node_modules/pkg/vendored.test.js': "it('vendored', () => {})\n",
      'dist/bundle.test.js': "it('built', () => {})\n",
    });
    const rels = alarm.repoTestFiles(repo).map(([rel]) => rel);
    expect(rels).toContain('tests/real.test.js');
    expect(
      rels.some((r) => r.includes('node_modules') || r.startsWith('dist/')),
    ).toBe(false);
  });

  it('does not alarm when the deletion is unrelated to any area', () => {
    const tmp = mkTmp();
    const repo = repoWith(tmp, { 'tests/checkout.spec.ts': '// gone\n' });
    const areas = alarm.loadCriticalAreas(
      areasFile(tmp, [
        { path: 'src/loyalty/points.service.ts', risk_score: 0.92 },
      ]),
    );
    expect(
      alarm.buildFindings(diffscan.findDeletions(JS_REMOVAL), areas, repo),
    ).toEqual([]);
  });

  it('low-risk area alarms at high, not critical', () => {
    const tmp = mkTmp();
    const diff = `diff --git a/tests/test_points.py b/tests/test_points.py
--- a/tests/test_points.py
+++ b/tests/test_points.py
@@ -1,3 +1,1 @@
-def test_points_service_earns():
-    assert True
 x = 1
`;
    const repo = repoWith(tmp, { 'tests/test_points.py': 'x = 1\n' });
    const areas = alarm.loadCriticalAreas(
      areasFile(tmp, [
        { path: 'src/loyalty/points.service.ts', risk_score: 0.41 },
      ]),
    );
    const findings = alarm.buildFindings(
      diffscan.findDeletions(diff),
      areas,
      repo,
    );
    expect(findings[0].severity).toBe(alarm.Severity.HIGH);
  });

  it('directory-only match is heuristic and medium', () => {
    const tmp = mkTmp();
    const diff = `diff --git a/tests/loyalty/test_misc.py b/tests/loyalty/test_misc.py
--- a/tests/loyalty/test_misc.py
+++ b/tests/loyalty/test_misc.py
@@ -1,3 +1,1 @@
-def test_something_else():
-    assert True
 x = 1
`;
    const repo = repoWith(tmp, { 'tests/loyalty/test_misc.py': 'x = 1\n' });
    const areas = alarm.loadCriticalAreas(
      areasFile(tmp, [
        { path: 'src/loyalty/points.service.ts', risk_score: 0.92 },
      ]),
    );
    const findings = alarm.buildFindings(
      diffscan.findDeletions(diff),
      areas,
      repo,
    );
    expect(findings.length).toBe(1);
    expect(findings[0].fidelity).toBe(alarm.Fidelity.HEURISTIC);
    expect(findings[0].severity).toBe(alarm.Severity.MEDIUM);
  });

  it('does not alarm when dir coverage remains in the area directory', () => {
    const tmp = mkTmp();
    const diff = `diff --git a/tests/loyalty/test_misc.py b/tests/loyalty/test_misc.py
--- a/tests/loyalty/test_misc.py
+++ b/tests/loyalty/test_misc.py
@@ -1,3 +1,1 @@
-def test_something_else():
-    assert True
 x = 1
`;
    const repo = repoWith(tmp, {
      'tests/loyalty/test_misc.py': 'x = 1\n',
      'tests/loyalty/test_other.py': 'def test_other():\n    pass\n',
    });
    const areas = alarm.loadCriticalAreas(
      areasFile(tmp, [
        { path: 'src/loyalty/points.service.ts', risk_score: 0.92 },
      ]),
    );
    expect(
      alarm.buildFindings(diffscan.findDeletions(diff), areas, repo),
    ).toEqual([]);
  });

  it('keeps the highest-fidelity finding across multiple areas', () => {
    const tmp = mkTmp();
    const diff = `diff --git a/tests/loyalty/test_points.py b/tests/loyalty/test_points.py
--- a/tests/loyalty/test_points.py
+++ b/tests/loyalty/test_points.py
@@ -1,3 +1,1 @@
-def test_points_service_earns():
-    assert True
 x = 1
`;
    const repo = repoWith(tmp, { 'tests/loyalty/test_points.py': 'x = 1\n' });
    const areas = alarm.loadCriticalAreas(
      areasFile(tmp, [
        { path: 'src/loyalty/points.service.ts', risk_score: 0.92 },
        { path: 'src/loyalty/refunds.gateway.ts', risk_score: 0.92 },
      ]),
    );
    const findings = alarm.buildFindings(
      diffscan.findDeletions(diff),
      areas,
      repo,
    );
    expect(findings.length).toBe(1);
    expect(findings[0].fidelity).toBe(alarm.Fidelity.NAME_MATCHED);
    expect(findings[0].severity).toBe(alarm.Severity.CRITICAL);
    expect(findings[0].area).toBe('src/loyalty/points.service.ts');
  });

  it('fidelity rank orders name-match above heuristic', () => {
    expect(alarm.Fidelity.NAME_MATCHED.rank).toBeLessThan(
      alarm.Fidelity.HEURISTIC.rank,
    );
  });

  it('severity sort key orders critical first', () => {
    const ordered = [
      alarm.Severity.MEDIUM,
      alarm.Severity.CRITICAL,
      alarm.Severity.HIGH,
    ].sort((a, b) => a.sortKey - b.sortKey);
    expect(ordered[0]).toBe(alarm.Severity.CRITICAL);
  });

  it('findingToDict is json-safe', () => {
    const payload = alarm.findingToDict({
      kind: 'last-coverage-removed',
      test: 't',
      file: 'tests/t.py',
      area: 'src/a.ts',
      fidelity: alarm.Fidelity.NAME_MATCHED,
      severity: alarm.Severity.HIGH,
      evidence: 'e',
    });
    expect(payload.fidelity).toBe('name-matched');
    expect(payload.severity).toBe('high');
    expect(() => JSON.stringify(payload)).not.toThrow();
  });
});

// --- git plumbing (real fixture repo) --------------------------------------

const git = (repo: string, ...args: string[]) => {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
};

function fixtureRepo(): string {
  const repo = path.join(mkTmp(), 'repo');
  fs.mkdirSync(repo);
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.email', 'ada@example.com');
  git(repo, 'config', 'user.name', 'Ada Lovelace');
  fs.mkdirSync(path.join(repo, 'tests'));
  fs.writeFileSync(
    path.join(repo, 'tests', 'test_points.py'),
    'def test_points_service_earns():\n    assert True\n',
  );
  git(repo, 'add', '-A');
  git(repo, 'commit', '-m', 'test: add points coverage');
  git(repo, 'checkout', '-b', 'feat/drop');
  fs.writeFileSync(path.join(repo, 'tests', 'test_points.py'), 'x = 1\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-m', 'chore: drop points coverage');
  return repo;
}

describe('git plumbing', () => {
  it('resolveBase defaults to the merge-base', () => {
    const repo = fixtureRepo();
    const base = diffscan.resolveBase(repo, null);
    expect(base).toBeTruthy();
    expect(base).not.toBe(diffscan.runGit(repo, 'rev-parse', 'HEAD').trim());
  });

  it('resolveBase honours an explicit ref', () => {
    expect(diffscan.resolveBase(fixtureRepo(), 'main')).toBe('main');
  });

  it('diffText finds the removed test', () => {
    const repo = fixtureRepo();
    const base = diffscan.resolveBase(repo, null);
    const text = diffscan.diffText(repo, base);
    expect(text).toContain('-def test_points_service_earns():');
    expect(diffscan.findDeletions(text).map((d) => d.name)).toEqual([
      'test_points_service_earns',
    ]);
  });

  it('commitForFile returns provenance', () => {
    const repo = fixtureRepo();
    const base = diffscan.resolveBase(repo, null);
    const commit = diffscan.commitForFile(repo, base, 'tests/test_points.py');
    expect(commit).not.toBeNull();
    expect(commit!.author).toBe('Ada Lovelace');
    expect(commit!.subject).toBe('chore: drop points coverage');
    expect(commit!.sha.length).toBe(40);
    expect(commit!.date).toBeTruthy();
  });

  it('commitForFile returns null for an unknown path', () => {
    const repo = fixtureRepo();
    const base = diffscan.resolveBase(repo, null);
    expect(diffscan.commitForFile(repo, base, 'tests/nope.py')).toBeNull();
  });
});

// --- cli -------------------------------------------------------------------

const diffFile = (tmp: string, text: string) => {
  const p = path.join(tmp, 'changes.diff');
  fs.writeFileSync(p, text);
  return p;
};

const captureLog = () => {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((s?: unknown) => {
    out.push(String(s));
  });
  vi.spyOn(console, 'error').mockImplementation((s?: unknown) => {
    err.push(String(s));
  });
  return { out, err };
};

describe('cli', () => {
  it('records deletions and exits zero', () => {
    const tmp = mkTmp();
    const ledgerPath = path.join(tmp, '.canary', 'quarantine.json');
    const { out } = captureLog();
    const code = main([
      '--repo',
      tmp,
      '--diff-file',
      diffFile(tmp, PY_REMOVAL),
      '--ledger',
      ledgerPath,
    ]);
    expect(code).toBe(0);
    expect(out.join('\n')).toContain('2 deletion(s) captured');
    expect(JSON.parse(fs.readFileSync(ledgerPath, 'utf8')).entries.length).toBe(
      2,
    );
  });

  it('degrades loudly without critical areas', () => {
    const tmp = mkTmp();
    const { out, err } = captureLog();
    const code = main([
      '--repo',
      tmp,
      '--diff-file',
      diffFile(tmp, PY_REMOVAL),
      '--ledger',
      path.join(tmp, 'q.json'),
    ]);
    expect(code).toBe(0);
    expect([...out, ...err].join('\n')).toContain(alarm.DEGRADED_NOTICE);
  });

  it('strict stays zero when degraded', () => {
    const tmp = mkTmp();
    const { out } = captureLog();
    const code = main([
      '--repo',
      tmp,
      '--diff-file',
      diffFile(tmp, PY_REMOVAL),
      '--ledger',
      path.join(tmp, 'q.json'),
      '--strict',
    ]);
    expect(code).toBe(0);
    expect(out.join('\n')).toContain(alarm.DEGRADED_NOTICE);
  });

  it('json payload has stable keys', () => {
    const tmp = mkTmp();
    const areas = areasFile(tmp, [
      { path: 'src/loyalty/points.service.ts', risk_score: 0.92 },
    ]);
    const { out } = captureLog();
    main([
      '--repo',
      tmp,
      '--diff-file',
      diffFile(tmp, PY_REMOVAL),
      '--ledger',
      path.join(tmp, 'q.json'),
      '--critical-areas',
      areas,
      '--json',
    ]);
    const payload = JSON.parse(out.join('\n'));
    expect(payload.schema_version).toBe(ledger.SCHEMA_VERSION);
    expect(Array.isArray(payload.captured)).toBe(true);
    expect(Array.isArray(payload.findings)).toBe(true);
    expect(payload.ledger.endsWith('q.json')).toBe(true);
    expect('degraded_notice' in payload).toBe(false);
  });

  it('json includes the degraded notice when unavailable', () => {
    const tmp = mkTmp();
    const { out } = captureLog();
    main([
      '--repo',
      tmp,
      '--diff-file',
      diffFile(tmp, PY_REMOVAL),
      '--ledger',
      path.join(tmp, 'q.json'),
      '--json',
    ]);
    const payload = JSON.parse(out.join('\n'));
    expect(payload.degraded_notice).toContain(alarm.DEGRADED_NOTICE);
    expect(payload.findings).toEqual([]);
  });

  it('strict exits one on a real alarm', () => {
    const tmp = mkTmp();
    const diff = `diff --git a/tests/test_points.py b/tests/test_points.py
--- a/tests/test_points.py
+++ b/tests/test_points.py
@@ -1,3 +1,1 @@
-def test_points_service_earns():
-    assert True
 x = 1
`;
    repoWith(tmp, { 'tests/test_points.py': 'x = 1\n' });
    const areas = areasFile(tmp, [
      { path: 'src/loyalty/points.service.ts', risk_score: 0.92 },
    ]);
    const argsList = [
      '--repo',
      tmp,
      '--diff-file',
      diffFile(tmp, diff),
      '--ledger',
      path.join(tmp, 'q.json'),
      '--critical-areas',
      areas,
    ];
    const { out } = captureLog();
    expect(main(argsList)).toBe(0); // advisory by default
    expect(out.join('\n')).toContain('last coverage');
    expect(main([...argsList, '--strict'])).toBe(1);
  });

  it('no deletions is quiet and zero', () => {
    const tmp = mkTmp();
    const { out } = captureLog();
    const code = main([
      '--repo',
      tmp,
      '--diff-file',
      diffFile(tmp, NON_TEST_FILE),
      '--ledger',
      path.join(tmp, 'q.json'),
      '--strict',
    ]);
    expect(code).toBe(0);
    expect(out.join('\n')).toContain('0 deletion(s) captured');
  });

  it('--no-write leaves the ledger absent', () => {
    const tmp = mkTmp();
    const ledgerPath = path.join(tmp, 'q.json');
    captureLog();
    expect(
      main([
        '--repo',
        tmp,
        '--diff-file',
        diffFile(tmp, PY_REMOVAL),
        '--ledger',
        ledgerPath,
        '--no-write',
      ]),
    ).toBe(0);
    expect(fs.existsSync(ledgerPath)).toBe(false);
  });

  it('missing diff file returns 1', () => {
    const tmp = mkTmp();
    const { err } = captureLog();
    expect(
      main(['--repo', tmp, '--diff-file', path.join(tmp, 'nope.diff')]),
    ).toBe(1);
    expect(err.join('\n')).toContain('canary-katana:');
  });

  it('corrupt ledger returns 1', () => {
    const tmp = mkTmp();
    const bad = path.join(tmp, 'q.json');
    fs.writeFileSync(bad, 'not json');
    const { err } = captureLog();
    expect(
      main([
        '--repo',
        tmp,
        '--diff-file',
        diffFile(tmp, PY_REMOVAL),
        '--ledger',
        bad,
      ]),
    ).toBe(1);
    expect(err.join('\n')).toContain('canary-katana:');
  });

  it('surfaces a git-diff failure as exit 1', () => {
    // No --diff-file: the diff is computed from git. A non-git tmp dir makes
    // base resolution fail, which the CLI surfaces loudly rather than crashing.
    const tmp = mkTmp();
    const { err } = captureLog();
    expect(main(['--repo', tmp])).toBe(1);
    expect(err.join('\n')).toContain('canary-katana: could not read diff:');
  });

  it('uses git when no diff-file is given', () => {
    const repo = fixtureRepo();
    const { out } = captureLog();
    const code = main([
      '--repo',
      repo,
      '--ledger',
      path.join(repo, '.canary', 'quarantine.json'),
    ]);
    expect(code).toBe(0);
    expect(out.join('\n')).toContain('1 deletion(s) captured');
    const entry0 = JSON.parse(
      fs.readFileSync(path.join(repo, '.canary', 'quarantine.json'), 'utf8'),
    ).entries[0];
    expect(entry0.author).toBe('Ada Lovelace');
    expect(entry0.reason).toBe('chore: drop points coverage');
    expect(entry0.test).toBe('test_points_service_earns');
  });

  it('defaults the ledger under .canary', () => {
    const tmp = mkTmp();
    captureLog();
    expect(
      main(['--repo', tmp, '--diff-file', diffFile(tmp, PY_REMOVAL)]),
    ).toBe(0);
    expect(fs.existsSync(path.join(tmp, '.canary', 'quarantine.json'))).toBe(
      true,
    );
  });

  it('provenance is unknown without git', () => {
    const tmp = mkTmp();
    const ledgerPath = path.join(tmp, 'q.json');
    captureLog();
    main([
      '--repo',
      tmp,
      '--diff-file',
      diffFile(tmp, PY_REMOVAL),
      '--ledger',
      ledgerPath,
    ]);
    const e = JSON.parse(fs.readFileSync(ledgerPath, 'utf8')).entries[0];
    expect(e.author).toBe('unknown');
    expect(e.commit).toBe('');
  });
});

// --- skill packaging contract ----------------------------------------------

describe('packaging', () => {
  it('SKILL.md declares the executable contract (node, cli.mjs)', () => {
    const head = fs
      .readFileSync(path.join(SKILL_DIR, 'SKILL.md'), 'utf8')
      .split('---')[1];
    expect(head).toContain('name: canary-katana');
    expect(head).toContain('cli: scripts/cli.mjs');
    expect(head).toContain('node>=20');
  });

  it('scripts are ascii-only (no emoji)', () => {
    for (const name of fs.readdirSync(SCRIPTS)) {
      if (!name.endsWith('.mjs')) continue;
      const text = fs.readFileSync(path.join(SCRIPTS, name), 'utf8');
      // eslint-disable-next-line no-control-regex
      expect(/^[\x00-\x7F]*$/.test(text)).toBe(true);
    }
  });

  it('is self-contained: no engine (agent/) imports', () => {
    for (const name of fs.readdirSync(SCRIPTS)) {
      if (!name.endsWith('.mjs')) continue;
      const text = fs.readFileSync(path.join(SCRIPTS, name), 'utf8');
      expect(text.includes('agent/') || text.includes('agent.')).toBe(false);
    }
  });

  it('the skill dir has no client strings', () => {
    const banned = ['capi' + 'llary', 'cap' + 'well'];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name !== 'node_modules') walk(full);
        } else if (['.mjs', '.md'].includes(path.extname(full))) {
          const text = fs.readFileSync(full, 'utf8').toLowerCase();
          for (const bad of banned) expect(text.includes(bad)).toBe(false);
        }
      }
    };
    walk(SKILL_DIR);
  });
});
