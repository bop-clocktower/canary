// Unit suite for the canary-blackhawk skill, ported from Python to vitest as
// the skill moves to JS (canary mirrors harness, which is TS/Node). Behavior is
// preserved from the Python version; the pragma (#393) lands in a follow-on
// commit.

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
  frozenClockMarkers,
  toJson,
  SNIPPET_LIMIT,
} from '../claude-code/canary-blackhawk/scripts/scanner.mjs';
import {
  RULES,
  SEVERITIES,
} from '../claude-code/canary-blackhawk/scripts/rules.mjs';
import { main } from '../claude-code/canary-blackhawk/scripts/cli.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.join(HERE, '..', 'claude-code', 'canary-blackhawk');
const SCRIPTS = path.join(SKILL_DIR, 'scripts');

const scan = (text: string, name = 'a.spec.ts') => scanText(text, name);
const ids = (text: string, name = 'a.spec.ts') =>
  new Set(scan(text, name).map((f) => f.ruleId));
const mkTmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'blackhawk-'));

// --- BH001 wall clock ------------------------------------------------------

describe('BH001 wall-clock', () => {
  it.each([
    ['const t = Date.now();', 'a.spec.ts'],
    ['const d = new Date();', 'a.spec.ts'],
    ['const m = moment();', 'a.spec.ts'],
    ['now = datetime.now()', 'test_a.py'],
    ['now = datetime.today()', 'test_a.py'],
    ['now = datetime.utcnow()', 'test_a.py'],
    ['now = datetime.datetime.now()', 'test_a.py'],
    ['today = date.today()', 'test_a.py'],
    ['start = time.time()', 'test_a.py'],
    ['ts = pd.Timestamp.now()', 'test_a.py'],
  ])('flags %s', (line, name) => {
    expect(ids(line, name)).toContain('BH001-wall-clock');
  });

  it.each([
    ["const d = new Date('2024-01-01T00:00:00Z');", 'a.spec.ts'],
    ['const d = new Date(1704067200000);', 'a.spec.ts'],
    ["const m = moment('2024-01-01');", 'a.spec.ts'],
    ['d = datetime(2024, 1, 1)', 'test_a.py'],
  ])('does not flag pinned constructor %s', (line, name) => {
    expect(ids(line, name)).not.toContain('BH001-wall-clock');
  });
});

// --- BH002 real delay ------------------------------------------------------

describe('BH002 real-delay', () => {
  it.each([
    ['time.sleep(2)', 'test_a.py'],
    ['time.sleep(0.5)', 'test_a.py'],
    ['await new Promise((r) => setTimeout(r, 500));', 'a.spec.ts'],
    ['setTimeout(done, 1000);', 'a.spec.ts'],
  ])('flags %s', (line, name) => {
    expect(ids(line, name)).toContain('BH002-real-delay');
  });

  it.each([
    ['time.sleep(0)', 'test_a.py'],
    ['setTimeout(done, 0);', 'a.spec.ts'],
    ['setTimeout(done, delayMs);', 'a.spec.ts'],
  ])('does not flag zero/symbolic delay %s', (line, name) => {
    expect(ids(line, name)).not.toContain('BH002-real-delay');
  });

  it('flags an underscore-separated delay', () => {
    expect(ids('time.sleep(1_000)', 'test_a.py')).toContain('BH002-real-delay');
  });
});

// --- BH003 local timezone --------------------------------------------------

describe('BH003 local-timezone', () => {
  it.each([
    ["expect(d.toLocaleString()).toBe('1/1/2024');", 'a.spec.ts'],
    ["expect(d.toLocaleDateString()).toBe('1/1/2024');", 'a.spec.ts'],
    ["expect(d.toLocaleTimeString()).toBe('12:00:00 AM');", 'a.spec.ts'],
    ["assert d.strftime('%Y %Z') == 'UTC'", 'test_a.py'],
    ["assert d.strftime('%z') == '+0000'", 'test_a.py'],
  ])('flags %s', (line, name) => {
    expect(ids(line, name)).toContain('BH003-local-timezone');
  });

  it('does not flag UTC formatting', () => {
    expect(
      ids("expect(d.toISOString()).toBe('2024-01-01T00:00:00.000Z');"),
    ).toEqual(new Set());
  });

  it('does not flag strftime without a tz directive', () => {
    expect(
      ids("assert d.strftime('%Y-%m-%d') == '2024-01-01'", 'test_a.py'),
    ).not.toContain('BH003-local-timezone');
  });
});

// --- BH004 naive datetime compare ------------------------------------------

describe('BH004 naive-datetime-compare', () => {
  it.each([
    'assert result == datetime(2024, 1, 1)',
    'assert result < datetime.datetime(2024, 3, 10, 2, 30)',
    "assert parsed == datetime.strptime('2024-01-01', '%Y-%m-%d')",
  ])('flags %s', (line) => {
    expect(ids(line, 'test_a.py')).toContain('BH004-naive-datetime-compare');
  });

  it.each([
    'assert result == datetime(2024, 1, 1, tzinfo=timezone.utc)',
    'assert result == datetime(2024, 1, 1, tzinfo=pytz.UTC)',
  ])('does not flag tz-aware %s', (line) => {
    expect(ids(line, 'test_a.py')).not.toContain(
      'BH004-naive-datetime-compare',
    );
  });

  it('does not double-fire on a wall-clock line', () => {
    expect(ids('assert result == datetime.now()', 'test_a.py')).toEqual(
      new Set(['BH001-wall-clock']),
    );
  });

  it('does not flag construction without comparison', () => {
    expect(ids('d = datetime(2024, 1, 1)', 'test_a.py')).toEqual(new Set());
  });
});

// --- String-literal rejection (#493) ----------------------------------------
//
// A match whose START INDEX falls inside a string literal is data, not code
// (the dominant self-scan false positive: detectors flagging their own test
// fixtures). A match that merely CONTAINS a string (strftime('..%Z')) keeps
// firing, because its anchor token is code.

describe('string-literal rejection (#493)', () => {
  it.each([
    ["const f = pyFile('time.sleep(1)\\n');", 'a.spec.ts'],
    ["'setTimeout(fn, 100);',", 'a.spec.ts'],
    ["'const t = Date.now();',", 'a.spec.ts'],
    ["[\"assert d.strftime('%Y %Z') == 'UTC'\", 'test_a.py'],", 'a.spec.ts'],
    [
      '"vi.useFakeTimers();\\nexpect(d.toLocaleString()).toBe(\'x\');";',
      'a.spec.ts',
    ],
    [
      "const findings = lint('b.spec.ts', 'setTimeout(() => waitFor(x), 10);');",
      'a.spec.ts',
    ],
  ])('does not flag fixture data %s', (line, name) => {
    expect(ids(line, name)).toEqual(new Set());
  });

  // True positives that must survive: the anchor is code even when the
  // pattern's tail reaches into a string.
  it('still flags strftime whose tz directive is inside the quotes', () => {
    expect(ids("assert d.strftime('%Y %Z') == 'UTC'", 'test_a.py')).toContain(
      'BH003-local-timezone',
    );
  });

  it('still flags a real await-setTimeout delay', () => {
    expect(
      ids('await new Promise((r) => setTimeout(r, 5));', 'a.spec.ts'),
    ).toContain('BH002-real-delay');
  });

  it('still flags Date.now inside a template interpolation (code region)', () => {
    expect(ids('const t = `now: ${Date.now()}`;', 'a.spec.ts')).toContain(
      'BH001-wall-clock',
    );
  });

  it('retries past an in-string match to a later code match on the line', () => {
    expect(
      ids("const s = 'Date.now()'; const t = Date.now();", 'a.spec.ts'),
    ).toContain('BH001-wall-clock');
  });

  it('rejects an anchor after an unterminated quote (multi-line string opener)', () => {
    expect(ids('x = "opened here time.sleep(1)', 'test_a.py')).toEqual(
      new Set(),
    );
  });
});

// --- Frozen-clock suppression ----------------------------------------------

describe('frozen-clock suppression', () => {
  it.each([
    ['vi.useFakeTimers();', 'a.spec.ts'],
    ['jest.useFakeTimers();', 'a.spec.ts'],
    ["jest.setSystemTime(new Date('2024-01-01'));", 'a.spec.ts'],
    ['sinon.useFakeTimers();', 'a.spec.ts'],
    ["MockDate.set('2024-01-01');", 'a.spec.ts'],
    ["@freeze_time('2024-01-01')", 'test_a.py'],
    ['from freezegun import freeze_time', 'test_a.py'],
    ['import time_machine', 'test_a.py'],
  ])('marker %s suppresses wall-clock findings', (marker, name) => {
    const usage = name.endsWith('.ts')
      ? 'const t = Date.now();'
      : 'now = datetime.now()';
    expect(ids(usage, name)).toContain('BH001-wall-clock'); // control
    expect(ids(`${marker}\n${usage}`, name)).toEqual(new Set());
  });

  it('suppresses real delays too', () => {
    const text =
      'vi.useFakeTimers();\nawait new Promise((r) => setTimeout(r, 500));';
    expect(ids(text)).toEqual(new Set());
  });

  it('does not suppress timezone findings', () => {
    const text =
      "vi.useFakeTimers();\nexpect(d.toLocaleString()).toBe('1/1/2024');";
    expect(ids(text)).toEqual(new Set(['BH003-local-timezone']));
  });

  it('is file-wide even when the marker trails the usage', () => {
    const text =
      'const t = Date.now();\nbeforeEach(() => { vi.useFakeTimers(); });';
    expect(ids(text)).toEqual(new Set());
  });

  it('frozenClockMarkers reports the matched markers', () => {
    expect(frozenClockMarkers('vi.useFakeTimers();')).toEqual([
      'vi.useFakeTimers',
    ]);
    expect(frozenClockMarkers('const t = Date.now();')).toEqual([]);
  });
});

// --- Finding shape ---------------------------------------------------------

describe('finding shape', () => {
  it('carries file, line, severity, snippet, why', () => {
    const findings = scan(
      'const a = 1;\nconst t = Date.now();\n',
      'tests/clock.spec.ts',
    );
    expect(findings.length).toBe(1);
    const f = findings[0];
    expect(f.file).toBe('tests/clock.spec.ts');
    expect(f.line).toBe(2);
    expect(f.ruleId).toBe('BH001-wall-clock');
    expect(f.severity).toBe('high');
    expect(f.snippet).toBe('const t = Date.now();');
    expect(f.why).toBeTruthy();
    expect(f.why).not.toContain('\n');
  });

  it('toJson has exactly the documented keys', () => {
    const f = scan('const t = Date.now();')[0];
    expect(Object.keys(toJson(f)).sort()).toEqual(
      ['file', 'line', 'rule_id', 'severity', 'snippet', 'why'].sort(),
    );
  });

  it('truncates the snippet for very long lines', () => {
    const f = scan('const t = Date.now(); // ' + 'x'.repeat(500))[0];
    expect(f.snippet.length).toBeLessThanOrEqual(SNIPPET_LIMIT);
  });

  it.each([
    ['// const t = Date.now();', 'a.spec.ts'],
    ['  * const t = Date.now();', 'a.spec.ts'],
    ['# now = datetime.now()', 'test_a.py'],
  ])('does not flag commented-out code %s', (line, name) => {
    expect(ids(line, name)).toEqual(new Set());
  });

  it('every rule declares id, severity, why', () => {
    expect(RULES.length).toBeGreaterThan(0);
    for (const r of RULES) {
      expect(r.ruleId.startsWith('BH')).toBe(true);
      expect(SEVERITIES).toContain(r.severity);
      expect(r.why).toBeTruthy();
    }
  });

  it('rule ids are unique', () => {
    const arr = RULES.map((r) => r.ruleId);
    expect(new Set(arr).size).toBe(arr.length);
  });
});

// --- File / path selection -------------------------------------------------

function tree(root: string) {
  fs.mkdirSync(path.join(root, 'tests'));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(
    path.join(root, 'tests', 'clock.spec.ts'),
    'const t = Date.now();\n',
  );
  fs.writeFileSync(
    path.join(root, 'tests', 'test_clock.py'),
    'now = datetime.now()\n',
  );
  fs.writeFileSync(path.join(root, 'src', 'app.ts'), 'const t = Date.now();\n');
  fs.writeFileSync(path.join(root, 'notes.txt'), 'Date.now()\n');
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
    const result = scanPaths([tree(tmp())]);
    const files = new Set(result.findings.map((f) => path.basename(f.file)));
    expect(files).toEqual(new Set(['clock.spec.ts', 'test_clock.py']));
    expect(result.filesScanned).toBe(2);
  });

  it('scans an explicit non-test file anyway', () => {
    const root = tree(tmp());
    const result = scanPaths([path.join(root, 'src', 'app.ts')]);
    expect(result.filesScanned).toBe(1);
    expect(result.findings.length).toBe(1);
  });

  it('never scans an unsupported extension', () => {
    const root = tree(tmp());
    const result = scanPaths([path.join(root, 'notes.txt')]);
    expect(result.filesScanned).toBe(0);
    expect(result.findings).toEqual([]);
  });

  it('empty directory yields no findings', () => {
    const result = scanPaths([tmp()]);
    expect(result.filesScanned).toBe(0);
    expect(result.findings).toEqual([]);
  });

  it('skips an undecodable file without throwing', () => {
    const root = tmp();
    fs.writeFileSync(
      path.join(root, 'weird.spec.ts'),
      Buffer.from([0xff, 0xfe, 0x00, 0x44, 0x61, 0x74, 0x65]),
    );
    expect(() => scanPaths([root])).not.toThrow();
    expect(scanPaths([root]).findings).toEqual([]);
  });

  it('orders findings by file then line', () => {
    const root = tmp();
    fs.writeFileSync(
      path.join(root, 'b.spec.ts'),
      'const t = Date.now();\ntime.sleep(1)\n',
    );
    fs.writeFileSync(path.join(root, 'a.spec.ts'), 'const t = Date.now();\n');
    const rows = scanPaths([root]).findings.map((f) => [
      path.basename(f.file),
      f.line,
    ]);
    expect(rows).toEqual([
      ['a.spec.ts', 1],
      ['b.spec.ts', 1],
      ['b.spec.ts', 2],
    ]);
  });

  it('never descends into dependency directories', () => {
    const root = tmp();
    const vendored = path.join(root, 'node_modules', 'pkg');
    fs.mkdirSync(vendored, { recursive: true });
    fs.writeFileSync(
      path.join(vendored, 'thing.spec.ts'),
      'const t = Date.now();\n',
    );
    const result = scanPaths([root]);
    expect(result.filesScanned).toBe(0);
    expect(result.findings).toEqual([]);
  });

  it('never descends into fixture directories — fixture files are test DATA', () => {
    // A file under fixtures/ never RUNS as a test, so it cannot be flaky; a
    // deliberately-smelly lint-target fixture is data, not a defect. Same
    // category error #493 fixed for string literals, one level up. Also the
    // pragmatic reason: such fixtures are often pinned by frozen goldens whose
    // line numbers a pragma comment would shift.
    const root = tmp();
    for (const dir of ['fixtures', '__fixtures__', '__mocks__', 'testdata']) {
      const d = path.join(root, dir, 'nested');
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(
        path.join(d, 'smelly.spec.ts'),
        'const t = Date.now();\nsetTimeout(() => go(), 500);\n',
      );
    }
    const result = scanPaths([root]);
    expect(result.filesScanned).toBe(0);
    expect(result.findings).toEqual([]);
  });

  it('scans overlapping paths exactly once', () => {
    const root = tmp();
    const p = path.join(root, 'clock.spec.ts');
    fs.writeFileSync(p, 'const t = Date.now();\n');
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
  afterEach(() => {
    vi.restoreAllMocks();
    while (tmps.length)
      fs.rmSync(tmps.pop()!, { recursive: true, force: true });
  });

  it('emits the documented JSON shape', () => {
    const root = tree(tmp());
    capture();
    expect(main([root, '--json'])).toBe(0);
    const payload = JSON.parse(out.join('\n'));
    expect(payload.schema_version).toBe(1);
    expect(payload.summary.files_scanned).toBe(2);
    expect(payload.summary.findings).toBe(2);
    expect(payload.summary.by_severity.high).toBe(2);
    expect(Object.keys(payload.findings[0]).sort()).toEqual(
      ['file', 'line', 'rule_id', 'severity', 'snippet', 'why'].sort(),
    );
  });

  it('emits valid JSON when clean', () => {
    const root = tmp();
    capture();
    expect(main([root, '--json'])).toBe(0);
    const payload = JSON.parse(out.join('\n'));
    expect(payload.findings).toEqual([]);
    expect(payload.summary).toEqual({
      files_scanned: 0,
      findings: 0,
      by_severity: {},
      suppressed: 0,
    });
  });

  it('lists each finding in human output', () => {
    const root = tree(tmp());
    capture();
    expect(main([root])).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('BH001-wall-clock');
    expect(text).toContain('clock.spec.ts:1');
    expect(text).toContain('2 temporal-dependency findings');
  });

  // #508 Wave 4b: these used to point at an EMPTY temp dir, so they asserted a
  // green all-clear over ZERO scanned files -- the silent-abstention shape
  // itself, restated as a test. A genuine clean run needs a real file that
  // simply has nothing wrong with it.
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
    expect(text).toContain('No temporal-dependency findings');
    expect(text).toContain('1 file scanned');
    expect(text).not.toContain('Abstained');
  });

  it('zero scanned files ABSTAINS, never a clean bill of health', () => {
    const root = tmp();
    capture();
    expect(main([root])).toBe(0); // advisory by default (D3)
    const text = out.join('\n');
    expect(text).toContain('Abstained');
    expect(text).not.toContain('No temporal-dependency findings');
  });

  it('--strict over zero scanned files exits 3, not 0', () => {
    const root = tmp();
    capture();
    // 3 = abstained, distinct from 1 = found something real.
    expect(main([root, '--strict'])).toBe(3);
  });

  it('is advisory by default', () => {
    const root = tree(tmp());
    capture();
    expect(main([root])).toBe(0);
  });

  it('--strict fails on findings', () => {
    const root = tree(tmp());
    capture();
    expect(main([root, '--strict'])).toBe(1);
  });

  it('--strict passes when genuinely clean', () => {
    const root = cleanFile(tmp());
    capture();
    expect(main([root, '--strict'])).toBe(0);
  });

  it('--strict --json still emits parseable JSON', () => {
    const root = tree(tmp());
    capture();
    expect(main([root, '--strict', '--json'])).toBe(1);
    expect(JSON.parse(out.join('\n')).summary.findings).toBe(2);
  });

  it('returns 2 (usage) for a missing path (#955)', () => {
    const root = tmp();
    capture();
    expect(main([path.join(root, 'nope')])).toBe(2);
    expect(err.join('\n')).toContain('not found');
  });

  it('defaults to cwd when no path given', () => {
    const root = tree(tmp());
    const cwd = process.cwd();
    process.chdir(root);
    try {
      capture();
      expect(main([])).toBe(0);
      expect(out.join('\n')).toContain('2 temporal-dependency findings');
    } finally {
      process.chdir(cwd);
    }
  });

  it('accepts multiple paths', () => {
    const root = tree(tmp());
    capture();
    expect(
      main([
        path.join(root, 'tests', 'clock.spec.ts'),
        path.join(root, 'src', 'app.ts'),
        '--json',
      ]),
    ).toBe(0);
    expect(JSON.parse(out.join('\n')).summary.files_scanned).toBe(2);
  });

  // --- argparse-parity surface (#...): --help, unknown flags, `--` ---------

  it('--help prints usage and exits zero', () => {
    capture();
    expect(main(['--help'])).toBe(0);
    expect(out.join('\n')).toContain('usage: canary-blackhawk');
    expect(err.join('\n')).toBe('');
  });

  it('-h is the same as --help', () => {
    capture();
    expect(main(['-h'])).toBe(0);
    expect(out.join('\n')).toContain('usage: canary-blackhawk');
  });

  // Anti-drift: the usage rules block is generated from RULES, so a fifth
  // rule cannot land with a stale hand-typed help text (BH004 was already
  // missing from the docs once).
  it('usage lists every rule id', () => {
    capture();
    expect(main(['--help'])).toBe(0);
    const text = out.join('\n');
    for (const rule of RULES) expect(text).toContain(rule.ruleId);
  });

  // Every diagnostic goes through the one PREFIX constant, so the two error
  // paths cannot drift apart in wording.
  it('prefixes both error paths identically', () => {
    capture();
    expect(main(['--bogus'])).toBe(2);
    expect(err.join('\n')).toMatch(/^canary-blackhawk: /);
    capture();
    expect(main(['/definitely/not/here'])).toBe(2);
    expect(err.join('\n')).toMatch(/^canary-blackhawk: /);
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
    // After `--`, `--json` is a positional -- and a nonexistent one, which is
    // the observable proof it was not parsed as the JSON flag.
    expect(main(['--', '--json'])).toBe(2);
    expect(err.join('\n')).toContain('path not found: --json');
  });

  it('a lone `-` is a positional, not a flag', () => {
    capture();
    expect(main(['-'])).toBe(2);
    expect(err.join('\n')).toContain('path not found: -');
  });

  it('still accepts a bare path with --json and --strict (regression)', () => {
    const root = tree(tmp());
    capture();
    expect(main([root, '--json', '--strict'])).toBe(1);
    expect(JSON.parse(out.join('\n')).summary.findings).toBe(2);
  });
});

// --- Inline suppression pragma (#393) --------------------------------------

describe('inline suppression pragma', () => {
  // #499: the pragma parser ran `PRAGMA.exec(raw)` on the raw line, so a
  // `blackhawk-ignore` sitting INSIDE a string literal registered as a live
  // directive -- data acting as directive, with a fabricated "reason" entering
  // the suppressed count. Savant shipped the guard in #498; blackhawk did not
  // get it ported back. These mirror savant's two pin tests.
  it('a pragma inside a string literal on the same line is inert', () => {
    const text =
      "const fixture = 'setTimeout(x, 500); // blackhawk-ignore BH002 -- fake';\n" +
      'setTimeout(done, 500);\n';
    const r = scanTextFull(text, 'a.spec.ts');
    expect(r.findings.some((f) => f.ruleId.startsWith('BH002'))).toBe(true);
    expect(r.suppressed).toEqual([]);
  });

  it('a pragma inside a string literal on the line above is inert', () => {
    const text =
      "const s = '// blackhawk-ignore BH002 -- not a directive';\n" +
      'setTimeout(done, 500);\n';
    const r = scanTextFull(text, 'a.spec.ts');
    expect(r.findings.some((f) => f.ruleId.startsWith('BH002'))).toBe(true);
    expect(r.suppressed).toEqual([]);
  });

  const ruleIds = (fs2: { ruleId: string }[]) => fs2.map((f) => f.ruleId);

  it('suppresses a rule via a same-line trailing pragma', () => {
    const r = scanTextFull(
      'setTimeout(done, 500); // blackhawk-ignore BH002 -- intentional real wait',
      'a.spec.ts',
    );
    expect(ruleIds(r.findings)).not.toContain('BH002-real-delay');
    expect(ruleIds(r.suppressed)).toContain('BH002-real-delay');
  });

  it('suppresses a finding on the following line', () => {
    const text =
      '// blackhawk-ignore BH002 -- real MongoDB claim race\n' +
      'await new Promise((r) => setTimeout(r, 25));';
    const r = scanTextFull(text, 'a.spec.ts');
    expect(r.findings).toEqual([]);
    expect(r.suppressed.length).toBe(1);
  });

  it('requires a reason (a bare directive does not suppress)', () => {
    const r = scanTextFull(
      'setTimeout(done, 500); // blackhawk-ignore BH002',
      'a.spec.ts',
    );
    expect(ruleIds(r.findings)).toContain('BH002-real-delay');
    expect(r.suppressed).toEqual([]);
  });

  it('is rule-scoped: a BH002 pragma does not silence a BH001 on the line', () => {
    const r = scanTextFull(
      'const t = Date.now(); // blackhawk-ignore BH002 -- unrelated',
      'a.spec.ts',
    );
    expect(ruleIds(r.findings)).toContain('BH001-wall-clock');
  });

  it('accepts the full rule id', () => {
    const r = scanTextFull(
      'time.sleep(2)  # blackhawk-ignore BH002-real-delay -- deliberate',
      'test_a.py',
    );
    expect(r.suppressed.length).toBe(1);
    expect(r.findings).toEqual([]);
  });

  it('scanPaths counts suppressions separately from findings', () => {
    const tmp = mkTmp();
    try {
      fs.writeFileSync(
        path.join(tmp, 'a.spec.ts'),
        'setTimeout(done, 500); // blackhawk-ignore BH002 -- ok\n' +
          'const t = Date.now();\n',
      );
      const r = scanPaths([tmp]);
      expect(r.findings.length).toBe(1); // BH001 remains
      expect(r.findings[0].ruleId).toBe('BH001-wall-clock');
      expect(r.suppressed).toBe(1);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('cli reports the suppressed count (human + json)', () => {
    const tmp = mkTmp();
    const out: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((s?: unknown) => {
      out.push(String(s));
    });
    try {
      fs.writeFileSync(
        path.join(tmp, 'a.spec.ts'),
        'setTimeout(done, 500); // blackhawk-ignore BH002 -- ok\n',
      );
      expect(main([tmp, '--json'])).toBe(0);
      expect(JSON.parse(out.join('\n')).summary.suppressed).toBe(1);
      out.length = 0;
      expect(main([tmp])).toBe(0);
      expect(out.join('\n')).toContain('1 suppressed');
    } finally {
      vi.restoreAllMocks();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// --- Packaging -------------------------------------------------------------

describe('packaging', () => {
  it('SKILL.md declares the executable contract (node, cli.mjs)', () => {
    const head = fs
      .readFileSync(path.join(SKILL_DIR, 'SKILL.md'), 'utf8')
      .split('---')[1];
    expect(head).toContain('name: canary-blackhawk');
    expect(head).toContain('cli: scripts/cli.mjs');
    expect(head).toContain('node>=20');
  });

  // The skill runner spawns the `cli:` target directly (ts/src/skills-cli.ts
  // execs the file, relying on its shebang), so a cli.mjs without the exec bit
  // makes the documented `canary skills run canary-blackhawk -- --help` fail with no
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
});

// --- PHP support (#1107) ----------------------------------------------------
//
// Synthetic PHPUnit / WordPress lines. PHP tokens are gated to `.php` files
// (spec D1): `date(2024, 1, 1)` is a Python constructor, so a shared `date(`
// token would false-positive on Python.

describe('PHP support (#1107)', () => {
  const php = (text: string, name = 'ClockTest.php') => ids(text, name);
  const BH1 = 'BH001-wall-clock';
  const BH2 = 'BH002-real-delay';
  const BH3 = 'BH003-local-timezone';
  const BH4 = 'BH004-naive-datetime-compare';

  it.each([
    '$now = time();',
    '$now = \\time();',
    "$day = date('Y-m-d');",
    "$day = gmdate('Y-m-d');",
    '$ts = mktime();',
    "$ts = strtotime('now');",
    "$ts = strtotime('+1 day');",
    "$ts = strtotime('tomorrow');",
    '$t = microtime(true);',
    '$t = hrtime(true);',
    '$d = new DateTime();',
    '$d = new \\DateTimeImmutable;',
    "$d = new DateTime('now');",
    "$d = new DateTimeImmutable('now', $zone);",
    '$d = date_create();',
    '$d = Carbon::now();',
    '$d = CarbonImmutable::today();',
    "$ts = current_time('timestamp');",
    '$d = current_datetime();',
    "$s = wp_date('Y-m-d');",
    "$s = date_i18n('F j, Y');",
    "$ok = checkdate(2, 29, (int) date('Y'));",
    // Operators written without a space are still operators (review #1).
    "$args = ['k'=>time()];",
    '$t = $b ?:time();',
  ])('BH001 flags %s', (line) => {
    expect(php(line)).toContain(BH1);
  });

  it.each([
    "$day = gmdate('Y-m-d', 1704067200);",
    '$ts = mktime(0, 0, 0, 1, 1, 2024);',
    "$ts = strtotime('2024-01-01 00:00:00 UTC');",
    "$d = new DateTime('2024-01-01T00:00:00Z');",
    "$z = new DateTimeZone('UTC');",
    '$ok = checkdate(2, 29, 2024);',
    '$t = $clock->time();',
    '$t = Clock::time();',
    '$d = $row->date();',
    "$s = wp_date('Y-m-d', 1704067200);",
    // A declaration is not a call (review #2); a fixed base is not now (#4).
    'private function time(): int',
    'public function date($fmt) {',
    "$ts = strtotime('+1 day', 1704067200);",
  ])('BH001 does not flag %s', (line) => {
    expect(php(line)).not.toContain(BH1);
  });

  it.each([
    'sleep(1);',
    'usleep(250000);',
    'usleep(1_000);',
    'time_nanosleep(0, 500000000);',
  ])('BH002 flags %s', (line) => {
    expect(php(line)).toContain(BH2);
  });

  it.each(['sleep(0);', 'usleep($delay);', 'time_nanosleep(0, 0);'])(
    'BH002 does not flag %s',
    (line) => {
      expect(php(line)).not.toContain(BH2);
    },
  );

  it.each([
    "$s = date('Y-m-d H:i', $ts);",
    '$ts = mktime(0, 0, 0, 1, 1, 2024);',
    "$s = strftime('%B %d', $ts);",
    '$f = new IntlDateFormatter($locale, 0, 0);',
    "setlocale(LC_TIME, 'de_DE');",
    "date_default_timezone_set('America/New_York');",
    '$z = new DateTimeZone(date_default_timezone_get());',
    "$z = new DateTimeZone('Europe/Berlin');",
    '$f = IntlDateFormatter::create($locale, 0, 0);',
  ])('BH003 flags %s', (line) => {
    expect(php(line)).toContain(BH3);
  });

  it.each([
    "$s = gmdate('Y-m-d H:i', $ts);",
    "$z = new DateTimeZone('UTC');",
    "$z = new \\DateTimeZone('Etc/UTC');",
    "$s = $d->format('Y-m-d');",
    // Pinning to a neutral zone/locale is the fix (review #3), an import is
    // not a use (#5), and a declaration is not a call (#2).
    "date_default_timezone_set('UTC');",
    "setlocale(LC_ALL, 'C');",
    'use IntlDateFormatter;',
    'public function date($fmt) {',
  ])('BH003 does not flag %s', (line) => {
    expect(php(line)).not.toContain(BH3);
  });

  it('the gmdate -> date swap is exactly a BH003 finding (the issue repro)', () => {
    expect(
      php("$this->assertSame('2024-01-01', gmdate('Y-m-d', $ts));"),
    ).toEqual(new Set());
    expect(php("$this->assertSame('2024-01-01', date('Y-m-d', $ts));")).toEqual(
      new Set([BH3]),
    );
  });

  it.each([
    "$this->assertTrue($d == new DateTime('2024-01-01'));",
    "$this->assertTrue(strtotime('2024-03-10 02:30') < $ts);",
    '$expires = $start + DAY_IN_SECONDS;',
    '$later = $start + 2 * WEEK_IN_SECONDS;',
    '$earlier = YEAR_IN_SECONDS - $offset;',
    "$this->assertTrue($x>strtotime('2024-01-01'));",
    '$c = $a<=>strtotime($b);',
    // A UTC anchor does not fix a fixed-length day across DST/leap days.
    "$expires = strtotime('2024-01-01 UTC') + DAY_IN_SECONDS;",
  ])('BH004 flags %s', (line) => {
    expect(php(line)).toContain(BH4);
  });

  it.each([
    "$this->assertTrue($d == new DateTime('2024-01-01', new DateTimeZone('UTC')));",
    "$this->assertTrue(strtotime('2024-03-10 02:30 UTC') < $ts);",
    "$args = ['at' => strtotime('2024-01-01 UTC')];",
    '$ttl = HOUR_IN_SECONDS;',
    "$d = new DateTime('2024-01-01');",
  ])('BH004 does not flag %s', (line) => {
    expect(php(line)).not.toContain(BH4);
  });

  it.each([
    'use Symfony\\Bridge\\PhpUnit\\ClockMock;',
    ' * @group time-sensitive',
    'use phpmock\\phpunit\\PHPMock;',
    "$time = $this->getFunctionMock(__NAMESPACE__, 'time');",
    'Carbon::setTestNow(Carbon::create(2024, 1, 1));',
    "add_filter('pre_option_gmt_offset', fn () => 0);",
    "add_filter('pre_option_timezone_string', fn () => 'UTC');",
  ])('marker %s suppresses BH001/BH002/BH004 but not BH003', (marker) => {
    const body = [
      '$now = time();',
      'sleep(1);',
      '$expires = $start + DAY_IN_SECONDS;',
      "$s = date('Y-m-d', $ts);",
    ].join('\n');
    expect(php(body)).toEqual(new Set([BH1, BH2, BH3, BH4])); // control
    expect(php(`${marker}\n${body}`)).toEqual(new Set([BH3]));
  });

  it.each([
    "$fixture = 'time() and sleep(1)';",
    '$fixture = "date(\'Y\') is data";',
    '// $now = time();',
    '# sleep(1);',
    ' * @see date()',
    '/* usleep(5); */',
    '$x = 1; // $now = time();',
    '$x = 1; # sleep(1);',
    "$x = 'a'; /* date('Y') */",
  ])('does not fire on a token in a string or comment: %s', (line) => {
    expect(php(line)).toEqual(new Set());
  });

  it('a # inside a string does not start a trailing comment', () => {
    expect(php("$s = '#'; $now = time();")).toContain(BH1);
  });

  it('a PHP 8 attribute (#[...]) is code, not a trailing comment', () => {
    expect(php('$f = #[Pure] fn () => time();')).toContain(BH1);
  });

  it.each([
    ['d = date(2024, 1, 1)', 'test_a.py'],
    ['sleep(1)', 'test_a.py'],
    ['const t = time();', 'a.spec.ts'],
    ['const s = strftime(fmt);', 'a.spec.ts'],
  ])('PHP-only tokens do not fire outside .php: %s', (line, name) => {
    expect(ids(line, name)).toEqual(new Set());
  });

  it('JS/Python tokens do not fire in a .php file', () => {
    expect(php('$t = Date.now(); setTimeout($fn, 500);')).toEqual(new Set());
  });

  it('pragma suppression works in PHP', () => {
    const r = scanTextFull(
      '// blackhawk-ignore BH002 -- real socket timeout under test\nsleep(1);',
      'ClockTest.php',
    );
    expect(r.findings).toEqual([]);
    expect(r.suppressed.map((f) => f.ruleId)).toEqual([BH2]);
  });

  describe('path selection', () => {
    const tmps: string[] = [];
    afterEach(() => {
      while (tmps.length)
        fs.rmSync(tmps.pop()!, { recursive: true, force: true });
    });
    const phpTree = () => {
      const root = mkTmp();
      tmps.push(root);
      const write = (rel: string) => {
        const full = path.join(root, rel);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, '<?php\n$now = time();\n');
      };
      write('tests/Unit/ClockTest.php');
      write('plugin/test-clock.php');
      write('plugin/ReportTest.php');
      write('src/Clock.php');
      return root;
    };

    it('a directory walk scans PHPUnit and WordPress test files only', () => {
      const result = scanPaths([phpTree()]);
      const files = new Set(result.findings.map((f) => path.basename(f.file)));
      expect(files).toEqual(
        new Set(['ClockTest.php', 'test-clock.php', 'ReportTest.php']),
      );
      expect(result.filesScanned).toBe(3);
    });

    it('scans an explicit .php file anyway', () => {
      const root = phpTree();
      const result = scanPaths([path.join(root, 'src', 'Clock.php')]);
      expect(result.filesScanned).toBe(1);
      expect(result.findings.map((f) => f.ruleId)).toEqual([BH1]);
    });
  });
});
