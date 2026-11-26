// #1319: katana records skipped tests into its ledger, but nothing CHECKED the
// ledger against the source. A test could be switched off with a static
// `test.skip` / `describe.skip` / `test.describe.skip` and no ledger row, and
// CI stayed green. One consuming repo found 37 tests parked that way.
//
// `--check` walks the test files, finds every STATIC skip marker with katana's
// own skip detection, and fails (exit 1) when one has no ledger row for its
// (file, test). Runtime-conditional skips are exempt: `it.skipIf(cond)`,
// Playwright's `test.skip(cond, why)`, pytest `skipif(cond)`. A scan that read
// zero test files, or a ledger that cannot be read, abstains (exit 3): neither
// is a pass. `--record` appends a row for each unledgered skip, which is the
// fix the failure message prints.

import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { main } from '../claude-code/canary-katana/scripts/cli.mjs';
import { scanSkips } from '../claude-code/canary-katana/scripts/skipscan.mjs';

const tmps: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  while (tmps.length) fs.rmSync(tmps.pop()!, { recursive: true, force: true });
});

/** A throwaway repo holding `files` (repo-relative path -> content). */
function repoWith(files: Record<string, string>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'katana-check-'));
  tmps.push(dir);
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}

function writeLedger(dir: string, entries: object[]) {
  const p = path.join(dir, '.canary', 'quarantine.json');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ schema_version: 2, entries }, null, 2));
  return p;
}

const row = (file: string, test: string, kind = 'skipped') => ({
  test,
  file,
  kind,
  marker: 'it.skip',
});

function run(argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((s?: unknown) => {
    out.push(String(s));
  });
  vi.spyOn(console, 'error').mockImplementation((s?: unknown) => {
    err.push(String(s));
  });
  const code = main(argv);
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const checkJson = (dir: string, extra: string[] = []) => {
  const r = run(['--check', '--repo', dir, '--json', ...extra]);
  return { code: r.code, doc: JSON.parse(r.out) };
};

const CART = `import { describe, it, expect } from 'vitest';

describe('cart', () => {
  it('adds an item', () => {
    expect(1).toBe(1);
  });

  it.skip('parks the cart', () => {
    expect(1).toBe(1);
  });
});
`;

describe('katana --check: unledgered static skips fail', () => {
  it('an it.skip with no ledger row exits 1 and names file:line, title and the fix', () => {
    const dir = repoWith({ 'tests/cart.test.ts': CART });
    const r = run(['--check', '--repo', dir]);
    expect(r.code).toBe(1);
    expect(r.out).toContain('tests/cart.test.ts:8');
    expect(r.out).toContain('parks the cart');
    expect(r.out).toContain('it.skip');
    expect(r.out).toContain('--check --record');
  });

  it('the same skip with a ledger row passes (exit 0)', () => {
    const dir = repoWith({ 'tests/cart.test.ts': CART });
    writeLedger(dir, [row('tests/cart.test.ts', 'parks the cart')]);
    const r = run(['--check', '--repo', dir]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('1 static skip(s)');
    expect(r.out).toContain('1 ledgered');
  });

  it('matching survives a line shift: identity is (file, test), not line', () => {
    const dir = repoWith({ 'tests/cart.test.ts': CART });
    writeLedger(dir, [row('tests/cart.test.ts', 'parks the cart')]);
    fs.writeFileSync(
      path.join(dir, 'tests/cart.test.ts'),
      `// a\n// b\n// c\n// d\n${CART}`,
    );
    const { code, doc } = checkJson(dir);
    expect(code).toBe(0);
    expect(doc.skips).toBe(1);
    expect(doc.ledgered).toBe(1);
  });

  it('a row for the same title in another file does not match', () => {
    const dir = repoWith({ 'tests/cart.test.ts': CART });
    writeLedger(dir, [row('tests/other.test.ts', 'parks the cart')]);
    expect(run(['--check', '--repo', dir]).code).toBe(1);
  });

  it('a `removed` row does not account for a test that is present but skipped', () => {
    const dir = repoWith({ 'tests/cart.test.ts': CART });
    writeLedger(dir, [row('tests/cart.test.ts', 'parks the cart', 'removed')]);
    expect(run(['--check', '--repo', dir]).code).toBe(1);
  });

  it('finds every static idiom, test.describe.skip included', () => {
    const dir = repoWith({
      'e2e/flows.spec.ts': [
        "test.describe.skip('checkout suite', () => {});",
        "describe.skip('legacy block', () => {});",
        "test.skip('static playwright', async () => {});",
        "test.fixme('broken on webkit', async () => {});",
        "xit('jasmine style', () => {});",
        "xdescribe('jasmine block', () => {});",
        'it.skip(`template title`, () => {});',
      ].join('\n'),
    });
    const { code, doc } = checkJson(dir);
    expect(code).toBe(1);
    const titles = doc.unledgered.map((u: { test: string }) => u.test).sort();
    expect(titles).toEqual(
      [
        'broken on webkit',
        'checkout suite',
        'jasmine block',
        'jasmine style',
        'legacy block',
        'static playwright',
        'template title',
      ].sort(),
    );
    const suite = doc.unledgered.find(
      (u: { test: string }) => u.test === 'checkout suite',
    );
    expect(suite).toMatchObject({
      file: 'e2e/flows.spec.ts',
      line: 1,
      marker: 'describe.skip',
    });
  });
});

describe('katana --check: what is not a static skip', () => {
  it('runtime-conditional skips are exempt and counted as such', () => {
    const dir = repoWith({
      'tests/env.test.ts': [
        "it.skipIf(process.env.CI)('needs a display', () => {});",
        "describe.skipIf(!HAS_PYTEST)('pytest block', () => {});",
        "describe.runIf(hasHarness)('harness block', () => {});",
        "test('webkit only', async ({ browserName }) => {",
        "  test.skip(browserName === 'webkit', 'flaky on webkit');",
        '});',
      ].join('\n'),
      'tests/test_env.py': [
        'import pytest, sys',
        '',
        "@pytest.mark.skipif(sys.platform == 'win32', reason='posix only')",
        'def test_posix():',
        '    assert True',
        '',
        "@pytest.mark.xfail(sys.version_info < (3, 12), reason='old')",
        'def test_new_python():',
        '    assert True',
      ].join('\n'),
    });
    const { code, doc } = checkJson(dir);
    expect(code).toBe(0);
    expect(doc.skips).toBe(0);
    expect(doc.exempt).toBe(6);
    expect(doc.checked).toBe(2);
  });

  it('a skip inside a comment, string or template literal is not a marker', () => {
    const dir = repoWith({
      'tests/fixtures-in-code.test.ts': [
        "// it.skip('commented out', () => {});",
        '/* describe.skip("block comment", () => {}); */',
        'const src = "it.skip(\'in a string\', () => {});";',
        "const diff = `+  it.skip('in a template', () => {});`;",
        "it('real test', () => { expect(src + diff).toBeTruthy(); });",
      ].join('\n'),
    });
    const { code, doc } = checkJson(dir);
    expect(code).toBe(0);
    expect(doc.skips).toBe(0);
  });
});

// A committed `.only` mutes every OTHER test in its file or block, so it is
// a switched-off-tests event in its own right. It is not a ledger matter: a
// row cannot make it acceptable.
describe('katana --check: focus markers fail on their own', () => {
  const FOCUS = [
    "it('muted sibling', () => {});",
    "it.only('focused', () => {});",
    "fit('also focused', () => {});",
    "fdescribe('focused block', () => {});",
    "test.describe.only('focused pw block', () => {});",
    "// it.only('commented out', () => {});",
  ].join('\n');

  it('reports each focused marker in its own bucket and exits 1', () => {
    const dir = repoWith({ 'tests/focus.test.ts': FOCUS });
    const { code, doc } = checkJson(dir);
    expect(code).toBe(1);
    expect(doc.skips).toBe(0);
    expect(doc.focused.map((f: { marker: string }) => f.marker)).toEqual([
      'it.only',
      'fit',
      'fdescribe',
      'describe.only',
    ]);
    expect(doc.focused[0]).toMatchObject({
      file: 'tests/focus.test.ts',
      line: 2,
      test: 'focused',
    });
  });

  it('says why in text, and a ledger row does not excuse it', () => {
    const dir = repoWith({
      'tests/focus.test.ts': "it.only('focused', () => {});",
    });
    writeLedger(dir, [row('tests/focus.test.ts', 'focused')]);
    const r = run(['--check', '--repo', dir]);
    expect(r.code).toBe(1);
    expect(r.out).toContain('tests/focus.test.ts:1');
    expect(r.out).toContain('focuses');
    expect(r.out).toContain('remove');
  });
});

describe('katana --check: a literal condition is not a condition', () => {
  it('skipIf(true), runIf(false), test.skip(true) and friends are static', () => {
    const dir = repoWith({
      'tests/literal.test.ts': [
        "it.skipIf(true)('always skipped', () => {});",
        "describe.skipIf(1)('one block', () => {});",
        "describe.runIf(false)('never runs', () => {});",
        "test('pw literal', async () => {",
        "  test.skip(true, 'parked');",
        '});',
        "test('pw negated zero', async () => {",
        '  test.fixme(!0);',
        '});',
        "test('pw callback', async () => {",
        '  test.skip(() => true);',
        '});',
      ].join('\n'),
    });
    const { code, doc } = checkJson(dir);
    expect(code).toBe(1);
    expect(doc.exempt).toBe(0);
    expect(doc.unledgered.map((u: { test: string }) => u.test)).toEqual([
      'always skipped',
      'one block',
      'never runs',
      'pw literal',
      'pw negated zero',
      'pw callback',
    ]);
  });

  it('an argument-less test.skip() mutes its enclosing test, matched by that title', () => {
    const dir = repoWith({
      'e2e/mute.spec.ts': [
        "test('enclosing', async ({ page }) => {",
        '  test.skip();',
        '  await page.goto("/");',
        '});',
      ].join('\n'),
    });
    const first = checkJson(dir);
    expect(first.code).toBe(1);
    expect(first.doc.unledgered[0]).toMatchObject({
      file: 'e2e/mute.spec.ts',
      line: 2,
      test: 'enclosing',
      marker: 'test.skip()',
    });
    writeLedger(dir, [row('e2e/mute.spec.ts', 'enclosing')]);
    expect(checkJson(dir).code).toBe(0);
  });

  it('a file-level test.skip() before any test is recorded as (file)', () => {
    const dir = repoWith({
      'e2e/whole.spec.ts': "test.skip();\ntest('a', async () => {});",
    });
    const { doc } = checkJson(dir);
    expect(doc.unledgered[0]).toMatchObject({ test: '(file)', line: 1 });
  });
});

describe('katana --check: Python', () => {
  const PY = [
    'import pytest',
    '',
    "@pytest.mark.skip(reason='parked')",
    'def test_refund_partial():',
    '    assert True',
    '',
    '@pytest.mark.xfail',
    'def test_refund_rounding():',
    '    assert True',
    '',
    "@pytest.mark.skipif(True, reason='always')",
    '@pytest.mark.slow',
    'async def test_refund_slow():',
    '    assert True',
    '',
    'FIXTURE = """',
    '@pytest.mark.skip',
    'def test_inside_a_docstring():',
    '"""',
    '',
    'def test_runs():',
    '    assert True',
  ].join('\n');

  it('static skip / xfail / skipif(True) are found, a docstring is not', () => {
    const dir = repoWith({ 'tests/test_refunds.py': PY });
    const { code, doc } = checkJson(dir);
    expect(code).toBe(1);
    expect(doc.unledgered.map((u: { test: string }) => u.test)).toEqual([
      'test_refund_partial',
      'test_refund_rounding',
      'test_refund_slow',
    ]);
    expect(doc.unledgered[0]).toMatchObject({
      file: 'tests/test_refunds.py',
      line: 3,
    });
  });

  it('ledgering the three rows passes', () => {
    const dir = repoWith({ 'tests/test_refunds.py': PY });
    writeLedger(
      dir,
      ['test_refund_partial', 'test_refund_rounding', 'test_refund_slow'].map(
        (t) => row('tests/test_refunds.py', t),
      ),
    );
    expect(checkJson(dir).code).toBe(0);
  });
});

describe('katana --check: abstention is never a pass', () => {
  it('zero test files scanned exits 3', () => {
    const dir = repoWith({ 'src/app.ts': "it.skip('not a test file', f);" });
    const r = run(['--check', '--repo', dir]);
    expect(r.code).toBe(3);
    expect(r.out).toContain('0 test file(s)');
    expect(r.out).toContain('not a pass');
  });

  it('a malformed ledger exits 3 with the reason, never 0', () => {
    const dir = repoWith({ 'tests/cart.test.ts': CART });
    fs.mkdirSync(path.join(dir, '.canary'));
    fs.writeFileSync(path.join(dir, '.canary', 'quarantine.json'), '{nope');
    const r = run(['--check', '--repo', dir]);
    expect(r.code).toBe(3);
    expect(r.err).toContain('ledger is not valid JSON');
  });

  it('a malformed ledger with no skips at all still abstains', () => {
    const dir = repoWith({ 'tests/ok.test.ts': "it('ok', () => {});" });
    fs.mkdirSync(path.join(dir, '.canary'));
    fs.writeFileSync(path.join(dir, '.canary', 'quarantine.json'), '[]');
    const { code, doc } = checkJson(dir);
    expect(code).toBe(3);
    expect(doc.abstained).toBe(true);
    expect(doc.error).toContain('top level must be an object');
  });

  it('paths that match no test file abstain', () => {
    const dir = repoWith({ 'tests/cart.test.ts': CART });
    expect(run(['--check', '--repo', dir, 'nowhere']).code).toBe(3);
  });

  it('one typo among good paths still abstains, naming the unmatched path', () => {
    const dir = repoWith({ 'tests/ok.test.ts': "it('ok', () => {});" });
    const r = run(['--check', '--repo', dir, 'tests', 'tsets']);
    expect(r.code).toBe(3);
    expect(r.out).toContain('tsets');
    const { code, doc } = checkJson(dir, ['tests', 'tsets']);
    expect(code).toBe(3);
    expect(doc.abstained).toBe(true);
    expect(doc.unmatched).toEqual(['tsets']);
  });
});

// The family rule (ADR 0009): a real finding proves a check ran, so it
// outranks an abstention. The abstention is still printed.
describe('katana --check: a finding outranks an abstention', () => {
  it('an unledgered skip under a matched PATH exits 1 even with a typo PATH', () => {
    const dir = repoWith({ 'tests/cart.test.ts': CART });
    const r = run(['--check', '--repo', dir, 'tests', 'tsets']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('parks the cart');
    expect(r.out).toContain("'tsets'");
    const { code, doc } = checkJson(dir, ['tests', 'tsets']);
    expect(code).toBe(1);
    expect(doc.unmatched).toEqual(['tsets']);
    expect(doc.abstained).toBe(true);
  });

  it('a focused marker exits 1 even with a typo PATH', () => {
    const dir = repoWith({ 'tests/f.test.ts': "it.only('f', () => {});" });
    const r = run(['--check', '--repo', dir, 'tests', 'tsets']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('focuses');
    expect(r.out).toContain("'tsets'");
  });

  it('a focused marker exits 1 with an unreadable ledger, and says the ledger could not be read', () => {
    const dir = repoWith({ 'tests/f.test.ts': "it.only('f', () => {});" });
    fs.mkdirSync(path.join(dir, '.canary'));
    fs.writeFileSync(path.join(dir, '.canary', 'quarantine.json'), '{nope');
    const r = run(['--check', '--repo', dir]);
    expect(r.code).toBe(1);
    expect(r.out).toContain('focuses');
    expect(r.out).toContain('ledger cannot be read');
  });

  it('an unreadable ledger still abstains on static skips alone: they cannot be matched', () => {
    const dir = repoWith({ 'tests/cart.test.ts': CART });
    fs.mkdirSync(path.join(dir, '.canary'));
    fs.writeFileSync(path.join(dir, '.canary', 'quarantine.json'), '{nope');
    const r = run(['--check', '--repo', dir]);
    expect(r.code).toBe(3);
    expect(r.out).not.toContain('has no ledger row');
  });
});

// Enabling --check's PATHs turned on the shared parser's `--` terminator. A
// bare `--` in diff mode is accepted (it was a usage error before #1319).
describe('katana diff mode: a bare `--` is accepted', () => {
  it('runs the diff capture as if `--` were absent', () => {
    const dir = repoWith({ 'README.md': 'x\n' });
    const df = path.join(dir, 'changes.diff');
    fs.writeFileSync(
      df,
      'diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1,1 +1,1 @@\n-a\n+b\n',
    );
    const r = run(['--repo', dir, '--diff-file', df, '--no-write', '--']);
    expect(r.code).toBe(0);
    expect(r.err).not.toContain('unrecognized');
    expect(r.out).toContain('0 deletion(s) captured');
  });
});

describe('katana --check: --json and paths', () => {
  it('emits {checked, skips, ledgered, unledgered[]}', () => {
    const dir = repoWith({
      'tests/cart.test.ts': CART,
      'tests/more.test.ts': "it.skip('second', () => {});",
    });
    writeLedger(dir, [row('tests/more.test.ts', 'second')]);
    const { code, doc } = checkJson(dir);
    expect(code).toBe(1);
    expect(doc).toMatchObject({
      checked: 2,
      skips: 2,
      ledgered: 1,
      exempt: 0,
      focused: [],
      unmatched: [],
      abstained: false,
    });
    expect(doc.unledgered).toHaveLength(1);
    expect(doc.unledgered[0]).toMatchObject({
      file: 'tests/cart.test.ts',
      line: 8,
      test: 'parks the cart',
      marker: 'it.skip',
    });
    expect(doc.unledgered[0].fix).toContain('--check --record');
  });

  it('positional paths narrow the scan to those files or directories', () => {
    const dir = repoWith({
      'tests/cart.test.ts': CART,
      'other/tests/more.test.ts': "it('fine', () => {});",
    });
    const { code, doc } = checkJson(dir, ['other']);
    expect(code).toBe(0);
    expect(doc.checked).toBe(1);
  });

  it('a positional without --check is still an unrecognized argument', () => {
    const r = run(['stray']);
    expect(r.code).toBe(2);
    expect(r.err).toContain('unrecognized arguments: stray');
  });

  it('--record without --check is a usage error', () => {
    const r = run(['--record']);
    expect(r.code).toBe(2);
    expect(r.err).toContain('--record requires --check');
  });
});

describe('katana --check --record: the printed fix works', () => {
  it('records each unledgered skip, after which the check passes', () => {
    const dir = repoWith({ 'tests/cart.test.ts': CART });
    const first = checkJson(dir);
    expect(first.code).toBe(1);
    // Run the fix exactly as printed, minus the runner prefix.
    const fix: string = first.doc.unledgered[0].fix;
    const argv = fix
      .replace(/^canary skills run canary-katana -- /, '')
      .split(' ')
      .map((t) => (t === '.' ? dir : t));
    const rec = run([...argv, '--repo', dir]);
    expect(rec.code).toBe(0);
    expect(rec.out).toContain('recorded 1');
    const entries = JSON.parse(
      fs.readFileSync(path.join(dir, '.canary', 'quarantine.json'), 'utf8'),
    ).entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      test: 'parks the cart',
      file: 'tests/cart.test.ts',
      kind: 'skipped',
      marker: 'it.skip',
      cause: '',
    });
    expect(run(['--check', '--repo', dir]).code).toBe(0);
  });

  it('takes provenance from the commit that added the marker line', () => {
    const dir = repoWith({ 'tests/cart.test.ts': CART });
    const git = (...a: string[]) =>
      spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
    git('init', '-q');
    git('-c', 'user.name=Ada', '-c', 'user.email=a@example.com', 'add', '.');
    git(
      '-c',
      'user.name=Ada',
      '-c',
      'user.email=a@example.com',
      'commit',
      '-q',
      '-m',
      'test: park the cart\n\nTicket: CART-12',
    );
    expect(run(['--check', '--record', '--repo', dir]).code).toBe(0);
    const [entry] = JSON.parse(
      fs.readFileSync(path.join(dir, '.canary', 'quarantine.json'), 'utf8'),
    ).entries;
    expect(entry.author).toBe('Ada');
    expect(entry.reason).toBe('test: park the cart');
    expect(entry.issue).toBe('CART-12');
    expect(entry.commit).toMatch(/^[0-9a-f]{40}$/);
  });

  it('never overwrites a malformed ledger', () => {
    const dir = repoWith({ 'tests/cart.test.ts': CART });
    fs.mkdirSync(path.join(dir, '.canary'));
    const p = path.join(dir, '.canary', 'quarantine.json');
    fs.writeFileSync(p, '{nope');
    expect(run(['--check', '--record', '--repo', dir]).code).toBe(3);
    expect(fs.readFileSync(p, 'utf8')).toBe('{nope');
  });
});

describe('scanSkips', () => {
  it('reports the denominator of files read', () => {
    const dir = repoWith({
      'tests/a.test.ts': "it('a', () => {});",
      'tests/b.test.ts': CART,
      'tests/notes.md': "it.skip('markdown is not a test file', f);",
    });
    const scan = scanSkips(dir, []);
    expect(scan.files).toBe(2);
    expect(scan.skips).toHaveLength(1);
  });
});
