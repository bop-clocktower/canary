// Voice pack slice 1 (#340): canary-test-reporter's Markdown gains one voiced
// footer from voice/lines.json. Voice is garnish, so the tests pin the
// invariant: JSON output, exit codes and annotations are identical with flavor
// on and off, the line is deterministic, and a missing lines file degrades to
// no footer. Proposal criteria 1-8.

import { describe, it, expect, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { main } from '../claude-code/canary-test-reporter/scripts/cli.mjs';
import {
  flavorOn,
  loadLines,
  momentFor,
  pickLine,
  voiceFooter,
} from '../claude-code/canary-test-reporter/scripts/voice.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..', '..', '..');
const ROOT_LINES = path.join(REPO, 'voice', 'lines.json');
const SKILL_LINES = path.join(
  HERE,
  '..',
  'claude-code',
  'canary-test-reporter',
  'voice-lines.json',
);

const tmps: string[] = [];
const mkTmp = (): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-'));
  tmps.push(d);
  return d;
};
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['CANARY_NO_FLAVOR'];
  delete process.env['NO_FLAVOR'];
  while (tmps.length) fs.rmSync(tmps.pop()!, { recursive: true, force: true });
});

/** A Playwright results file with the given passing/failing/flaky counts. */
function results(dir: string, pass: number, fail: number, flaky = 0): string {
  const spec = (title: string, status: string, attempts: string[]) => ({
    title,
    tests: [
      { status, results: attempts.map((s) => ({ status: s, duration: 5 })) },
    ],
  });
  const specs = [
    ...Array.from({ length: pass }, (_, i) =>
      spec(`p${i}`, 'expected', ['passed']),
    ),
    ...Array.from({ length: fail }, (_, i) =>
      spec(`f${i}`, 'unexpected', ['failed']),
    ),
    ...Array.from({ length: flaky }, (_, i) =>
      spec(`k${i}`, 'flaky', ['failed', 'passed']),
    ),
  ];
  const p = path.join(dir, 'results.json');
  fs.writeFileSync(
    p,
    JSON.stringify({ suites: [{ title: 'a.spec.ts', specs }] }),
  );
  return p;
}

function run(argv: string[]): { code: number; out: string } {
  const out: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
    out.push(String(s));
    return true;
  });
  vi.spyOn(console, 'log').mockImplementation((s) => void out.push(String(s)));
  vi.spyOn(console, 'error').mockImplementation(
    (s) => void out.push(String(s)),
  );
  const code = main(argv);
  vi.restoreAllMocks();
  return { code, out: out.join('') };
}

const allLines = (): string[] => {
  const data = JSON.parse(fs.readFileSync(ROOT_LINES, 'utf8')) as Record<
    string,
    Record<string, string[]>
  >;
  return Object.values(data).flatMap((m) => Object.values(m).flat());
};

describe('voice selection', () => {
  const lines = { 'black-canary': { 'report.fail': ['a', 'b', 'c'] } };

  it('picks the same line for the same counts (criterion 6)', () => {
    const counts = { total: 9, passed: 5, failed: 3, flaky: 1 };
    expect(pickLine(lines, 'black-canary', 'report.fail', counts)).toBe(
      pickLine(lines, 'black-canary', 'report.fail', counts),
    );
  });

  it('returns empty for an unknown profile or moment', () => {
    const counts = { total: 1, passed: 0, failed: 1, flaky: 0 };
    expect(pickLine(lines, 'nobody', 'report.fail', counts)).toBe('');
    expect(pickLine(lines, 'black-canary', 'report.pass', counts)).toBe('');
  });

  it('maps counts to a moment: failures, then flakes, then pass', () => {
    expect(momentFor({ failed: 1, flaky: 1 })).toBe('report.fail');
    expect(momentFor({ failed: 0, flaky: 2 })).toBe('report.flaky');
    expect(momentFor({ failed: 0, flaky: 0 })).toBe('report.pass');
  });

  it('honours CANARY_NO_FLAVOR, NO_FLAVOR and --no-flavor', () => {
    expect(flavorOn({}, false)).toBe(true);
    expect(flavorOn({ CANARY_NO_FLAVOR: '1' }, false)).toBe(false);
    expect(flavorOn({ NO_FLAVOR: 'true' }, false)).toBe(false);
    expect(flavorOn({ CANARY_NO_FLAVOR: '0' }, false)).toBe(true);
    expect(flavorOn({}, true)).toBe(false);
  });

  it('loadLines returns null for a missing or malformed file', () => {
    const dir = mkTmp();
    expect(loadLines(path.join(dir, 'none.json'))).toBeNull();
    fs.writeFileSync(path.join(dir, 'bad.json'), '{');
    expect(loadLines(path.join(dir, 'bad.json'))).toBeNull();
  });

  it('Black Canary stays quiet on a green run (her profile: never green runs)', () => {
    expect(
      voiceFooter(
        { total: 3, passed: 3, failed: 0, flaky: 0 },
        { env: {}, noFlavor: false, linesPath: ROOT_LINES },
      ),
    ).toBe('');
  });
});

describe('reporter footer (criteria 1, 2, 5, 7)', () => {
  it('criterion 1: a failing run ends with one attribution line and one voiced line', () => {
    const dir = mkTmp();
    const { out } = run(['--results', results(dir, 2, 1)]);
    const tail = out.trimEnd().split('\n').slice(-2);
    expect(tail[0]).toMatch(/^_Voice: Black Canary\b.*CANARY_NO_FLAVOR=1/);
    expect(tail[1]).toMatch(/^> \S/);
    expect(allLines()).toContain(tail[1]!.slice(2));
    expect(out.match(/_Voice: /g)).toHaveLength(1);
  });

  it('criterion 2: CANARY_NO_FLAVOR=1 removes every voiced line and the attribution', () => {
    const dir = mkTmp();
    process.env['CANARY_NO_FLAVOR'] = '1';
    const { out } = run(['--results', results(dir, 2, 1)]);
    expect(out).not.toContain('_Voice:');
    for (const line of allLines()) expect(out).not.toContain(line);
  });

  it('--no-flavor removes the footer too', () => {
    const dir = mkTmp();
    const { out } = run(['--results', results(dir, 0, 1), '--no-flavor']);
    expect(out).not.toContain('_Voice:');
  });

  it('a flaky-only run gets a flaky line', () => {
    const dir = mkTmp();
    const { out } = run(['--results', results(dir, 1, 0, 1)]);
    expect(out).toContain('_Voice: Black Canary');
  });

  it('criterion 5: no annotation line carries voiced text', () => {
    const dir = mkTmp();
    const { out } = run(['--results', results(dir, 0, 3, 1)]);
    const annotations = out
      .split('\n')
      .filter((l) => /^::(error|warning|notice)/.test(l));
    for (const a of annotations) {
      for (const line of allLines()) expect(a).not.toContain(line);
    }
  });

  it('criterion 7: without a readable lines file the Markdown is unvoiced and the exit code unchanged', () => {
    const dir = mkTmp();
    const res = results(dir, 0, 1);
    const withLines = run(['--results', res]);
    process.env['CANARY_VOICE_LINES'] = path.join(dir, 'missing.json');
    try {
      const without = run(['--results', res]);
      expect(without.out).not.toContain('_Voice:');
      expect(without.code).toBe(withLines.code);
    } finally {
      delete process.env['CANARY_VOICE_LINES'];
    }
  });
});

describe('the invariant (criteria 3, 4)', () => {
  const sha = (p: string): string =>
    crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

  it.each([
    ['all pass', 3, 0, 0],
    ['mixed', 2, 1, 1],
    ['all fail', 0, 4, 0],
    ['flaky only', 1, 0, 2],
  ])(
    '%s: --json-out is byte-identical and the exit code matches',
    (_l, p, f, k) => {
      const dir = mkTmp();
      const res = results(dir, p, f, k);
      const on = path.join(dir, 'on.json');
      const off = path.join(dir, 'off.json');
      const codeOn = run([
        '--results',
        res,
        '--json-out',
        on,
        '--markdown-out',
        path.join(dir, 'on.md'),
      ]).code;
      process.env['CANARY_NO_FLAVOR'] = '1';
      const codeOff = run([
        '--results',
        res,
        '--json-out',
        off,
        '--markdown-out',
        path.join(dir, 'off.md'),
      ]).code;
      expect(sha(on)).toBe(sha(off));
      expect(codeOn).toBe(codeOff);
    },
  );
});

describe('lines file integrity (criterion 8)', () => {
  it('the skill ships a byte-identical copy of voice/lines.json', () => {
    expect(fs.readFileSync(SKILL_LINES, 'utf8')).toBe(
      fs.readFileSync(ROOT_LINES, 'utf8'),
    );
  });

  it('every profile in voice/lines.json has a voice/profiles/<name>.md, and every line is non-empty', () => {
    const data = JSON.parse(fs.readFileSync(ROOT_LINES, 'utf8')) as Record<
      string,
      Record<string, string[]>
    >;
    const profiles = Object.keys(data);
    expect(profiles.length).toBeGreaterThan(0);
    for (const name of profiles) {
      expect(
        fs.existsSync(path.join(REPO, 'voice', 'profiles', `${name}.md`)),
        name,
      ).toBe(true);
      for (const lines of Object.values(data[name]!)) {
        expect(lines.length).toBeGreaterThan(0);
        for (const l of lines) expect(l.trim()).not.toBe('');
      }
    }
  });
});
