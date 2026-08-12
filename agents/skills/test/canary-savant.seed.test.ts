// canary-savant --seed contract.
//
// --seed is a DETERMINISM flag, so every way of getting it wrong has to be a
// loud usage error. The original port did `Number(argv[i + 1])`, so both a
// missing value and a non-numeric one became NaN, failed the
// `Number.isFinite` guard in main, and fell through to
// `Math.floor(Math.random() * 1e6)` -- a flag whose entire purpose is
// reproducibility silently randomizing, at exit 0.
//
// The seed-is-honoured case needs the dynamic tier to actually report, and the
// real confirm() cannot be driven deterministically from main(): whether it
// reports or prints the "skipped" banner depends on detectShufflePlugin(),
// which interrogates the AMBIENT python3 rather than this repo, so the outcome
// differs between a machine with pytest-randomly installed and one without.
// Asserting `toContain('Tier 2 (dynamic)')` would also match the skipped
// banner, passing even if the seed were ignored entirely. runner.confirm is
// therefore stubbed here to echo the seed it was handed, which isolates the
// property under test: the parsed value reaches the confirmer intact, and the
// value used is exactly the value asked for.

import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../claude-code/canary-savant/scripts/runner.mjs', async (orig) => {
  const actual =
    await orig<
      typeof import('../claude-code/canary-savant/scripts/runner.mjs')
    >();
  return {
    ...actual,
    // Echo the seed back through the normal `status: 'ok'` render path.
    confirm: (_paths: string[], options: { seed: number }) => ({
      status: 'ok',
      seed: options.seed,
      framework: 'pytest',
      victims: [],
      nondeterministic: [],
      reproduce: '',
    }),
  };
});

const { main } = await import('../claude-code/canary-savant/scripts/cli.mjs');

const mkTmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'savant-seed-'));

describe('--seed reaches the confirmer intact', () => {
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

  it.each([42, 7, 424242])('--seed %i is the seed that gets used', (seed) => {
    const root = tmp();
    capture();
    expect(main([root, '--confirm', '--seed', String(seed)])).toBe(0);
    // The exact string, not just "Tier 2 (dynamic)" -- the skipped banner
    // starts with that prefix too and would match a randomized run.
    expect(out.join('\n')).toContain(`Tier 2 (dynamic): seed ${seed}`);
  });

  it('--seed=42 (inline form) is the seed that gets used', () => {
    const root = tmp();
    capture();
    expect(main([root, '--confirm', '--seed=42'])).toBe(0);
    expect(out.join('\n')).toContain('Tier 2 (dynamic): seed 42');
  });

  // Negative seeds are supported, so BOTH documented spellings must reach
  // them. `--seed -5` used to die with "expected one argument" -- a false
  // message, since an argument was in fact supplied -- purely because the
  // value starts with '-'.
  it.each([
    ['inline', ['--seed=-5']],
    ['separate token', ['--seed', '-5']],
  ])('a negative seed is accepted in the %s form', (_label, seedArgs) => {
    const root = tmp();
    capture();
    expect(main([root, '--confirm', ...seedArgs])).toBe(0);
    expect(out.join('\n')).toContain('Tier 2 (dynamic): seed -5');
  });

  it('--seed still refuses to swallow a following flag', () => {
    const root = tmp();
    capture();
    expect(main([root, '--seed', '--json'])).toBe(2);
    expect(err.join('\n')).toContain('argument --seed: expected one argument');
  });

  // A seed above Number.MAX_SAFE_INTEGER is silently rounded by Number(), so
  // the seed USED differs from the seed ASKED FOR -- a determinism flag lying
  // about its own value. Larger still becomes 1e26, which runner.mjs
  // interpolates as `--randomly-seed=1e+26` and pytest-randomly rejects.
  it.each([
    '9007199254740993',
    '99999999999999999999999999',
    '-9007199254740993',
  ])('--seed %s is rejected as out of safe integer range', (value) => {
    const root = tmp();
    capture();
    expect(main([root, '--confirm', '--seed', value])).toBe(2);
    expect(err.join('\n')).toContain(
      `argument --seed: integer out of safe range: '${value}'`,
    );
    expect(out.join('\n')).not.toContain('Tier 2 (dynamic)');
  });

  it('the largest safe seed is still accepted', () => {
    const root = tmp();
    capture();
    expect(main([root, '--confirm', '--seed', '9007199254740991'])).toBe(0);
    expect(out.join('\n')).toContain('Tier 2 (dynamic): seed 9007199254740991');
  });

  // The property behind all of the above: whatever seed is accepted, the
  // value handed to the confirmer round-trips to the exact digits requested.
  it.each(['0', '1', '42', '-5', '9007199254740991'])(
    'the seed used for %s is exactly the seed asked for',
    (value) => {
      const root = tmp();
      capture();
      expect(main([root, '--confirm', '--seed', value])).toBe(0);
      expect(out.join('\n')).toContain(
        `Tier 2 (dynamic): seed ${Number(value)}`,
      );
    },
  );

  // The regression that matters: every rejected form must exit 2 WITHOUT
  // running the confirmer, so it can never fall back to a random seed.
  it.each([
    ['abc', "invalid int value: 'abc'"],
    ['3.7', "invalid int value: '3.7'"],
    ['1e999', "invalid int value: '1e999'"],
    // Empty is the missing-value case wearing a disguise, so the shared
    // parser reports it as arity rather than as a bad int (#479).
    ['', 'expected one argument'],
    ['0x10', "invalid int value: '0x10'"],
  ])('--seed %s is rejected, never randomized', (value, message) => {
    const root = tmp();
    capture();
    expect(main([root, '--confirm', '--seed', value])).toBe(2);
    expect(err.join('\n')).toContain(`argument --seed: ${message}`);
    expect(out.join('\n')).not.toContain('Tier 2 (dynamic)');
  });

  it('--seed=abc (inline form) is rejected too', () => {
    const root = tmp();
    capture();
    expect(main([root, '--confirm', '--seed=abc'])).toBe(2);
    expect(err.join('\n')).toContain(
      "argument --seed: invalid int value: 'abc'",
    );
    expect(out.join('\n')).not.toContain('Tier 2 (dynamic)');
  });

  it('--seed with no value is rejected, never randomized', () => {
    const root = tmp();
    capture();
    expect(main([root, '--confirm', '--seed'])).toBe(2);
    expect(err.join('\n')).toContain('argument --seed: expected one argument');
    expect(out.join('\n')).not.toContain('Tier 2 (dynamic)');
  });
});
