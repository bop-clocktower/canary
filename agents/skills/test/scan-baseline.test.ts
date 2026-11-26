// The shared baseline/ratchet mode for canary-blackhawk and canary-savant
// (#1322). One file format, one comparison and one exit-code contract live in
// lib/scan-baseline.mjs; ts/test/scan-baseline-conformance.test.ts holds the
// engine's port (vacuity-check) to the same reading.
//
// Every comparison test plants a REAL finding through the real scanner, so a
// baseline that silently matched everything (or nothing) cannot pass here.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildBaseline,
  compareBaseline,
  identityOf,
  parseBaseline,
  serializeBaseline,
} from '../lib/scan-baseline.mjs';
import { main as blackhawk } from '../claude-code/canary-blackhawk/scripts/cli.mjs';
import { main as savant } from '../claude-code/canary-savant/scripts/cli.mjs';

// One real finding per scanner. Leading lines are a parameter so the same
// finding can be moved down the file without changing anything else.
const BH_TEST = (pad = 0) =>
  '\n'.repeat(pad) +
  "it('stamps', () => {\n  const t = Date.now();\n  expect(t).toBeGreaterThan(0);\n});\n";
const BH_SECOND = "it('waits', () => {\n  const d = new Date();\n});\n";
const SV_TEST = (pad = 0) =>
  '\n'.repeat(pad) +
  "const cache = [];\nit('a', () => { cache.push(1); });\nit('b', () => { expect(cache).toHaveLength(1); });\n";

let tmp: string;
let cwd: string;
let out: string[];

beforeEach(() => {
  // realpath: macOS tmpdir is a symlink, and process.cwd() reports the target.
  tmp = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'scan-baseline-')),
  );
  cwd = process.cwd();
  process.chdir(tmp);
  out = [];
  vi.spyOn(console, 'log').mockImplementation((s) => void out.push(String(s)));
  vi.spyOn(console, 'error').mockImplementation(
    (s) => void out.push(String(s)),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  process.chdir(cwd);
  fs.rmSync(tmp, { recursive: true, force: true });
});

const write = (rel: string, text: string) => {
  fs.mkdirSync(path.dirname(rel), { recursive: true });
  fs.writeFileSync(rel, text);
};
const lastJson = () => JSON.parse(out[out.length - 1]!);

describe('identity', () => {
  it('ignores line numbers and normalizes whitespace in the anchor', () => {
    const a = identityOf({ file: 'a.spec.ts', rule: 'R', anchor: ' x  =\t1 ' });
    expect(a).toEqual({ file: 'a.spec.ts', rule: 'R', anchor: 'x = 1' });
  });

  it('keys the file relative to cwd with forward slashes', () => {
    const abs = path.join(tmp, 'tests', 'a.spec.ts');
    expect(identityOf({ file: abs, rule: 'R', anchor: 'x' }).file).toBe(
      'tests/a.spec.ts',
    );
  });
});

describe('compareBaseline (multiset)', () => {
  const id = { file: 'f', rule: 'R', anchor: 'x' };

  it('counts a duplicate beyond the baselined multiplicity as new', () => {
    const base = buildBaseline('t', [id]);
    const cmp = compareBaseline(base, [id, id]);
    expect(cmp).toMatchObject({ newCount: 1, fixedCount: 0, baselined: 1 });
    expect(cmp.new).toEqual([{ ...id, count: 1 }]);
  });

  it('reports a vanished finding as fixed, never as new', () => {
    const base = buildBaseline('t', [id, { ...id, anchor: 'y' }]);
    const cmp = compareBaseline(base, [id]);
    expect(cmp).toMatchObject({ newCount: 0, fixedCount: 1, baselined: 1 });
    expect(cmp.fixed).toEqual([{ ...id, anchor: 'y', count: 1 }]);
  });
});

describe('baseline file format', () => {
  it('serializes with sorted entries so diffs are stable', () => {
    const ids = [
      { file: 'b', rule: 'R', anchor: 'x' },
      { file: 'a', rule: 'S', anchor: 'x' },
      { file: 'a', rule: 'R', anchor: 'z' },
      { file: 'a', rule: 'R', anchor: 'z' },
    ];
    const text = serializeBaseline(buildBaseline('canary-blackhawk', ids));
    const reversed = serializeBaseline(
      buildBaseline('canary-blackhawk', [...ids].reverse()),
    );
    expect(text).toBe(reversed);
    const parsed = JSON.parse(text);
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.findings.map((f: { file: string }) => f.file)).toEqual([
      'a',
      'a',
      'b',
    ]);
    expect(parsed.findings[0]).toEqual({
      file: 'a',
      rule: 'R',
      anchor: 'z',
      count: 2,
    });
  });

  it.each([
    ['not json', '{', /not valid JSON/],
    [
      'wrong tool',
      JSON.stringify({ schemaVersion: 1, tool: 'x', findings: [] }),
      /written by 'x'/,
    ],
    [
      'wrong version',
      JSON.stringify({ schemaVersion: 9, tool: 't', findings: [] }),
      /schemaVersion/,
    ],
    [
      'no findings array',
      JSON.stringify({ schemaVersion: 1, tool: 't' }),
      /findings/,
    ],
    [
      'bad count',
      JSON.stringify({
        schemaVersion: 1,
        tool: 't',
        findings: [{ file: 'f', rule: 'R', anchor: 'x', count: 0 }],
      }),
      /entry 0/,
    ],
    [
      'duplicate entry',
      JSON.stringify({
        schemaVersion: 1,
        tool: 't',
        findings: [
          { file: 'f', rule: 'R', anchor: 'x', count: 1 },
          { file: 'f', rule: 'R', anchor: 'x', count: 1 },
        ],
      }),
      /duplicate/,
    ],
  ])('rejects a malformed baseline: %s', (_name, text, msg) => {
    const r = parseBaseline(text, 't');
    expect(r.error).toMatch(msg);
    expect(r.baseline).toBeUndefined();
  });

  it('round-trips through parse', () => {
    const b = buildBaseline('t', [{ file: 'f', rule: 'R', anchor: 'x' }]);
    expect(parseBaseline(serializeBaseline(b), 't').baseline).toEqual(b);
  });
});

describe.each([
  ['canary-blackhawk', blackhawk, BH_TEST, 'tests/a.spec.ts'],
  ['canary-savant', savant, SV_TEST, 'tests/a.spec.ts'],
] as const)(
  '%s --baseline / --update-baseline',
  (tool, main, fixture, file) => {
    it('writes a baseline, then passes against it', () => {
      write(file, fixture());
      expect(main(['tests', '--update-baseline', 'bl.json'])).toBe(0);
      const bl = JSON.parse(fs.readFileSync('bl.json', 'utf8'));
      expect(bl.tool).toBe(tool);
      expect(bl.findings.length).toBeGreaterThan(0);
      out = [];
      expect(main(['tests', '--baseline', 'bl.json', '--json'])).toBe(0);
      expect(lastJson().baseline).toMatchObject({
        new: 0,
        fixed: 0,
        checked: 1,
      });
      expect(lastJson().baseline.baselined).toBe(bl.findings.length);
    });

    it('keeps the same identity when the finding moves down the file', () => {
      write(file, fixture());
      main(['tests', '--update-baseline', 'bl.json']);
      write(file, '// a comment\n' + fixture(7));
      expect(main(['tests', '--baseline', 'bl.json'])).toBe(0);
    });

    it('fails (exit 1) on a finding the baseline does not hold', () => {
      write(file, fixture());
      main(['tests', '--update-baseline', 'bl.json']);
      write('tests/b.spec.ts', fixture());
      out = [];
      expect(main(['tests', '--baseline', 'bl.json', '--json'])).toBe(1);
      const b = lastJson().baseline;
      expect(b.new).toBeGreaterThan(0);
      expect(
        b.entries.new.every(
          (e: { file: string }) => e.file === 'tests/b.spec.ts',
        ),
      ).toBe(true);
    });

    it('reports a fixed finding as shrinkage and still exits 0', () => {
      write(file, fixture());
      write('tests/b.spec.ts', fixture());
      main(['tests', '--update-baseline', 'bl.json']);
      fs.rmSync('tests/b.spec.ts');
      out = [];
      expect(main(['tests', '--baseline', 'bl.json'])).toBe(0);
      expect(out.join('\n')).toMatch(/fixed/);
      expect(out.join('\n')).toMatch(/--update-baseline/);
    });

    it('abstains (exit 3) when the scan checked zero files, baseline or not', () => {
      write(file, fixture());
      main(['tests', '--update-baseline', 'bl.json']);
      fs.mkdirSync('empty');
      out = [];
      expect(main(['empty', '--baseline', 'bl.json', '--json'])).toBe(3);
      expect(lastJson().baseline).toMatchObject({
        checked: 0,
        verdict: 'abstained',
      });
      const before = fs.readFileSync('bl.json', 'utf8');
      expect(main(['empty', '--update-baseline', 'bl.json'])).toBe(3);
      expect(fs.readFileSync('bl.json', 'utf8')).toBe(before);
    });

    it('refuses to grow an existing baseline without --allow-growth', () => {
      write(file, fixture());
      main(['tests', '--update-baseline', 'bl.json']);
      const before = fs.readFileSync('bl.json', 'utf8');
      write('tests/b.spec.ts', fixture());
      expect(main(['tests', '--update-baseline', 'bl.json'])).toBe(1);
      expect(fs.readFileSync('bl.json', 'utf8')).toBe(before);
      expect(
        main(['tests', '--update-baseline', 'bl.json', '--allow-growth']),
      ).toBe(0);
      expect(fs.readFileSync('bl.json', 'utf8')).not.toBe(before);
    });

    it('errors (exit 2) on a missing or malformed baseline -- never a silent pass', () => {
      write(file, fixture());
      expect(main(['tests', '--baseline', 'missing.json'])).toBe(2);
      expect(out.join('\n')).toMatch(/missing\.json/);
      fs.writeFileSync('bad.json', '{ nope');
      expect(main(['tests', '--baseline', 'bad.json'])).toBe(2);
    });

    it('rejects contradictory flags as a usage error', () => {
      write(file, fixture());
      expect(
        main(['tests', '--baseline', 'a.json', '--update-baseline', 'b.json']),
      ).toBe(2);
      expect(main(['tests', '--allow-growth'])).toBe(2);
    });

    it('documents the exit-code table in --help', () => {
      expect(main(['--help'])).toBe(0);
      const help = out.join('\n');
      expect(help).toMatch(/--baseline FILE/);
      expect(help).toMatch(/--update-baseline FILE/);
      expect(help).toMatch(/exit codes[\s\S]*\n {2}3 {2}/);
    });
  },
);

it('blackhawk counts two identical findings as a multiset', () => {
  write('tests/a.spec.ts', BH_TEST() + BH_SECOND);
  main0();
  write('tests/a.spec.ts', BH_TEST() + BH_SECOND + BH_SECOND);
  out = [];
  expect(blackhawk(['tests', '--baseline', 'bl.json', '--json'])).toBe(1);
  expect(lastJson().baseline.new).toBe(1);
});

function main0() {
  expect(blackhawk(['tests', '--update-baseline', 'bl.json'])).toBe(0);
}
