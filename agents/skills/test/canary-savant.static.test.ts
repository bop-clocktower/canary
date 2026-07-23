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
import { fileURLToPath } from 'node:url';

import {
  scanText,
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
  it.each(['setup_method', 'setup_class', 'setUp', 'setUpClass'])(
    'flags pytest %s with no teardown',
    (setup) => {
      const text = `class TestX:\n    def ${setup}(self):\n        self.db = open_db()\n`;
      expect(ids(text)).toContain('SV002-missing-teardown');
    },
  );

  it('does not flag pytest setup that has a teardown', () => {
    const text =
      'class TestX:\n' +
      '    def setup_method(self):\n        self.db = open_db()\n' +
      '    def teardown_method(self):\n        self.db.close()\n';
    expect(ids(text)).not.toContain('SV002-missing-teardown');
  });

  it('flags vitest beforeEach with no afterEach', () => {
    expect(
      ids('beforeEach(() => { db = openDb(); });\n', 'a.spec.ts'),
    ).toContain('SV002-missing-teardown');
  });

  it('does not flag beforeAll paired with afterAll', () => {
    const text =
      'beforeAll(() => { db = openDb(); });\nafterAll(() => { db.close(); });\n';
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
    ['def test_last_cleanup():', 'test_a.py'],
    ['# must run before test_b', 'test_a.py'],
    ["it('creates admin (must run first)', () => {", 'a.spec.ts'],
  ])('flags %s', (line, name) => {
    expect(ids(line, name)).toContain('SV004-order-coupled-name');
  });

  it.each([
    'def test_creates_user():',
    'def test_number_of_items():',
    '# creates a user and asserts the role',
  ])('does not flag ordinary %s', (line) => {
    expect(ids(line, 'test_a.py')).not.toContain('SV004-order-coupled-name');
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
    });
  });

  it('lists findings in human output', () => {
    const root = makeTree(tmp());
    capture();
    expect(main([root])).toBe(0);
    expect(out.join('\n')).toContain('SV001-module-mutable-global');
  });

  it('says so when clean', () => {
    const root = tmp();
    capture();
    expect(main([root])).toBe(0);
    expect(out.join('\n')).toContain('No order-dependence');
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

  it('--strict passes when clean', () => {
    const root = tmp();
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
