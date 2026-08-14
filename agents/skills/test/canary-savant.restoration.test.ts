// Unit suite for canary-savant's SV003 restoration analysis (#493).
//
// SV003 claims "mutated without restore, so the change persists across
// tests". 37 of its 51 self-scan findings were in files that DO restore
// (save in beforeEach, restore in afterEach), making the `why` factually
// false. The analysis is deliberately conservative -- a false skip hides
// real pollution, so suppression requires positive evidence: a restore of
// the same global family inside a teardown region, or a write-back from a
// snapshot variable that was saved FROM that global.

import { describe, it, expect } from 'vitest';

import {
  classifyMutation,
  analyzeRestoration,
  isSnapshotWriteBack,
} from '../claude-code/canary-savant/scripts/restoration.mjs';
import { stringLiteralRanges } from '../claude-code/canary-savant/scripts/string-literals.mjs';

// Braced bodies on purpose: harness's functionLength heuristic scans for the
// first `{` after a declaration, so a concise arrow here would be "measured"
// as running through the next describe block (#495 round 2).
const classify = (line: string) => {
  return classifyMutation(line, stringLiteralRanges(line));
};

const lines = (text: string) => {
  return text.split('\n');
};

// --- classifyMutation --------------------------------------------------------

describe('classifyMutation', () => {
  it('classifies a dot-key process.env mutation with a literal key', () => {
    expect(classify("process.env.CI = 'true';")).toMatchObject({
      family: 'process.env',
      key: 'CI',
    });
  });

  it('classifies a bracket-literal process.env mutation', () => {
    expect(classify("process.env['ATLASSIAN_URL'] = 'x';")).toMatchObject({
      family: 'process.env',
      key: 'ATLASSIAN_URL',
    });
  });

  it('classifies a computed process.env key as null', () => {
    expect(classify('process.env[v] = saved[v];')).toMatchObject({
      family: 'process.env',
      key: null,
    });
  });

  it('classifies an os.environ mutation', () => {
    expect(classify("os.environ['API_KEY'] = 'x'")).toMatchObject({
      family: 'os.environ',
      key: 'API_KEY',
    });
  });

  it('classifies a computed os.environ key as null', () => {
    expect(classify('os.environ[name] = value')).toMatchObject({
      family: 'os.environ',
      key: null,
    });
  });

  it('classifies a sys.modules mutation', () => {
    expect(classify("sys.modules['foo'] = fake")).toMatchObject({
      family: 'sys.modules',
      key: 'foo',
    });
  });

  it('returns null for a read', () => {
    expect(classify("key = os.environ['API_KEY']")).toBeNull();
  });

  it('returns null for a comparison', () => {
    expect(classify("assert os.environ['K'] == 'x'")).toBeNull();
  });

  it('returns null when the mutation is inside a string literal', () => {
    expect(classify('"process.env.CI = \'x\'"')).toBeNull();
  });
});

// --- isSnapshotWriteBack -----------------------------------------------------

describe('isSnapshotWriteBack', () => {
  it('recognizes a computed write-back from a saved map', () => {
    const text = 'saved[v] = process.env[v];\nprocess.env[v] = saved[v];';
    const mut = classify('process.env[v] = saved[v];')!;
    expect(isSnapshotWriteBack(mut, lines(text))).toBe(true);
  });

  it('recognizes a plain-identifier write-back', () => {
    const text = 'origCI = process.env.CI;\nprocess.env.CI = origCI;';
    const mut = classify('process.env.CI = origCI;')!;
    expect(isSnapshotWriteBack(mut, lines(text))).toBe(true);
  });

  it('recognizes a write-back from os.environ.copy()', () => {
    const text = "old = os.environ.copy()\nos.environ['K'] = old['K']";
    const mut = classify("os.environ['K'] = old['K']")!;
    expect(isSnapshotWriteBack(mut, lines(text))).toBe(true);
  });

  it('recognizes a write-back from dict(os.environ)', () => {
    const text = "old = dict(os.environ)\nos.environ['K'] = old['K']";
    const mut = classify("os.environ['K'] = old['K']")!;
    expect(isSnapshotWriteBack(mut, lines(text))).toBe(true);
  });

  it('recognizes a write-back from a spread snapshot', () => {
    const text = 'const snap = { ...process.env };\nprocess.env.CI = snap.CI;';
    const mut = classify('process.env.CI = snap.CI;')!;
    expect(isSnapshotWriteBack(mut, lines(text))).toBe(true);
  });

  it('rejects a literal RHS', () => {
    const mut = classify("process.env.CI = 'true';")!;
    expect(isSnapshotWriteBack(mut, lines("process.env.CI = 'true';"))).toBe(
      false,
    );
  });

  it('rejects an identifier never saved from the family', () => {
    const text = 'const v = computeValue();\nprocess.env[k] = v;';
    const mut = classify('process.env[k] = v;')!;
    expect(isSnapshotWriteBack(mut, lines(text))).toBe(false);
  });

  it('rejects a save that is an expression, not a pure snapshot', () => {
    const text =
      "const fakeHome = process.env.TMPDIR + '/x';\nprocess.env.HOME = fakeHome;";
    const mut = classify('process.env.HOME = fakeHome;')!;
    expect(isSnapshotWriteBack(mut, lines(text))).toBe(false);
  });

  it('requires the snapshot to come from the SAME family', () => {
    const text = "old = os.environ.copy()\nsys.modules['m'] = old";
    const mut = classify("sys.modules['m'] = old")!;
    expect(isSnapshotWriteBack(mut, lines(text))).toBe(false);
  });

  it('rejects an RHS that is a complex expression', () => {
    const mut = classify('process.env.CI = a || b;')!;
    expect(
      isSnapshotWriteBack(
        mut,
        lines('a = process.env.CI;\nprocess.env.CI = a || b;'),
      ),
    ).toBe(false);
  });
});

// --- analyzeRestoration: JS teardown regions ---------------------------------

describe('analyzeRestoration (JS)', () => {
  it('an afterEach restoring a literal key covers that key only', () => {
    const text = [
      'afterEach(() => {',
      '  if (orig === undefined) delete process.env.CI;',
      '  else process.env.CI = orig;',
      '});',
    ].join('\n');
    const r = analyzeRestoration(text);
    expect(r.restores('process.env', 'CI')).toBe(true);
    expect(r.restores('process.env', 'OTHER')).toBe(false);
    expect(r.restores('process.env', null)).toBe(false);
  });

  it('an afterEach with a computed restore covers the whole family', () => {
    const text = [
      'afterEach(() => {',
      '  for (const v of VARS) {',
      '    if (saved[v] === undefined) delete process.env[v];',
      '    else process.env[v] = saved[v];',
      '  }',
      '});',
    ].join('\n');
    const r = analyzeRestoration(text);
    expect(r.restores('process.env', 'ANYTHING')).toBe(true);
    expect(r.restores('process.env', null)).toBe(true);
    expect(r.restores('os.environ', 'ANYTHING')).toBe(false);
  });

  it('afterAll counts as a teardown region', () => {
    const text = 'afterAll(() => {\n  delete process.env.FLAG;\n});';
    expect(analyzeRestoration(text).restores('process.env', 'FLAG')).toBe(true);
  });

  it('a computed delete covers the family', () => {
    const text = 'afterEach(() => {\n  delete process.env[k];\n});';
    expect(analyzeRestoration(text).restores('process.env', 'ANY')).toBe(true);
  });

  it('Object.assign(process.env, snapshot) covers the family', () => {
    const text = 'afterEach(() => {\n  Object.assign(process.env, snap);\n});';
    expect(analyzeRestoration(text).restores('process.env', 'ANY')).toBe(true);
  });

  it('a restore OUTSIDE any teardown region does not count', () => {
    const text = "it('x', () => {\n  process.env.CI = orig;\n});";
    expect(analyzeRestoration(text).restores('process.env', 'CI')).toBe(false);
  });

  it('an afterEach token inside a string does not open a region', () => {
    const text = [
      "const fixture = 'afterEach(() => {';",
      'delete process.env.CI;',
    ].join('\n');
    expect(analyzeRestoration(text).restores('process.env', 'CI')).toBe(false);
  });

  it('region tracking survives parens inside strings', () => {
    const text = [
      'afterEach(() => {',
      "  log(')(((');",
      '  delete process.env.CI;',
      '});',
      'process.env.LATER = 1;',
    ].join('\n');
    const r = analyzeRestoration(text);
    expect(r.restores('process.env', 'CI')).toBe(true);
  });

  it('an unclosed region is capped and does not swallow the file', () => {
    const far = Array.from({ length: 60 }, (_, i) => `const a${i} = ${i};`);
    const text = [
      'afterEach(() => { broken((',
      ...far,
      'delete process.env.CI;',
    ].join('\n');
    expect(analyzeRestoration(text).restores('process.env', 'CI')).toBe(false);
  });

  // #733: an in-test `try/finally` that saves and restores is STRICTER than an
  // afterEach - the window in which the global is dirty is the try block, not
  // the whole test - but only framework teardown hooks were collected as
  // restore regions, so the tighter idiom was the one that got flagged. The
  // workaround was a permanent savant-ignore pragma on a correct line, and
  // pragmas do not expire.
  it('a finally block restoring the mutated key counts as restoration', () => {
    const text = [
      "it('x', () => {",
      '  const prior = process.env.SUPABASE_ANON_KEY;',
      "  process.env.SUPABASE_ANON_KEY = 'test-anon-key';",
      '  try {',
      '    run();',
      '  } finally {',
      '    if (prior === undefined) delete process.env.SUPABASE_ANON_KEY;',
      '    else process.env.SUPABASE_ANON_KEY = prior;',
      '  }',
      '});',
    ].join('\n');
    expect(
      analyzeRestoration(text).restores('process.env', 'SUPABASE_ANON_KEY'),
    ).toBe(true);
  });

  it('a finally restoring a different key leaves the mutated one flagged', () => {
    const text = [
      "it('x', () => {",
      '  try {',
      '    run();',
      '  } finally {',
      '    delete process.env.OTHER;',
      '  }',
      '});',
    ].join('\n');
    const r = analyzeRestoration(text);
    expect(r.restores('process.env', 'OTHER')).toBe(true);
    expect(r.restores('process.env', 'CI')).toBe(false);
  });

  it('the region ends at the finally block close brace', () => {
    const text = [
      '  } finally {',
      '    delete process.env.CI;',
      '  }',
      "  process.env.LEAKED = 'x';",
    ].join('\n');
    const r = analyzeRestoration(text);
    expect(r.restores('process.env', 'CI')).toBe(true);
    expect(r.restores('process.env', 'LEAKED')).toBe(false);
  });

  it('a finally token inside a string does not open a region', () => {
    const text = ["const fixture = '} finally {';", 'process.env.CI = 1;'].join(
      '\n',
    );
    expect(analyzeRestoration(text).restores('process.env', 'CI')).toBe(false);
  });

  it('an unclosed finally region is capped like the hook regions', () => {
    const far = Array.from({ length: 60 }, (_, i) => `const a${i} = ${i};`);
    const text = ['} finally {', ...far, 'delete process.env.CI;'].join('\n');
    expect(analyzeRestoration(text).restores('process.env', 'CI')).toBe(false);
  });
});

// --- analyzeRestoration: Python teardown regions ------------------------------

describe('analyzeRestoration (Python)', () => {
  it('a teardown_method body restoring a literal key covers it', () => {
    const text = [
      'class TestX:',
      '    def teardown_method(self):',
      "        os.environ['API_KEY'] = self.saved",
      '',
      '    def test_a(self):',
      "        os.environ['OTHER'] = 'x'",
    ].join('\n');
    const r = analyzeRestoration(text);
    expect(r.restores('os.environ', 'API_KEY')).toBe(true);
    expect(r.restores('os.environ', 'OTHER')).toBe(false);
  });

  it('a unittest tearDown with del covers the key', () => {
    const text = [
      'class TestX(unittest.TestCase):',
      '    def tearDown(self):',
      "        del os.environ['FLAG']",
    ].join('\n');
    expect(analyzeRestoration(text).restores('os.environ', 'FLAG')).toBe(true);
  });

  it('teardown ends at dedent: a later mutation is not teardown', () => {
    const text = [
      'def teardown_function():',
      '    pass',
      '',
      'def test_a():',
      "    os.environ['K'] = restore_me",
    ].join('\n');
    expect(analyzeRestoration(text).restores('os.environ', 'K')).toBe(false);
  });

  it('code after a fixture yield is teardown', () => {
    const text = [
      '@pytest.fixture',
      'def env():',
      '    old = os.environ.copy()',
      '    yield',
      '    os.environ.clear()',
      '    os.environ.update(old)',
    ].join('\n');
    expect(analyzeRestoration(text).restores('os.environ', 'ANY')).toBe(true);
  });

  // #733, Python half: `finally:` is indentation-scoped like the `yield` and
  // teardown-def regions, not brace-balanced.
  it('a finally: suite restoring the mutated key counts as restoration', () => {
    const text = [
      'def test_a():',
      "    prior = os.environ.get('API_KEY')",
      '    try:',
      '        run()',
      '    finally:',
      "        os.environ['API_KEY'] = prior",
    ].join('\n');
    const r = analyzeRestoration(text);
    expect(r.restores('os.environ', 'API_KEY')).toBe(true);
  });

  it('a finally: suite ends at dedent', () => {
    const text = [
      'def test_a():',
      '    try:',
      '        run()',
      '    finally:',
      "        del os.environ['API_KEY']",
      '',
      'def test_b():',
      "    os.environ['LEAKED'] = 'x'",
    ].join('\n');
    const r = analyzeRestoration(text);
    expect(r.restores('os.environ', 'API_KEY')).toBe(true);
    expect(r.restores('os.environ', 'LEAKED')).toBe(false);
  });

  it('os.environ.pop with a literal key covers that key', () => {
    const text = "def teardown_method(self):\n    os.environ.pop('K', None)";
    const r = analyzeRestoration(text);
    expect(r.restores('os.environ', 'K')).toBe(true);
    expect(r.restores('os.environ', 'J')).toBe(false);
  });

  it('an addCleanup line is a teardown region of its own', () => {
    const text = 'self.addCleanup(lambda: os.environ.update(saved))';
    expect(analyzeRestoration(text).restores('os.environ', 'ANY')).toBe(true);
  });

  it('sys.modules restoration is tracked as its own family', () => {
    const text = "def teardown_method(self):\n    del sys.modules['fake_mod']";
    const r = analyzeRestoration(text);
    expect(r.restores('sys.modules', 'fake_mod')).toBe(true);
    expect(r.restores('os.environ', 'fake_mod')).toBe(false);
  });
});
