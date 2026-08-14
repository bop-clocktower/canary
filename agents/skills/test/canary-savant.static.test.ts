// Tier-1 static-scan suite for canary-savant (Phase 1), ported from Python to
// vitest as the skill moves to JS (canary mirrors harness, which is TS/Node).
//
// canary-savant surfaces order-dependence and shared-state leakage. Phase 1 is
// the always-on static "suspect" tier: an AST-lite scanner flagging the smells
// that predict order-dependent tests, with no test execution. Rules SV001-SV004,
// framework-conditioned by file extension (pytest idioms in Python, vitest/jest
// in JS/TS).

import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  scanText,
  scanTextFull,
  scanPaths,
  toJson,
  SNIPPET_LIMIT,
} from '../claude-code/canary-savant/scripts/scanner.mjs';
import {
  RULES,
  SEVERITIES,
} from '../claude-code/canary-savant/scripts/rules.mjs';
import { main } from '../claude-code/canary-savant/scripts/cli.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.join(HERE, '..', 'claude-code', 'canary-savant');
const SCRIPTS = path.join(SKILL_DIR, 'scripts');

const scan = (text: string, name = 'test_a.py') => scanText(text, name);
const ids = (text: string, name = 'test_a.py') =>
  new Set(scan(text, name).map((f) => f.ruleId));

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'savant-'));
}

// --- SV001 -----------------------------------------------------------------

describe('SV001 module-mutable-global', () => {
  it('flags a module dict mutated by a test, on the declaration line', () => {
    const findings = scan(
      "_CACHE = {}\n\ndef test_a():\n    _CACHE['k'] = 1\n",
    );
    const sv1 = findings.find(
      (f) => f.ruleId === 'SV001-module-mutable-global',
    );
    expect(sv1).toBeDefined();
    expect(sv1!.line).toBe(1);
  });

  it.each([
    ['_ITEMS = []', '    _ITEMS.append(x)'],
    ['_SEEN = set()', '    _SEEN.add(x)'],
    ['_MAP = dict()', "    _MAP['k'] = 1"],
    ['_ACC = []', '    _ACC += [1]'],
  ])('flags mutable %s mutated by %s', (decl, mutate) => {
    expect(ids(`${decl}\n\ndef test_a():\n${mutate}\n`)).toContain(
      'SV001-module-mutable-global',
    );
  });

  it('does not flag a module mutable that is only read', () => {
    expect(
      ids(
        "_LOOKUP = {'a': 1}\n\ndef test_a():\n    assert _LOOKUP['a'] == 1\n",
      ),
    ).not.toContain('SV001-module-mutable-global');
  });

  it('does not treat a function-local mutable as module scope', () => {
    expect(
      ids("def test_a():\n    cache = {}\n    cache['k'] = 1\n"),
    ).not.toContain('SV001-module-mutable-global');
  });

  it('flags a top-level JS let that is mutated', () => {
    expect(
      ids(
        "let cache = {};\n\nit('a', () => { cache.foo = 1; });\n",
        'a.spec.ts',
      ),
    ).toContain('SV001-module-mutable-global');
  });

  it('does not flag an immutable primitive const', () => {
    expect(
      ids(
        "const MAX = 5;\n\nit('a', () => { expect(MAX).toBe(5); });\n",
        'a.spec.ts',
      ),
    ).not.toContain('SV001-module-mutable-global');
  });
});

// --- SV002 -----------------------------------------------------------------

describe('SV002 missing-teardown', () => {
  // Only CLASS/ALL-scoped setup leaks (shared across a class's tests). Per-test
  // setup (setUp/setup_method/beforeEach) rebuilds state each test, so a missing
  // teardown there is not a leak - and firing on it was the top false-positive
  // source when dogfooding on canary's own suite (Phase 5).
  it.each(['setup_class', 'setUpClass'])(
    'flags class-scoped pytest %s with no teardown',
    (setup) => {
      const text = `class TestX:\n    def ${setup}(cls):\n        cls.db = open_db()\n`;
      expect(ids(text)).toContain('SV002-missing-teardown');
    },
  );

  it.each(['setUp', 'setup_method'])(
    'does not flag per-test pytest %s (fresh instance per test)',
    (setup) => {
      const text = `class TestX:\n    def ${setup}(self):\n        self.db = open_db()\n`;
      expect(ids(text)).not.toContain('SV002-missing-teardown');
    },
  );

  it('does not flag class setup that has a teardown', () => {
    const text =
      'class TestX:\n' +
      '    def setup_class(cls):\n        cls.db = open_db()\n' +
      '    def teardown_class(cls):\n        cls.db.close()\n';
    expect(ids(text)).not.toContain('SV002-missing-teardown');
  });

  it('flags vitest beforeAll with no afterAll', () => {
    expect(
      ids('beforeAll(() => { db = openDb(); });\n', 'a.spec.ts'),
    ).toContain('SV002-missing-teardown');
  });

  it('does not flag per-test beforeEach', () => {
    expect(
      ids('beforeEach(() => { db = openDb(); });\n', 'a.spec.ts'),
    ).not.toContain('SV002-missing-teardown');
  });

  it('does not flag beforeAll paired with afterAll', () => {
    const text =
      'beforeAll(() => { db = openDb(); });\nafterAll(() => { db.close(); });\n';
    expect(ids(text, 'a.spec.ts')).not.toContain('SV002-missing-teardown');
  });

  // #732: the teardown-presence half of the pair searched RAW file text while
  // the setup half already skipped comments, so any file that merely MENTIONED
  // the teardown token in prose exempted itself - silently, since an
  // ungenerated finding never appears in the `N suppressed` line. A rule that
  // prose can switch off is not a gate, and this one runs --strict in CI.
  it('flags beforeAll when afterAll appears only in a comment', () => {
    const text =
      '// nothing an afterAll could release\n' +
      'beforeAll(() => { db = openDb(); });\n';
    expect(ids(text, 'a.spec.ts')).toContain('SV002-missing-teardown');
  });

  it('flags beforeAll when afterAll appears only in a string literal', () => {
    const text =
      "const doc = 'pair every beforeAll with an afterAll';\n" +
      'beforeAll(() => { db = openDb(); });\n';
    expect(ids(text, 'a.spec.ts')).toContain('SV002-missing-teardown');
  });

  it('flags class setup when teardown_class appears only in a comment', () => {
    const text =
      'class TestX:\n' +
      '    # a teardown_class would have nothing to close here\n' +
      '    def setup_class(cls):\n        cls.db = open_db()\n';
    expect(ids(text)).toContain('SV002-missing-teardown');
  });

  it('still clears when afterAll is real code on a commented-up file', () => {
    const text =
      '// pair beforeAll with afterAll\n' +
      'beforeAll(() => { db = openDb(); });\n' +
      'afterAll(() => { db.close(); });\n';
    expect(ids(text, 'a.spec.ts')).not.toContain('SV002-missing-teardown');
  });

  it('clears when afterAll is code trailing a comment on one line', () => {
    const text =
      'beforeAll(() => { db = openDb(); });\n' +
      'afterAll(() => { db.close(); }); // release the handle\n';
    expect(ids(text, 'a.spec.ts')).not.toContain('SV002-missing-teardown');
  });
});

// --- SV003 -----------------------------------------------------------------

describe('SV003 shared-singleton-mutation', () => {
  it.each([
    ["os.environ['API_KEY'] = 'x'", 'test_a.py'],
    ['os.environ["API_KEY"] = \'x\'', 'test_a.py'],
    ["sys.modules['foo'] = fake", 'test_a.py'],
    ["process.env.API_KEY = 'x';", 'a.spec.ts'],
  ])('flags %s', (line, name) => {
    expect(ids(line, name)).toContain('SV003-shared-singleton-mutation');
  });

  it.each([
    "monkeypatch.setenv('API_KEY', 'x')",
    "key = os.environ['API_KEY']",
    "assert os.environ['API_KEY'] == 'x'",
  ])('does not flag restored/read-only access %s', (line) => {
    expect(ids(line, 'test_a.py')).not.toContain(
      'SV003-shared-singleton-mutation',
    );
  });
});

// --- SV004 -----------------------------------------------------------------

describe('SV004 order-coupled-name', () => {
  it.each([
    ['def test_1_creates_user():', 'test_a.py'],
    ['def test_first():', 'test_a.py'],
    ['def test_last():', 'test_a.py'],
    // savant-ignore SV004 -- fixture: comment-directive input this rule detects
    ['# must run before test_b', 'test_a.py'],
    // savant-ignore SV004 -- fixture: it-title directive input this rule detects
    ["it('creates admin (must run first)', () => {", 'a.spec.ts'],
  ])('flags %s', (line, name) => {
    expect(ids(line, name)).toContain('SV004-order-coupled-name');
  });

  // Ordinal WORDS used as adjectives are not ordering directives. These were
  // false positives on canary's own suite (Phase 5): the ordinal must be the
  // terminal segment of the name (test_first(), not test_first_match_wins()).
  it.each([
    'def test_creates_user():',
    'def test_number_of_items():',
    'def test_first_match_wins():',
    'def test_second_run_updates_in_place():',
    'def test_third_party_gets_reminder():',
    '# creates a user and asserts the role',
  ])('does not flag ordinary %s', (line) => {
    expect(ids(line, 'test_a.py')).not.toContain('SV004-order-coupled-name');
  });
});

// --- SV003 restoration suppression (#493) ------------------------------------
//
// SV003's why asserts persistence ("the change persists across tests"), so a
// file that restores the global in teardown must not be flagged -- 37 of 51
// self-scan findings were the textbook save-in-beforeEach / restore-in-
// afterEach pattern. Suppression needs positive evidence (same family, same
// key or a computed loop restore, inside a teardown region or a snapshot
// write-back); anything less stays flagged, because a false skip hides real
// pollution.

describe('SV003 restoration suppression (#493)', () => {
  it('does not flag the save/restore loop pattern (ci-env shape)', () => {
    const text = [
      'const saved = {};',
      'beforeEach(() => {',
      '  for (const v of VARS) {',
      '    saved[v] = process.env[v];',
      '    delete process.env[v];',
      '  }',
      '});',
      'afterEach(() => {',
      '  for (const v of VARS) {',
      '    if (saved[v] === undefined) delete process.env[v];',
      '    else process.env[v] = saved[v];',
      '  }',
      '});',
      "it('x', () => {",
      "  process.env.CI = 'true';",
      '  expect(isCi()).toBe(true);',
      '});',
    ].join('\n');
    expect(ids(text, 'a.spec.ts')).not.toContain(
      'SV003-shared-singleton-mutation',
    );
  });

  it('does not flag a literal-key mutation restored by a literal-key afterEach', () => {
    const text = [
      'afterEach(() => {',
      '  if (origCI === undefined) delete process.env.CI;',
      '  else process.env.CI = origCI;',
      '});',
      "it('x', () => {",
      "  process.env.CI = 'true';",
      '});',
    ].join('\n');
    expect(ids(text, 'a.spec.ts')).not.toContain(
      'SV003-shared-singleton-mutation',
    );
  });

  it('still flags a mutation of a key the teardown does not restore', () => {
    const text = [
      'afterEach(() => {',
      '  delete process.env.CI;',
      '});',
      "it('x', () => {",
      "  process.env.OTHER = 'leaks';",
      '});',
    ].join('\n');
    expect(ids(text, 'a.spec.ts')).toContain('SV003-shared-singleton-mutation');
  });

  it('still flags a genuinely unrestored mutation (no teardown at all)', () => {
    expect(ids("process.env.API_KEY = 'x';", 'a.spec.ts')).toContain(
      'SV003-shared-singleton-mutation',
    );
  });

  it('a restore-shaped assignment outside teardown does not launder a mutation', () => {
    const text = [
      "it('x', () => {",
      "  process.env.CI = 'true';",
      "  process.env.CI = 'later';",
      '});',
    ].join('\n');
    expect(ids(text, 'a.spec.ts')).toContain('SV003-shared-singleton-mutation');
  });

  it('does not flag the snapshot write-back line itself (testkit shape)', () => {
    const text = [
      'const savedEnv = {};',
      'for (const k of KEYS) savedEnv[k] = process.env[k];',
      'function restore() {',
      '  for (const k of KEYS) {',
      '    if (savedEnv[k] === undefined) delete process.env[k];',
      '    else process.env[k] = savedEnv[k];',
      '  }',
      '}',
    ].join('\n');
    expect(ids(text, 'a.spec.ts')).not.toContain(
      'SV003-shared-singleton-mutation',
    );
  });

  it('does not flag a pytest teardown-restored os.environ mutation', () => {
    const text = [
      'class TestX:',
      '    def setup_method(self):',
      "        self.saved = os.environ.get('API_KEY')",
      '    def teardown_method(self):',
      "        os.environ['API_KEY'] = self.saved",
      '    def test_a(self):',
      "        os.environ['API_KEY'] = 'x'",
    ].join('\n');
    expect(ids(text)).not.toContain('SV003-shared-singleton-mutation');
  });

  it('does not flag a yield-fixture-restored os.environ mutation', () => {
    const text = [
      '@pytest.fixture(autouse=True)',
      'def env():',
      '    old = os.environ.copy()',
      '    yield',
      '    os.environ.clear()',
      '    os.environ.update(old)',
      '',
      'def test_a():',
      "    os.environ['API_KEY'] = 'x'",
    ].join('\n');
    expect(ids(text)).not.toContain('SV003-shared-singleton-mutation');
  });

  it('an os.environ teardown does not launder a sys.modules mutation', () => {
    const text = [
      'def teardown_function():',
      '    os.environ.clear()',
      '',
      'def test_a():',
      "    sys.modules['fake'] = stub",
    ].join('\n');
    expect(ids(text)).toContain('SV003-shared-singleton-mutation');
  });
});

// --- String-literal rejection (#493) ----------------------------------------
//
// SV003's anchor (os.environ / process.env / sys.modules) is code, so a match
// starting inside a string literal is fixture data -- the dominant self-scan
// false positive. SV004 is split: name-pattern alternatives (ordinal-indexed
// or ordinal-named defs) are code-anchored and get the same rejection;
// directive-text alternatives (must-run-before notes, it-titles) deliberately
// live inside strings and comments, so they stay unfiltered. This comment
// spells those triggers with hyphens so savant's self-scan does not flag its
// own suite's documentation.

describe('string-literal rejection (#493)', () => {
  it.each([
    ["[\"os.environ['API_KEY'] = 'x'\", 'test_a.py'],", 'a.spec.ts'],
    ["\"    os.environ['SAVANT_FLAG'] = '1'\",", 'a.spec.ts'],
    ["const f = scan(\"os.environ['X'] = '1'\")[0];", 'a.spec.ts'],
    ["'process.env.API_KEY = 1;',", 'a.spec.ts'],
    ["fs.writeFileSync(p, \"os.environ['X'] = '1'\\n\");", 'a.spec.ts'],
  ])('does not flag SV003 fixture data %s', (line, name) => {
    expect(ids(line, name)).not.toContain('SV003-shared-singleton-mutation');
  });

  it('retries past an in-string match to a later code match', () => {
    const line = "const s = 'process.env.A = 1'; process.env.B = 'x';";
    expect(ids(line, 'a.spec.ts')).toContain('SV003-shared-singleton-mutation');
  });

  it.each([
    ["['def test_1_creates_user():', 'test_a.py'],", 'a.spec.ts'],
    ["['def test_first():', 'test_a.py'],", 'a.spec.ts'],
    ["['def test_last():', 'test_a.py'],", 'a.spec.ts'],
  ])('does not flag SV004 name-pattern fixture data %s', (line, name) => {
    expect(ids(line, name)).not.toContain('SV004-order-coupled-name');
  });

  // Directive text stays string-native by design: titles and docstrings ARE
  // strings in real code, and comments carry the note.
  it.each([
    // savant-ignore SV004 -- fixture: it-title directive input, kept visible
    ["it('creates admin (must run first)', () => {", 'a.spec.ts'],
    // savant-ignore SV004 -- fixture: docstring directive input, kept visible
    ['"""must run before test_b"""', 'test_a.py'],
    // savant-ignore SV004 -- fixture: comment directive input, kept visible
    ['# must run before test_b', 'test_a.py'],
  ])('still flags directive text %s', (line, name) => {
    expect(ids(line, name)).toContain('SV004-order-coupled-name');
  });

  it('still flags a real ordinal test def (code position)', () => {
    expect(ids('def test_first():', 'test_a.py')).toContain(
      'SV004-order-coupled-name',
    );
  });

  it('still flags a genuine singleton mutation (code position)', () => {
    expect(ids("os.environ['API_KEY'] = 'x'", 'test_a.py')).toContain(
      'SV003-shared-singleton-mutation',
    );
  });
});

// --- Inline suppression pragma (#496) ----------------------------------------
//
// Mirrors canary-blackhawk's `blackhawk-ignore` (#393) so a user moving
// between the two skills learns one dialect: `savant-ignore <RULE>[,<RULE>]
// -- reason`, rule-scoped, reason mandatory, covering the pragma's own line
// and the next. One deliberate extra: the pragma anchor is string-literal
// guarded (#493 style), because THIS suite carries pragma text inside fixture
// strings and data must never act as a directive. Runtime fixture text below
// is assembled by concatenation so this file's own source lines never carry a
// live directive phrase (savant dogfoods this suite).

describe('inline suppression pragma (#496)', () => {
  const ruleIds = (found: { ruleId: string }[]) => {
    return found.map((f) => f.ruleId);
  };
  // '# must ... test_b' assembled at runtime; the source line stays inert.
  const directive = ['#', 'must run', 'before test_b'].join(' ');

  it('suppresses a rule via a same-line trailing pragma', () => {
    const r = scanTextFull(
      `${directive}  # savant-ignore SV004 -- fixture: directive-text input`,
      'test_a.py',
    );
    expect(ruleIds(r.findings)).not.toContain('SV004-order-coupled-name');
    expect(ruleIds(r.suppressed)).toContain('SV004-order-coupled-name');
  });

  it('suppresses a finding on the following line', () => {
    const text =
      '# savant-ignore SV004 -- fixture: directive-text input\n' + directive;
    const r = scanTextFull(text, 'test_a.py');
    expect(r.findings).toEqual([]);
    expect(r.suppressed.length).toBe(1);
  });

  it('requires a reason (a bare directive does not suppress)', () => {
    const r = scanTextFull(`${directive}  # savant-ignore SV004`, 'test_a.py');
    expect(ruleIds(r.findings)).toContain('SV004-order-coupled-name');
    expect(r.suppressed).toEqual([]);
  });

  it('is rule-scoped: an SV003 pragma does not silence SV004 on the line', () => {
    const r = scanTextFull(
      `${directive}  # savant-ignore SV003 -- unrelated`,
      'test_a.py',
    );
    expect(ruleIds(r.findings)).toContain('SV004-order-coupled-name');
    expect(r.suppressed).toEqual([]);
  });

  it('a pragma naming no rule suppresses nothing', () => {
    const r = scanTextFull(
      `${directive}  # savant-ignore -- blanket attempt`,
      'test_a.py',
    );
    expect(ruleIds(r.findings)).toContain('SV004-order-coupled-name');
    expect(r.suppressed).toEqual([]);
  });

  it('accepts the full rule id', () => {
    const r = scanTextFull(
      `${directive}  # savant-ignore SV004-order-coupled-name -- fixture`,
      'test_a.py',
    );
    expect(r.suppressed.length).toBe(1);
    expect(r.findings).toEqual([]);
  });

  it('suppresses a code-rule finding too (SV003, trailing pragma)', () => {
    const r = scanTextFull(
      "os.environ['API_KEY'] = 'x'  # savant-ignore SV003 -- fixture env",
      'test_a.py',
    );
    expect(ruleIds(r.findings)).not.toContain(
      'SV003-shared-singleton-mutation',
    );
    expect(ruleIds(r.suppressed)).toContain('SV003-shared-singleton-mutation');
  });

  it('directive text without a pragma still flags (true-positive guard)', () => {
    const title = ['must run', 'before b'].join(' ');
    const r = scanTextFull(`test('${title}', () => {});`, 'a.spec.ts');
    expect(ruleIds(r.findings)).toContain('SV004-order-coupled-name');
    expect(r.suppressed).toEqual([]);
  });

  it('a pragma inside a string literal on the line above is inert', () => {
    const text = [
      "const s = 'x  # savant-ignore SV003 -- not a directive';",
      "process.env.API_KEY = 'x';",
    ].join('\n');
    const r = scanTextFull(text, 'a.spec.ts');
    expect(ruleIds(r.findings)).toContain('SV003-shared-singleton-mutation');
    expect(r.suppressed).toEqual([]);
  });

  it('a pragma inside a string literal on the finding line is inert', () => {
    const r = scanTextFull(
      "process.env.A = 'savant-ignore SV003 -- nope';",
      'a.spec.ts',
    );
    expect(ruleIds(r.findings)).toContain('SV003-shared-singleton-mutation');
    expect(r.suppressed).toEqual([]);
  });

  it('scanPaths counts suppressions separately from findings', () => {
    const root = mkTmp();
    try {
      // The leak comes FIRST: a pragma also covers its next line, so the
      // unsuppressed mutation must not sit directly under it.
      fs.writeFileSync(
        path.join(root, 'test_a.py'),
        "os.environ['B'] = 'x'\n" +
          "os.environ['A'] = 'x'  # savant-ignore SV003 -- fixture env\n",
      );
      const r = scanPaths([root]);
      expect(r.findings.length).toBe(1);
      expect(r.findings[0].ruleId).toBe('SV003-shared-singleton-mutation');
      expect(r.suppressed).toBe(1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('cli reports the suppressed count (human + json)', () => {
    const root = mkTmp();
    const out: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((s?: unknown) => {
      out.push(String(s));
    });
    try {
      fs.writeFileSync(
        path.join(root, 'test_a.py'),
        "os.environ['A'] = 'x'  # savant-ignore SV003 -- fixture env\n",
      );
      expect(main([root, '--json'])).toBe(0);
      expect(JSON.parse(out.join('\n')).summary.suppressed).toBe(1);
      out.length = 0;
      expect(main([root])).toBe(0);
      const text = out.join('\n');
      expect(text).toContain('No order-dependence suspects');
      expect(text).toContain('1 suppressed (inline savant-ignore)');
    } finally {
      vi.restoreAllMocks();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('cli keeps the suppressed note after a non-empty findings list', () => {
    const root = mkTmp();
    const out: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((s?: unknown) => {
      out.push(String(s));
    });
    try {
      fs.writeFileSync(
        path.join(root, 'test_a.py'),
        "os.environ['B'] = 'x'\n" +
          "os.environ['A'] = 'x'  # savant-ignore SV003 -- fixture env\n",
      );
      expect(main([root])).toBe(0);
      const text = out.join('\n');
      expect(text).toContain('1 order-dependence suspect');
      expect(text).toContain('1 suppressed (inline savant-ignore)');
    } finally {
      vi.restoreAllMocks();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('--strict ignores suppressed findings (exit 0)', () => {
    const root = mkTmp();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      fs.writeFileSync(
        path.join(root, 'test_a.py'),
        "os.environ['A'] = 'x'  # savant-ignore SV003 -- fixture env\n",
      );
      expect(main([root, '--strict'])).toBe(0);
    } finally {
      vi.restoreAllMocks();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

// --- Finding shape ---------------------------------------------------------

describe('finding shape', () => {
  it('carries file, line, severity, snippet, why', () => {
    const f = scan(
      '_ITEMS = []\n\ndef test_a():\n    _ITEMS.append(1)\n',
      'tests/state.py',
    ).find((x) => x.ruleId === 'SV001-module-mutable-global')!;
    expect(f.file).toBe('tests/state.py');
    expect(f.line).toBe(1);
    expect(SEVERITIES).toContain(f.severity);
    expect(f.snippet).toBe('_ITEMS = []');
    expect(f.why).toBeTruthy();
    expect(f.why).not.toContain('\n');
  });

  it('toJson has exactly the documented keys', () => {
    const f = scan("os.environ['X'] = '1'")[0];
    expect(Object.keys(toJson(f)).sort()).toEqual(
      ['file', 'line', 'rule_id', 'severity', 'snippet', 'why'].sort(),
    );
  });

  it('truncates the snippet for very long lines', () => {
    const f = scan("os.environ['X'] = '1'  # " + 'x'.repeat(500))[0];
    expect(f.snippet.length).toBeLessThanOrEqual(SNIPPET_LIMIT);
  });

  it('does not flag commented-out code', () => {
    expect(ids("# os.environ['X'] = '1'").size).toBe(0);
    expect(ids("// process.env.X = '1';", 'a.spec.ts').size).toBe(0);
  });

  it('every rule declares id, severity, why', () => {
    expect(RULES.length).toBeGreaterThan(0);
    for (const r of RULES) {
      expect(r.ruleId.startsWith('SV')).toBe(true);
      expect(SEVERITIES).toContain(r.severity);
      expect(r.why).toBeTruthy();
    }
  });

  it('rule ids are unique', () => {
    const idsArr = RULES.map((r) => r.ruleId);
    expect(new Set(idsArr).size).toBe(idsArr.length);
  });
});

// --- Path selection --------------------------------------------------------

function makeTree(root: string) {
  fs.mkdirSync(path.join(root, 'tests'));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(
    path.join(root, 'tests', 'state.spec.ts'),
    "let cache = {};\n\nit('a', () => { cache.x = 1; });\n",
  );
  fs.writeFileSync(
    path.join(root, 'tests', 'test_state.py'),
    '_ITEMS = []\n\ndef test_a():\n    _ITEMS.append(1)\n',
  );
  fs.writeFileSync(
    path.join(root, 'src', 'app.py'),
    '_G = []\n\ndef go():\n    _G.append(1)\n',
  );
  fs.writeFileSync(path.join(root, 'notes.txt'), "os.environ['X'] = '1'\n");
  return root;
}

describe('path selection', () => {
  const tmps: string[] = [];
  const tmp = () => {
    const d = mkTmp();
    tmps.push(d);
    return d;
  };
  afterEach(() => {
    while (tmps.length)
      fs.rmSync(tmps.pop()!, { recursive: true, force: true });
  });

  it('directory scan only visits test files', () => {
    const result = scanPaths([makeTree(tmp())]);
    const files = new Set(result.findings.map((f) => path.basename(f.file)));
    expect(files).toEqual(new Set(['state.spec.ts', 'test_state.py']));
    expect(result.filesScanned).toBe(2);
  });

  it('scans an explicitly named non-test file anyway', () => {
    const root = makeTree(tmp());
    const result = scanPaths([path.join(root, 'src', 'app.py')]);
    expect(result.filesScanned).toBe(1);
    expect(result.findings.length).toBe(1);
  });

  it('never scans an unsupported extension', () => {
    const root = makeTree(tmp());
    const result = scanPaths([path.join(root, 'notes.txt')]);
    expect(result.filesScanned).toBe(0);
    expect(result.findings).toEqual([]);
  });

  it('skips an undecodable file without throwing', () => {
    const root = tmp();
    fs.writeFileSync(
      path.join(root, 'weird.spec.ts'),
      Buffer.from([0xff, 0xfe, 0x00, 0x6c, 0x65, 0x74]),
    );
    expect(() => scanPaths([root])).not.toThrow();
    expect(scanPaths([root]).findings).toEqual([]);
  });

  it('orders findings by file then line', () => {
    const root = tmp();
    fs.writeFileSync(
      path.join(root, 'b.spec.ts'),
      "let a = {};\nit('x', () => { a.k = 1; });\n",
    );
    fs.writeFileSync(
      path.join(root, 'a.spec.ts'),
      "let a = {};\nit('x', () => { a.k = 1; });\n",
    );
    const names = scanPaths([root]).findings.map((f) => path.basename(f.file));
    expect(names).toEqual([...names].sort());
  });

  it('never descends into dependency directories', () => {
    const root = tmp();
    const vendored = path.join(root, 'node_modules', 'pkg');
    fs.mkdirSync(vendored, { recursive: true });
    fs.writeFileSync(
      path.join(vendored, 'thing.spec.ts'),
      "let a = {};\nit('x', () => { a.k = 1; });\n",
    );
    const result = scanPaths([root]);
    expect(result.filesScanned).toBe(0);
    expect(result.findings).toEqual([]);
  });

  it('never descends into fixture directories — fixture files are test DATA', () => {
    // Mirrors blackhawk: a file under fixtures/ never RUNS as a test, so
    // order-dependence smells in it are data, not defects (#493, one level up).
    const root = tmp();
    for (const dir of ['fixtures', '__fixtures__', '__mocks__', 'testdata']) {
      const d = path.join(root, dir, 'nested');
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(
        path.join(d, 'test_smelly.py'),
        "import os\n\ndef test_a():\n    os.environ['K'] = '1'\n",
      );
    }
    const result = scanPaths([root]);
    expect(result.filesScanned).toBe(0);
    expect(result.findings).toEqual([]);
  });

  it('scans overlapping paths exactly once', () => {
    const root = tmp();
    const p = path.join(root, 'test_state.py');
    fs.writeFileSync(p, '_G = []\n\ndef test_a():\n    _G.append(1)\n');
    const result = scanPaths([root, p]);
    expect(result.filesScanned).toBe(1);
    expect(result.findings.length).toBe(1);
  });
});

// --- CLI -------------------------------------------------------------------

describe('cli', () => {
  const tmps: string[] = [];
  const tmp = () => {
    const d = mkTmp();
    tmps.push(d);
    return d;
  };
  let out: string[];
  let err: string[];
  afterEach(() => {
    vi.restoreAllMocks();
    while (tmps.length)
      fs.rmSync(tmps.pop()!, { recursive: true, force: true });
  });
  const capture = () => {
    out = [];
    err = [];
    vi.spyOn(console, 'log').mockImplementation((s?: unknown) => {
      out.push(String(s));
    });
    vi.spyOn(console, 'error').mockImplementation((s?: unknown) => {
      err.push(String(s));
    });
  };

  it('emits the documented JSON shape', () => {
    const root = makeTree(tmp());
    capture();
    const rc = main([root, '--json']);
    expect(rc).toBe(0);
    const payload = JSON.parse(out.join('\n'));
    expect(payload.schema_version).toBe(1);
    expect(payload.summary.files_scanned).toBe(2);
    expect(payload.summary.findings).toBeGreaterThanOrEqual(2);
    expect(Object.keys(payload.findings[0]).sort()).toEqual(
      ['file', 'line', 'rule_id', 'severity', 'snippet', 'why'].sort(),
    );
  });

  it('emits valid JSON when there are no findings', () => {
    const root = tmp();
    capture();
    const rc = main([root, '--json']);
    expect(rc).toBe(0);
    const payload = JSON.parse(out.join('\n'));
    expect(payload.findings).toEqual([]);
    expect(payload.summary).toEqual({
      files_scanned: 0,
      findings: 0,
      by_severity: {},
      suppressed: 0,
    });
  });

  it('lists findings in human output', () => {
    const root = makeTree(tmp());
    capture();
    expect(main([root])).toBe(0);
    expect(out.join('\n')).toContain('SV001-module-mutable-global');
  });

  // #508 Wave 4b: this used to point at an EMPTY temp dir, asserting a green
  // all-clear over ZERO scanned files -- the silent-abstention shape restated
  // as a test. A genuine clean run needs a real, unremarkable file.
  const cleanFile = (root: string): string => {
    fs.writeFileSync(
      path.join(root, 'clean.spec.ts'),
      "it('adds', () => { expect(1 + 1).toBe(2); });\n",
    );
    return root;
  };

  it('says so when clean, and states its denominator', () => {
    const root = cleanFile(tmp());
    capture();
    expect(main([root])).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('No order-dependence');
    expect(text).toContain('1 file scanned');
    expect(text).not.toContain('Abstained');
  });

  it('zero scanned files ABSTAINS, never a clean bill of health', () => {
    const root = tmp();
    capture();
    expect(main([root])).toBe(0); // advisory by default (D3)
    const text = out.join('\n');
    expect(text).toContain('Abstained');
    expect(text).not.toContain('No order-dependence');
  });

  it('--strict over zero scanned files exits 3, not 0', () => {
    const root = tmp();
    capture();
    expect(main([root, '--strict'])).toBe(3);
  });

  it('is advisory by default (exit 0 with findings)', () => {
    const root = makeTree(tmp());
    capture();
    expect(main([root])).toBe(0);
  });

  it('--strict fails on findings', () => {
    const root = makeTree(tmp());
    capture();
    expect(main([root, '--strict'])).toBe(1);
  });

  it('--strict passes when genuinely clean', () => {
    const root = cleanFile(tmp());
    capture();
    expect(main([root, '--strict'])).toBe(0);
  });

  it('returns 1 for a missing path', () => {
    const root = tmp();
    capture();
    expect(main([path.join(root, 'nope')])).toBe(1);
    expect(err.join('\n')).toContain('not found');
  });

  it('defaults to cwd when no path given', () => {
    const root = makeTree(tmp());
    const cwd = process.cwd();
    process.chdir(root);
    try {
      capture();
      expect(main([])).toBe(0);
      expect(out.join('\n')).toContain('SV001-module-mutable-global');
    } finally {
      process.chdir(cwd);
    }
  });

  // --- argparse-parity surface: --help, unknown flags, `--` ----------------

  it('--help prints usage and exits zero', () => {
    capture();
    expect(main(['--help'])).toBe(0);
    expect(out.join('\n')).toContain('usage: canary-savant');
    expect(err.join('\n')).toBe('');
  });

  it('-h is the same as --help', () => {
    capture();
    expect(main(['-h'])).toBe(0);
    expect(out.join('\n')).toContain('usage: canary-savant');
  });

  // Anti-drift: the rules block is generated from RULES, so a new rule cannot
  // land behind a stale hand-typed help text.
  it('usage lists every rule id', () => {
    capture();
    expect(main(['--help'])).toBe(0);
    const text = out.join('\n');
    for (const rule of RULES) expect(text).toContain(rule.ruleId);
  });

  it('rejects an unknown flag with exit 2 before touching the filesystem', () => {
    capture();
    expect(main(['--bogus'])).toBe(2);
    const text = err.join('\n');
    expect(text).toContain('unrecognized');
    expect(text).toContain('--bogus');
    expect(text).not.toContain('path not found');
  });

  it('-h short-circuits even when a bad path is also given', () => {
    capture();
    expect(main(['/definitely/not/here', '--help'])).toBe(0);
  });

  it('`--` stops flag parsing so a dash-leading path is a path', () => {
    capture();
    expect(main(['--', '--json'])).toBe(1);
    expect(err.join('\n')).toContain('path not found: --json');
  });

  it('a lone `-` is a positional, not a flag', () => {
    capture();
    expect(main(['-'])).toBe(1);
    expect(err.join('\n')).toContain('path not found: -');
  });

  it('still accepts a bare path with --json and --strict (regression)', () => {
    const root = makeTree(tmp());
    capture();
    expect(main([root, '--json', '--strict'])).toBe(1);
    expect(JSON.parse(out.join('\n')).summary.findings).toBeGreaterThanOrEqual(
      2,
    );
  });

  // --- --seed arity --------------------------------------------------------

  // Not cosmetic: `--seed` with no value used to be Number(undefined) -> NaN,
  // which fell through to a RANDOM seed. A determinism flag that silently
  // randomizes is a correctness bug, so it must be a usage error instead.
  it('--seed with no value is a usage error (exit 2), not a random seed', () => {
    // Scoped to a tmp dir: parsing must fail before the scan, so a repo-wide
    // walk (or a dynamic suite run) never starts.
    const root = tmp();
    capture();
    expect(main([root, '--confirm', '--seed'])).toBe(2);
    expect(err.join('\n')).toContain('argument --seed: expected one argument');
    // Proof it did not silently randomize: the dynamic tier never ran.
    expect(out.join('\n')).not.toContain('Tier 2 (dynamic)');
  });

  it('--seed followed by another flag is a usage error', () => {
    const root = tmp();
    capture();
    expect(main([root, '--seed', '--json'])).toBe(2);
    expect(err.join('\n')).toContain('argument --seed: expected one argument');
  });

  // No --confirm case here on purpose. Driving --confirm through main() runs
  // the REAL confirm(), whose detectShufflePlugin() interrogates the ambient
  // python3 rather than this repo -- so on a machine with pytest-randomly
  // installed it shells out to `python3 -m pytest` three times and asserting
  // "skipped" fails. It also writes a fixed $TMPDIR/savant-junit.xml, which
  // collides under parallel workers. canary-savant.seed.test.ts stubs the
  // confirmer and covers the real property (the seed asked for is the seed
  // used) deterministically.
});

// --- Packaging -------------------------------------------------------------

describe('packaging', () => {
  it('SKILL.md declares the executable contract (node, cli.mjs)', () => {
    const text = fs.readFileSync(path.join(SKILL_DIR, 'SKILL.md'), 'utf8');
    const head = text.split('---')[1];
    expect(head).toContain('name: canary-savant');
    expect(head).toContain('cli: scripts/cli.mjs');
    expect(head).toContain('node>=20');
  });

  // The skill runner spawns the `cli:` target directly (ts/src/skills-cli.ts
  // execs the file, relying on its shebang), so a cli.mjs without the exec bit
  // makes the documented `canary skills run canary-savant -- --help` fail with no
  // output at all. Assert the bit AND a real spawn, not just the file's text.
  it('cli.mjs is executable and runs when spawned directly', () => {
    const cli = path.join(SCRIPTS, 'cli.mjs');
    expect(fs.statSync(cli).mode & 0o111).toBeTruthy();
    const res = spawnSync(cli, ['--help'], { encoding: 'utf8' });
    expect(res.error).toBeUndefined();
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('usage:');
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
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== 'node_modules') walk(full);
        } else if (['.mjs', '.md'].includes(path.extname(full))) {
          const text = fs.readFileSync(full, 'utf8').toLowerCase();
          for (const bad of banned) expect(text.includes(bad)).toBe(false);
        }
      }
    };
    walk(SKILL_DIR);
  });
});
