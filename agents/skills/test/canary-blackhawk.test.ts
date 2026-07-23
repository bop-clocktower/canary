// Unit suite for the canary-blackhawk skill, ported from Python to vitest as
// the skill moves to JS (canary mirrors harness, which is TS/Node). Behavior is
// preserved from the Python version; the pragma (#393) lands in a follow-on
// commit.

import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  scanText,
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

  it('says so when clean', () => {
    const root = tmp();
    capture();
    expect(main([root])).toBe(0);
    expect(out.join('\n')).toContain('No temporal-dependency findings');
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

  it('--strict passes when clean', () => {
    const root = tmp();
    capture();
    expect(main([root, '--strict'])).toBe(0);
  });

  it('--strict --json still emits parseable JSON', () => {
    const root = tree(tmp());
    capture();
    expect(main([root, '--strict', '--json'])).toBe(1);
    expect(JSON.parse(out.join('\n')).summary.findings).toBe(2);
  });

  it('returns 1 for a missing path', () => {
    const root = tmp();
    capture();
    expect(main([path.join(root, 'nope')])).toBe(1);
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
