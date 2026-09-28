/**
 * canary-signal (#609) -- QA impact digest. Cases are tagged with the spec's
 * success criteria (SC1-SC9, docs/changes/609-canary-signal/proposal.md).
 * Fixtures are synthetic and de-identified; nothing here is copied from a
 * real store.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_LEDGER,
  loadLedger,
  loadRuns,
} from '../claude-code/canary-signal/scripts/sources.mjs';
import { CLI_SPEC, main } from '../claude-code/canary-signal/scripts/cli.mjs';
import {
  CHAT_MAX_LINES,
  renderDigest,
} from '../claude-code/canary-signal/scripts/digest.mjs';
import {
  FLAKY_CAPABLE_FORMATS,
  PRODUCTION_ESCAPES_DARK,
  THIN_SAMPLE_RUNS,
  measured,
  tallyDigest,
} from '../claude-code/canary-signal/scripts/tally.mjs';
import {
  partitionByWindow,
  resolveWindow,
} from '../claude-code/canary-signal/scripts/window.mjs';

const SCRIPTS = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'claude-code',
  'canary-signal',
  'scripts',
);
const UNTIL = '2026-09-28T00:00:00.000Z';

const tmps: string[] = [];
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-signal-'));
  tmps.push(dir);
  return dir;
}
afterEach(() => {
  vi.restoreAllMocks();
  while (tmps.length) {
    fs.rmSync(tmps.pop()!, { recursive: true, force: true });
  }
});

type Run = Record<string, unknown>;
let seq = 0;
/** A RunRecord (ts/src/history/record.ts) with in-window defaults. */
function rec(over: Run = {}): Run {
  seq += 1;
  return {
    run_id: `r${seq}`,
    suite: 'unit',
    branch: 'main',
    timestamp: '2026-09-27T12:00:00Z',
    reporter_format: 'vitest',
    tests: [],
    ...over,
  };
}
const t = (test_name: string, status: string) => ({ test_name, status });

function writeStore(dir: string, runs: Run[]): string {
  const file = path.join(dir, 'history-v2.jsonl');
  const body = runs.map((r) => JSON.stringify(r)).join('\n');
  fs.writeFileSync(file, body ? `${body}\n` : '', 'utf8');
  return file;
}
function writeLedger(dir: string, entries: unknown): string {
  const file = path.join(dir, 'quarantine.json');
  fs.writeFileSync(
    file,
    JSON.stringify({ schema_version: 2, entries }),
    'utf8',
  );
  return file;
}
function writeRaw(dir: string, name: string, body: string): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, body, 'utf8');
  return file;
}

describe('sources.loadRuns', () => {
  it('parses one record per non-blank line, any line ending', () => {
    const body = `${JSON.stringify(rec())}\n\n${JSON.stringify(rec())}\r\n`;
    expect(loadRuns(writeRaw(tmp(), 's.jsonl', body))).toHaveLength(2);
  });
  it('throws on a missing store -- a typo must look like a typo', () => {
    expect(() => loadRuns(path.join(tmp(), 'nope.jsonl'))).toThrow(
      /history store not found/,
    );
  });
  it('names the line of a malformed record', () => {
    const body = `${JSON.stringify(rec())}\n{oops\n`;
    expect(() => loadRuns(writeRaw(tmp(), 's.jsonl', body))).toThrow(/line 2/);
  });
  it('rejects a line that parses but is not an object', () => {
    expect(() => loadRuns(writeRaw(tmp(), 's.jsonl', '[1]\n'))).toThrow(
      /line 1: not an object/,
    );
  });
});

describe('sources.loadLedger', () => {
  it('reads katana ledger entries', () => {
    const rows = [{ test: 'a', kind: 'skip' }];
    expect(loadLedger(writeLedger(tmp(), rows), true)).toEqual({
      state: 'read',
      rows,
      reason: null,
    });
  });
  it('SC6: the default path missing is a dark source, not an error', () => {
    const res = loadLedger(path.join(tmp(), DEFAULT_LEDGER), false);
    expect(res.state).toBe('dark');
    expect(res.reason).toContain('no quarantine ledger at');
  });
  it('SC6: an explicit --ledger that does not exist throws (D10)', () => {
    expect(() => loadLedger(path.join(tmp(), 'typo.json'), true)).toThrow(
      /quarantine ledger not found/,
    );
  });
  it('throws on malformed JSON', () => {
    const file = writeRaw(tmp(), 'q.json', '{nope');
    expect(() => loadLedger(file, true)).toThrow(/malformed quarantine ledger/);
  });
  it('throws on a document that is not an object', () => {
    const file = writeRaw(tmp(), 'q.json', '[]');
    expect(() => loadLedger(file, true)).toThrow(/not an object/);
  });
  it('throws when entries is not an array', () => {
    const file = writeLedger(tmp(), { a: 1 });
    expect(() => loadLedger(file, true)).toThrow(/must be an array/);
  });
  it('treats a document without entries as an empty ledger', () => {
    const file = writeRaw(tmp(), 'q.json', '{"schema_version":2}');
    expect(loadLedger(file, true).rows).toEqual([]);
  });
});

describe('window', () => {
  it('D6: spans --days ending at --until', () => {
    const w = resolveWindow(7, UNTIL).window!;
    expect(w.until.toISOString()).toBe(UNTIL);
    expect(w.since.toISOString()).toBe('2026-09-21T00:00:00.000Z');
  });
  it('defaults --until to now (under a frozen clock)', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-03-01T00:00:00Z'));
      const w = resolveWindow(1, null).window!;
      expect(w.until.toISOString()).toBe('2026-03-01T00:00:00.000Z');
      expect(w.since.toISOString()).toBe('2026-02-28T00:00:00.000Z');
    } finally {
      vi.useRealTimers();
    }
  });
  it('rejects an unparseable --until', () => {
    expect(resolveWindow(7, 'last tuesday').error).toMatch(/--until/);
  });
  it('rejects --days below 1', () => {
    expect(resolveWindow(0, UNTIL).error).toMatch(/--days/);
  });
  it('keeps inclusive bounds, drops outside rows, COUNTS undated ones', () => {
    const w = resolveWindow(7, UNTIL).window!;
    const items = [
      { d: '2026-09-21T00:00:00.000Z' },
      { d: UNTIL },
      { d: '2026-09-20T23:59:59Z' },
      { d: '2026-09-29T00:00:00Z' },
      { d: 'garbage' },
      {},
    ];
    const res = partitionByWindow(items, (i: { d?: string }) => i.d, w);
    expect(res.inside).toHaveLength(2);
    expect(res.undated).toBe(2);
  });
});

const WINDOW = resolveWindow(7, UNTIL).window!;
const NO_LEDGER = {
  state: 'dark',
  rows: [],
  reason: 'no quarantine ledger at .canary/quarantine.json',
};
/** Fixtures hand the pure core loosely-typed rows, as a real JSONL store would. */
type Ledger = Parameters<typeof tallyDigest>[0]['ledger'];
const tally = (runs: Run[], ledger: unknown = NO_LEDGER) =>
  tallyDigest({
    runs,
    ledger: ledger as Ledger,
    branch: 'main',
    window: WINDOW,
  });

describe('tally', () => {
  it('D4: a zero denominator abstains instead of measuring 0', () => {
    expect(measured(0, 0, 'why')).toEqual({
      abstained: true,
      reason: 'why',
    });
    expect(measured(0, 4, 'why')).toEqual({ value: 0, denominator: 4 });
  });
  it('SC2: zero runs in the window abstains the whole digest', () => {
    const old = rec({ timestamp: '2026-01-01T00:00:00Z' });
    expect(tally([old]).state).toBe('abstained');
  });
  it('SC3: 1-2 runs is a thin sample; 3 is not', () => {
    expect(THIN_SAMPLE_RUNS).toBe(3);
    expect(tally([rec(), rec()]).state).toBe('thin');
    expect(tally([rec(), rec(), rec()]).state).toBe('ok');
  });
  it('SC1: sample counts runs, suites and distinct UTC days', () => {
    const res = tally([
      rec({ suite: 'a', timestamp: '2026-09-26T01:00:00Z' }),
      rec({ suite: 'b', timestamp: '2026-09-26T02:00:00Z' }),
      rec({ suite: 'a', timestamp: '2026-09-27T01:00:00Z' }),
    ]);
    expect(res.sample).toEqual({ runs: 3, suites: 2, days: 2 });
  });
  it('counts undated runs instead of dropping them', () => {
    expect(tally([rec(), rec({ timestamp: undefined })]).undatedRuns).toBe(1);
  });
  it('tests executed: tests.length, falling back to total', () => {
    const res = tally([
      rec({ tests: [t('a', 'passed'), t('b', 'failed')] }),
      rec({ tests: undefined, total: 5 }),
      rec({ tests: undefined }),
    ]);
    expect(res.tests).toEqual({ value: 7, denominator: 3 });
  });
  it('D7: failures split by branch, distinct by test name', () => {
    const res = tally([
      rec({ branch: 'feat/x', tests: [t('a', 'failed')] }),
      rec({
        branch: 'feat/y',
        tests: [t('a', 'failed'), t('b', 'failed'), t('c', 'passed')],
      }),
      rec({ tests: [t('d', 'failed'), t('e', 'flaky')] }),
    ]);
    expect(res.preMerge).toEqual({ value: 2, denominator: 2 });
    expect(res.reached).toEqual({ value: 1, denominator: 1 });
  });
  it('SC4: no non-default-branch runs => pre-merge abstains, never 0', () => {
    const res = tally([rec(), rec(), rec()]);
    expect(res.preMerge).toMatchObject({ abstained: true });
    expect(res.preMerge).not.toHaveProperty('value');
  });
  it('reached abstains when no run is on the default branch', () => {
    expect(tally([rec({ branch: 'feat/x' })]).reached).toMatchObject({
      abstained: true,
    });
  });
  it('counts runs with no branch in neither branch line', () => {
    const res = tally([rec({ branch: undefined }), rec(), rec({ branch: '' })]);
    expect(res.unbranched).toBe(2);
    expect(res.reached).toEqual({ value: 0, denominator: 1 });
  });
  it('SC5: no flaky-capable reporter => the flaky line abstains', () => {
    const res = tally([
      rec({ tests: [t('a', 'flaky')] }),
      rec({ reporter_format: undefined }),
    ]);
    expect(res.flaky).toMatchObject({ abstained: true });
  });
  it('D8: flaky counts only over flaky-capable runs', () => {
    expect(FLAKY_CAPABLE_FORMATS).toEqual(['playwright', 'junit']);
    const res = tally([
      rec({
        reporter_format: 'playwright',
        tests: [t('a', 'flaky'), t('a', 'flaky')],
      }),
      rec({ reporter_format: 'junit' }),
      rec({ tests: [t('z', 'flaky')] }),
    ]);
    expect(res.flaky).toEqual({ value: 1, denominator: 2 });
  });
  it('SC6: a dark ledger abstains and is named as a dark source', () => {
    const res = tally([rec()]);
    expect(res.quarantine).toMatchObject({ abstained: true });
    expect(res.dark).toContain(
      'quarantine ledger: no quarantine ledger at .canary/quarantine.json',
    );
  });
  it('an empty ledger is a dark source too', () => {
    const res = tally([rec()], { state: 'read', rows: [], reason: null });
    expect(res.dark).toContain(
      'quarantine ledger: the quarantine ledger holds no entries',
    );
  });
  it('quarantine trail: rows dated in window, by kind and cause', () => {
    const rows = [
      { kind: 'skip', cause: 'flaky', date: '2026-09-25T10:00:00-05:00' },
      { kind: 'constructor', cause: '', date: '2026-09-26T00:00:00Z' },
      { kind: 'skip', cause: 'flaky', date: '2026-01-01T00:00:00Z' },
      { kind: 'skip', date: '' },
    ];
    const res = tally([rec()], { state: 'read', rows, reason: null });
    expect(res.quarantine).toEqual({
      value: 2,
      denominator: 4,
      undated: 1,
      byKind: [
        ['constructor', 1],
        ['skip', 1],
      ],
      byCause: [
        ['flaky', 1],
        ['unrecorded', 1],
      ],
    });
    expect(
      res.dark.some((d: string) => d.startsWith('quarantine ledger')),
    ).toBe(false);
  });
  it('SC7: production escapes are always a dark source', () => {
    expect(tally([rec(), rec(), rec()]).dark).toContain(
      PRODUCTION_ESCAPES_DARK,
    );
    expect(tally([]).dark).toContain(PRODUCTION_ESCAPES_DARK);
  });
});

const digest = (runs: Run[], ledger?: unknown) =>
  renderDigest(tally(runs, ledger));

describe('digest', () => {
  it('SC1: sample line, per-metric denominators, fenced chat block', () => {
    const { markdown, chatBlock } = digest([
      rec({ branch: 'feat/x', tests: [t('a', 'failed')] }),
      rec(),
      rec({ reporter_format: 'playwright' }),
    ]);
    expect(markdown).toContain(
      '**Sample:** 3 runs across 1 suite on 1 day, 2026-09-21T00:00:00.000Z → 2026-09-28T00:00:00.000Z',
    );
    expect(markdown).toContain('## What testing caught');
    expect(markdown).toContain('- Tests executed: 1 across 3 runs');
    expect(markdown).toContain(
      '- Failures caught on branches other than main: 1 distinct failing test across 1 run',
    );
    expect(markdown).toContain(
      '- Flaky tests surfaced: 0 distinct tests across 1 flaky-capable run',
    );
    expect(markdown).toContain('```text\n' + chatBlock + '\n```');
  });
  it('SC1: chat block is <= 8 plain lines led by the sample line', () => {
    const cases: Run[][] = [[], [rec()], [rec(), rec(), rec()]];
    expect(CHAT_MAX_LINES).toBe(8);
    for (const runs of cases) {
      const lines = digest(runs).chatBlock.split('\n');
      expect(lines.length).toBeLessThanOrEqual(CHAT_MAX_LINES);
      expect(lines[0]).toMatch(/^canary-signal digest — \d+ runs? across/);
      expect(lines.join('\n')).not.toMatch(/\*\*|^#|^- /m);
    }
  });
  it('SC2: zero runs prints ABSTAINED and never the success copy', () => {
    const { markdown } = digest([]);
    expect(markdown).toContain('ABSTAINED: no runs recorded in the window');
    expect(markdown).not.toContain('What testing caught');
  });
  it('SC3: 1-2 runs prints a THIN SAMPLE banner stating the count', () => {
    expect(digest([rec(), rec()]).markdown).toContain(
      '**THIN SAMPLE:** 2 runs in the window',
    );
    expect(digest([rec()]).chatBlock).toContain('THIN SAMPLE');
    expect(digest([rec(), rec(), rec()]).markdown).not.toContain('THIN SAMPLE');
  });
  it('SC4/SC5: abstaining metrics print ABSTAINED and the reason', () => {
    const { markdown } = digest([rec(), rec(), rec()]);
    expect(markdown).toContain(
      '- Failures caught on branches other than main: ABSTAINED — no runs on branches other than main in the window',
    );
    expect(markdown).toMatch(
      /- Flaky tests surfaced: ABSTAINED — no run in the window came from a reporter that can emit flaky/,
    );
  });
  it('SC6/SC7: Dark sources names the missing ledger and escapes', () => {
    const dark = digest([rec()]).markdown.split('## Dark sources')[1];
    expect(dark).toContain('quarantine ledger: no quarantine ledger at');
    expect(dark).toContain('production escapes:');
  });
  it('D7: never claims a bug was prevented', () => {
    const runs = [rec({ branch: 'feat/x', tests: [t('a', 'failed')] })];
    expect(digest(runs).markdown).not.toMatch(/prevent/i);
  });
  it('renders the quarantine trail and the undated/unbranched notes', () => {
    const rows = [
      { kind: 'skip', cause: 'flaky', date: '2026-09-25T00:00:00Z' },
      { kind: 'skip', date: '' },
    ];
    const { markdown } = digest(
      [rec(), rec({ branch: undefined }), rec({ timestamp: 'nope' })],
      { state: 'read', rows, reason: null },
    );
    expect(markdown).toContain(
      '- Quarantine trail: 1 ledger row dated in the window of 2 (kind: skip 1; cause: flaky 1); 1 undated excluded',
    );
    expect(markdown).toContain(
      '- 1 undated run excluded (no parseable timestamp).',
    );
    expect(markdown).toContain(
      '- 1 run with no branch counted in neither branch line.',
    );
  });
  it('an in-window-empty ledger prints kind/cause as none', () => {
    const rows = [{ kind: 'skip', date: '2026-01-01T00:00:00Z' }];
    expect(
      digest([rec()], { state: 'read', rows, reason: null }).markdown,
    ).toContain(
      '0 ledger rows dated in the window of 1 (kind: none; cause: none)',
    );
  });
});

function runCli(argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    out.push(a.join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
    err.push(a.join(' '));
  });
  const code = main(argv);
  return { code, stdout: out.join('\n'), stderr: err.join('\n') };
}
function inDir<T>(dir: string, fn: () => T): T {
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    return fn();
  } finally {
    process.chdir(cwd);
  }
}
const three = () => [rec({ branch: 'feat/x' }), rec(), rec()];

describe('cli', () => {
  it('SC1: three runs => a full digest, exit 0', () => {
    const dir = tmp();
    const ledger = writeLedger(dir, [
      { kind: 'skip', cause: 'flaky', date: '2026-09-25T00:00:00Z' },
    ]);
    const argv = ['--history', writeStore(dir, three()), '--ledger', ledger];
    const res = runCli([...argv, '--until', UNTIL]);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('**Sample:** 3 runs');
    expect(res.stdout).toContain('```text');
  });
  it('SC2: an empty store abstains; exit 0 advisory, 3 under --strict', () => {
    const store = writeStore(tmp(), []);
    const advisory = runCli(['--history', store]);
    expect(advisory.code).toBe(0);
    expect(advisory.stdout).toContain('ABSTAINED');
    vi.restoreAllMocks();
    expect(runCli(['--history', store, '--strict']).code).toBe(3);
  });
  it('D9: --strict exits 0 on thin and full samples', () => {
    const dir = tmp();
    const base = ['--until', UNTIL, '--strict'];
    expect(runCli(['--history', writeStore(dir, three()), ...base]).code).toBe(
      0,
    );
    vi.restoreAllMocks();
    const thin = writeStore(tmp(), [rec()]);
    expect(runCli(['--history', thin, ...base]).code).toBe(0);
  });
  it('SC6: an explicit missing --ledger exits 1', () => {
    const dir = tmp();
    const res = runCli([
      '--history',
      writeStore(dir, three()),
      '--ledger',
      path.join(dir, 'typo.json'),
    ]);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('canary-signal: quarantine ledger not found');
  });
  it('SC6: the default ledger missing is a named dark source', () => {
    const dir = tmp();
    const store = writeStore(dir, three());
    const res = inDir(dir, () =>
      runCli(['--history', store, '--until', UNTIL]),
    );
    expect(res.code).toBe(0);
    expect(res.stdout).toContain(
      `quarantine ledger: no quarantine ledger at ${DEFAULT_LEDGER}`,
    );
  });
  it('a missing --history store exits 1, never "nothing caught"', () => {
    const res = runCli(['--history', path.join(tmp(), 'nope.jsonl')]);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('canary-signal: history store not found');
  });
  it('--days 0 and a bad --until are usage errors (exit 2)', () => {
    const store = writeStore(tmp(), []);
    const days = runCli(['--history', store, '--days', '0']);
    expect(days.code).toBe(2);
    expect(days.stderr).toContain('canary-signal: error: argument --days');
    vi.restoreAllMocks();
    expect(runCli(['--history', store, '--until', 'soon']).code).toBe(2);
  });
  it('--out writes the markdown, creating parent directories', () => {
    const dir = tmp();
    const out = path.join(dir, 'nested', 'signal.md');
    const argv = ['--history', writeStore(dir, three()), '--until', UNTIL];
    const res = runCli([...argv, '--out', out]);
    expect(res.code).toBe(0);
    expect(fs.readFileSync(out, 'utf8')).toBe(res.stdout);
  });
  it('an unwritable --out exits 1', () => {
    const dir = tmp();
    const blocker = writeRaw(dir, 'file', 'x');
    const res = runCli([
      '--history',
      writeStore(dir, three()),
      '--out',
      path.join(blocker, 'signal.md'),
    ]);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('cannot write artifact');
  });
  it('SC8: no network or process modules, and only cli.mjs writes', () => {
    const allowed =
      /^(node:fs|node:path|\.\.\/\.\.\/\.\.\/lib\/parse-args\.mjs|\.\/[a-z]+\.mjs)$/;
    const writers: string[] = [];
    for (const name of fs.readdirSync(SCRIPTS)) {
      const src = fs.readFileSync(path.join(SCRIPTS, name), 'utf8');
      for (const [, spec] of src.matchAll(/from '([^']+)'/g)) {
        expect(spec, `${name} imports ${spec}`).toMatch(allowed);
      }
      expect(src).not.toMatch(/\bfetch\(|child_process|node:https?|node:net/);
      if (/writeFileSync|appendFileSync|createWriteStream/.test(src)) {
        writers.push(name);
      }
    }
    expect(writers).toEqual(['cli.mjs']);
  });
  it('SC8: without --out, nothing on disk changes', () => {
    const storeDir = tmp();
    const store = writeStore(storeDir, three());
    const cwd = tmp();
    inDir(cwd, () => runCli(['--history', store]));
    expect(fs.readdirSync(cwd)).toEqual([]);
    expect(fs.readdirSync(storeDir)).toEqual(['history-v2.jsonl']);
  });
  it('SC9: --help exits 0, an unknown flag exits 2', () => {
    const help = runCli(['--help']);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('usage: canary-signal');
    vi.restoreAllMocks();
    expect(runCli(['--history', 'x', '--bogus']).code).toBe(2);
  });
  it('exports CLI_SPEC and ships an executable entry', () => {
    expect(CLI_SPEC.prog).toBe('canary-signal');
    expect(CLI_SPEC.required).toEqual(['--history']);
    const entry = path.join(SCRIPTS, 'cli.mjs');
    expect(
      fs.readFileSync(entry, 'utf8').startsWith('#!/usr/bin/env node\n'),
    ).toBe(true);
    expect(fs.statSync(entry).mode & 0o111).not.toBe(0);
  });
});
