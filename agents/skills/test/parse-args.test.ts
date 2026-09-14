/**
 * Unit contract for the shared skill-CLI argument parser (#479).
 *
 * Five skills hand-rolled this loop and the same bug class came back three
 * consecutive rounds -- not through carelessness, but because the pattern was
 * copy-paste and the only thing holding the line was a block of tests
 * hand-copied into each skill's suite. Two of those copies had already drifted
 * into passing against buggy code.
 *
 * This file is the single place the four shared invariants are stated:
 *   1. null-prototype flag lookup (an inherited key must never resolve)
 *   2. empty-value rejection (both `--flag=` and `--flag ''`)
 *   3. arity checking (`argument <flag>: expected one argument`)
 *   4. `--flag=value` support
 *
 * `skill-cli-conformance.test.ts` is the other half: it proves every skill
 * declaring `cli:` in its SKILL.md actually routes through this parser, so a
 * sixth skill cannot land with its own copy.
 */
import { describe, it, expect } from 'vitest';

import { createParser, formatUsageError } from '../lib/parse-args.mjs';

const katanaish = () =>
  createParser({
    prog: 'canary-test',
    booleans: { '--json': 'json', '--strict': 'strict' },
    values: { '--repo': { key: 'repo' }, '--ledger': { key: 'ledger' } },
    defaults: { repo: '.' },
  });

const positionalish = () =>
  createParser({
    prog: 'canary-test',
    booleans: { '--json': 'json' },
    positionals: { key: 'paths', defaults: ['.'] },
  });

describe('createParser -- invariant 1: null-prototype lookup', () => {
  // A plain object literal resolves every Object.prototype key truthily, so
  // `VALUE_FLAGS['toString']` was a function and the token got swallowed as a
  // value flag instead of rejected. In katana that ran a scan and appended to
  // the ledger; in canary-shadow a case labelled `toString` reported accepted
  // instead of DIVERGE, suppressing a parity failure in a parity tool.
  for (const key of ['toString', 'constructor', 'valueOf', '__proto__']) {
    it(`rejects the inherited key --${key} as an unknown flag`, () => {
      const r = katanaish()(['--' + key, 'x']);
      expect(r.error).toBe(`unrecognized arguments: --${key}`);
    });

    it(`rejects the bare inherited token ${key}`, () => {
      const r = katanaish()([key]);
      expect(r.error).toBe(`unrecognized arguments: ${key}`);
    });

    it(`rejects the inherited key as a boolean flag --${key}`, () => {
      const r = positionalish()(['--' + key]);
      expect(r.error).toBe(`unrecognized arguments: --${key}`);
    });
  }
});

describe('createParser -- invariant 2: empty-value rejection', () => {
  // `--repo=` is typed by nobody, but `--repo "$UNSET_VAR"` expands to
  // `--repo ''` in any shell, and an accepted empty path silently retargets
  // writes at the process CWD.
  it('rejects --flag= (inline spelling)', () => {
    expect(katanaish()(['--repo=']).error).toBe(
      'argument --repo: expected one argument',
    );
  });

  it("rejects --flag '' (separate-token spelling)", () => {
    expect(katanaish()(['--repo', '']).error).toBe(
      'argument --repo: expected one argument',
    );
  });
});

describe('createParser -- invariant 3: arity checking', () => {
  it('rejects a value flag left last', () => {
    expect(katanaish()(['--repo']).error).toBe(
      'argument --repo: expected one argument',
    );
  });

  it('refuses to consume the next flag as a value', () => {
    expect(katanaish()(['--repo', '--json']).error).toBe(
      'argument --repo: expected one argument',
    );
  });

  it('reports every missing required flag in one message', () => {
    const parse = createParser({
      prog: 'canary-test',
      values: { '--spans': { key: 'spans' }, '--output': { key: 'output' } },
      required: ['--spans', '--output'],
    });
    expect(parse([]).error).toBe(
      'the following arguments are required: --spans, --output',
    );
  });

  it('does not report required flags when --help was asked for', () => {
    const parse = createParser({
      prog: 'canary-test',
      values: { '--spans': { key: 'spans' } },
      required: ['--spans'],
    });
    const r = parse(['--help']);
    expect(r.help).toBe(true);
    expect(r.error).toBeNull();
  });
});

describe('createParser -- invariant 4: --flag=value', () => {
  it('accepts the inline spelling', () => {
    expect(katanaish()(['--repo=/tmp/x']).opts.repo).toBe('/tmp/x');
  });

  it('accepts the separate-token spelling', () => {
    expect(katanaish()(['--repo', '/tmp/x']).opts.repo).toBe('/tmp/x');
  });

  it('keeps an = inside the value', () => {
    expect(katanaish()(['--repo=a=b']).opts.repo).toBe('a=b');
  });
});

describe('createParser -- help and defaults', () => {
  it('sets help for both spellings and short-circuits the rest of argv', () => {
    for (const spelling of ['-h', '--help']) {
      const r = katanaish()([spelling, '--bogus']);
      expect(r.help).toBe(true);
      expect(r.error).toBeNull();
    }
  });

  it('applies declared defaults', () => {
    expect(katanaish()([]).opts.repo).toBe('.');
  });

  it('defaults booleans to false', () => {
    const r = katanaish()([]);
    expect(r.opts.json).toBe(false);
    expect(r.opts.strict).toBe(false);
  });

  it('sets booleans when present', () => {
    const r = katanaish()(['--json', '--strict']);
    expect(r.opts.json).toBe(true);
    expect(r.opts.strict).toBe(true);
  });
});

describe('createParser -- positionals', () => {
  it('collects positionals and applies the declared default', () => {
    expect(positionalish()([]).positionals).toEqual(['.']);
    expect(positionalish()(['a', 'b']).positionals).toEqual(['a', 'b']);
  });

  it('treats a lone - as a positional, as argparse does', () => {
    expect(positionalish()(['-']).positionals).toEqual(['-']);
  });

  it('treats every token after -- as a positional', () => {
    // So a file literally named `--json` stays reachable.
    expect(positionalish()(['--', '--json']).positionals).toEqual(['--json']);
  });

  it('rejects -- when the CLI declares no positionals', () => {
    // A documented divergence, now enforced rather than incidental: a CLI that
    // takes no paths has nothing for an end-of-options marker to protect.
    expect(katanaish()(['--']).error).toBe('unrecognized arguments: --');
  });

  it('rejects a stray token when the CLI declares no positionals', () => {
    expect(katanaish()(['stray']).error).toBe('unrecognized arguments: stray');
  });
});

describe('createParser -- int-typed values', () => {
  const parse = () =>
    createParser({
      prog: 'canary-test',
      values: { '--seed': { key: 'seed', type: 'int' } },
    });

  it('parses an integer to a number', () => {
    expect(parse()(['--seed', '42']).opts.seed).toBe(42);
  });

  it('accepts a negative integer in both spellings', () => {
    // A leading '-' normally means "the next flag", but a well-formed integer
    // is a legitimate value -- otherwise `--seed -5` died with a false
    // "expected one argument" while `--seed=-5` worked.
    expect(parse()(['--seed', '-5']).opts.seed).toBe(-5);
    expect(parse()(['--seed=-5']).opts.seed).toBe(-5);
  });

  it('accepts an explicit + sign', () => {
    expect(parse()(['--seed=+5']).opts.seed).toBe(5);
  });

  it('rejects an integer past the safe range rather than rounding it', () => {
    // Number() silently rounds 9007199254740993 to ...992, so the value used
    // would differ from the value asked for -- in the one flag whose purpose
    // is reproducibility.
    expect(parse()(['--seed=9007199254740993']).error).toBe(
      "argument --seed: integer out of safe range: '9007199254740993'",
    );
  });

  for (const bad of ['abc', '3.7', '1e999', '0x10']) {
    it(`rejects the non-integer value '${bad}'`, () => {
      // The one flag whose entire purpose is reproducibility used to decay to
      // a random seed at exit 0 when its value was unparseable.
      expect(parse()([`--seed=${bad}`]).error).toBe(
        `argument --seed: invalid int value: '${bad}'`,
      );
    });
  }
});

describe('formatUsageError', () => {
  it('renders argparse-faithfully', () => {
    // The family's comments have claimed "matches argparse" throughout; two
    // stderr formats shipped under that one banner. argparse prints
    // `prog: error: message`, so that is the one that survives.
    expect(
      formatUsageError('canary-katana', 'unrecognized arguments: --x'),
    ).toBe('canary-katana: error: unrecognized arguments: --x');
  });
});

/**
 * Public-API pin table (#906). `createParser` is the parser behind every
 * bundled skill's `cli:` entry, so the WHOLE parse result -- opts, positionals,
 * help and the exact error text skills print -- is the contract. Each row pins
 * one branch end to end, so a refactor that moves a branch's result anywhere
 * (not only its error) goes red here before it reaches a skill.
 */
describe('createParser -- public-API pin table (#906)', () => {
  const full = () =>
    createParser({
      prog: 'canary-test',
      booleans: { '--json': 'json', '-v': 'verbose' },
      values: {
        '--repo': { key: 'repo' },
        '-o': { key: 'out' },
        '--seed': { key: 'seed', type: 'int' },
      },
      defaults: { repo: '.' },
      positionals: { key: 'paths', defaults: ['.'] },
    });
  const noPositionals = () =>
    createParser({
      prog: 'canary-test',
      booleans: { '--json': 'json' },
      values: {
        '--repo': { key: 'repo' },
        '--seed': { key: 'seed', type: 'int' },
      },
    });

  const plain = (r: {
    opts: Record<string, unknown>;
    positionals: string[];
    help: boolean;
    error: string | null;
  }) => ({ ...r, opts: { ...r.opts } });

  const base = {
    json: false,
    verbose: false,
    repo: '.',
    out: null,
    seed: null,
  };
  const bare = { json: false, repo: null, seed: null };

  type Result = {
    opts: Record<string, unknown>;
    positionals: string[];
    help: boolean;
    error: string | null;
  };
  type Row = [
    string,
    () => (argv: string[]) => Result,
    string[] | undefined,
    Result,
  ];
  type Opts = Record<string, unknown>;
  const ok = (opts: Opts, positionals: string[] = ['.']): Result => ({
    opts,
    positionals,
    help: false,
    error: null,
  });
  const err = (
    opts: Opts,
    error: string,
    positionals: string[] = [],
  ): Result => ({
    opts,
    positionals,
    help: false,
    error,
  });

  const rows: Row[] = [
    ['no argv at all uses [] and applies defaults', full, undefined, ok(base)],
    ['empty argv', full, [], ok(base)],
    ['--flag value', full, ['--repo', 'r'], ok({ ...base, repo: 'r' })],
    ['--flag=value', full, ['--repo=r'], ok({ ...base, repo: 'r' })],
    [
      'inline value may itself look like a flag',
      full,
      ['--repo=--json'],
      ok({ ...base, repo: '--json' }),
    ],
    ['declared short value flag', full, ['-o', 'x'], ok({ ...base, out: 'x' })],
    ['declared short boolean', full, ['-v'], ok({ ...base, verbose: true })],
    [
      'short flags never split on =',
      full,
      ['-o=x'],
      err(base, 'unrecognized arguments: -o=x'),
    ],
    [
      'a boolean given an inline value is unrecognized',
      full,
      ['--json=1'],
      err(base, 'unrecognized arguments: --json=1'),
    ],
    [
      'repeated value flag: last wins',
      full,
      ['--repo', 'a', '--repo=b'],
      ok({ ...base, repo: 'b' }),
    ],
    [
      'repeated boolean stays true',
      full,
      ['--json', '--json'],
      ok({ ...base, json: true }),
    ],
    [
      'unknown long flag',
      full,
      ['--bogus'],
      err(base, 'unrecognized arguments: --bogus'),
    ],
    [
      'unknown short flag with positionals declared',
      full,
      ['-x'],
      err(base, 'unrecognized arguments: -x'),
    ],
    [
      '--=x is not the terminator',
      full,
      ['--=x'],
      err(base, 'unrecognized arguments: --=x'),
    ],
    [
      'first failure stops the scan',
      full,
      ['--bogus', '--json', '-h'],
      err(base, 'unrecognized arguments: --bogus'),
    ],
    [
      'options before help are kept',
      full,
      ['--json', '-h', '--bogus'],
      {
        opts: { ...base, json: true },
        positionals: [],
        help: true,
        error: null,
      },
    ],
    [
      'help after -- is a positional',
      full,
      ['--', '-h', '--'],
      ok(base, ['-h', '--']),
    ],
    [
      'positionals mixed with flags keep order',
      full,
      ['a', '--json', 'b', '-'],
      ok({ ...base, json: true }, ['a', 'b', '-']),
    ],
    [
      'value consumed by a flag is not re-read as a positional',
      full,
      ['--repo', 'r', 'p'],
      ok({ ...base, repo: 'r' }, ['p']),
    ],
    [
      'value flag at end of argv',
      full,
      ['--seed'],
      err(base, 'argument --seed: expected one argument'),
    ],
    [
      'value flag given the empty string',
      full,
      ['--seed', ''],
      err(base, 'argument --seed: expected one argument'),
    ],
    [
      'int flag given --seed=',
      full,
      ['--seed='],
      err(base, 'argument --seed: expected one argument'),
    ],
    [
      'short value flag at end of argv',
      full,
      ['-o'],
      err(base, 'argument -o: expected one argument'),
    ],
    [
      'int flag refuses a non-integer dash token',
      full,
      ['--seed', '-abc'],
      err(base, 'argument --seed: expected one argument'),
    ],
    [
      'string flag refuses even an integer-looking dash token',
      full,
      ['--repo', '-5'],
      err(base, 'argument --repo: expected one argument'),
    ],
    [
      'int flag takes a separate negative token',
      full,
      ['--seed', '-7'],
      ok({ ...base, seed: -7 }),
    ],
    [
      'int flag with leading zeros',
      full,
      ['--seed', '007'],
      ok({ ...base, seed: 7 }),
    ],
    [
      'int flag invalid value (separate token)',
      full,
      ['--seed', '1.5'],
      err(base, "argument --seed: invalid int value: '1.5'"),
    ],
    [
      'int flag invalid value keeps surrounding whitespace in the message',
      full,
      ['--seed', ' 5'],
      err(base, "argument --seed: invalid int value: ' 5'"),
    ],
    [
      'int flag out of safe range (negative, separate token)',
      full,
      ['--seed', '-9007199254740992'],
      err(
        base,
        "argument --seed: integer out of safe range: '-9007199254740992'",
      ),
    ],
    [
      'the largest safe integer is accepted',
      full,
      ['--seed=9007199254740991'],
      ok({ ...base, seed: 9007199254740991 }),
    ],
    [
      'no positionals: -- is unrecognized',
      noPositionals,
      ['--', 'x'],
      err(bare, 'unrecognized arguments: --'),
    ],
    [
      'no positionals: lone - is unrecognized',
      noPositionals,
      ['-'],
      err(bare, 'unrecognized arguments: -'),
    ],
    [
      'no positionals: stray token',
      noPositionals,
      ['--json', 'stray'],
      err({ ...bare, json: true }, 'unrecognized arguments: stray'),
    ],
    [
      'no positionals: clean run has an empty positional list',
      noPositionals,
      ['--seed=3'],
      ok({ ...bare, seed: 3 }, []),
    ],
  ];

  for (const [name, make, argv, expected] of rows) {
    it(name, () => {
      const parse = make();
      const r =
        argv === undefined ? (parse as unknown as () => Result)() : parse(argv);
      expect(plain(r)).toEqual(expected);
      expect(Object.getPrototypeOf(r.opts)).toBeNull();
    });
  }

  it('gives each call fresh opts and positionals', () => {
    const parse = full();
    const first = parse(['--json', 'a']);
    const second = parse([]);
    expect(second.opts.json).toBe(false);
    expect(second.positionals).toEqual(['.']);
    expect(first.positionals).toEqual(['a']);
  });

  it('applies defaults to boolean keys and int keys', () => {
    const parse = createParser({
      prog: 'p',
      booleans: { '--json': 'json' },
      values: { '--seed': { key: 'seed', type: 'int' } },
      defaults: { json: true, seed: 7 },
    });
    expect(plain(parse([]))).toEqual({
      opts: { json: true, seed: 7 },
      positionals: [],
      help: false,
      error: null,
    });
  });

  it('does not apply positional defaults when none are declared', () => {
    const parse = createParser({ prog: 'p', positionals: { key: 'paths' } });
    expect(parse([]).positionals).toEqual([]);
  });

  it('a default satisfies a required flag', () => {
    const parse = createParser({
      prog: 'p',
      values: { '--branch': { key: 'branch' } },
      defaults: { branch: 'main' },
      required: ['--branch'],
    });
    expect(plain(parse([]))).toEqual({
      opts: { branch: 'main' },
      positionals: [],
      help: false,
      error: null,
    });
  });

  it('reports only the missing required flags, before positional defaults', () => {
    const parse = createParser({
      prog: 'p',
      values: { '--a': { key: 'a' }, '--b': { key: 'b' } },
      required: ['--a', '--b'],
      positionals: { key: 'paths', defaults: ['.'] },
    });
    expect(plain(parse(['--a', 'x']))).toEqual({
      opts: { a: 'x', b: null },
      positionals: [],
      help: false,
      error: 'the following arguments are required: --b',
    });
  });

  it('help wins over missing required flags with exact result', () => {
    const parse = createParser({
      prog: 'p',
      values: { '--a': { key: 'a' } },
      required: ['--a'],
    });
    expect(plain(parse(['-h']))).toEqual({
      opts: { a: null },
      positionals: [],
      help: true,
      error: null,
    });
  });

  it('construction errors carry exact messages', () => {
    expect(() => createParser({} as never)).toThrow(
      new Error('createParser: spec.prog is required'),
    );
    expect(() => createParser(undefined as never)).toThrow(
      new Error('createParser: spec.prog is required'),
    );
    expect(() =>
      createParser({ prog: 'x', booleans: { '--j': 'j' }, defaults: { k: 1 } }),
    ).toThrow(new Error("createParser: defaults names unknown key 'k'"));
    expect(() =>
      createParser({ prog: 'x', booleans: { '--j': 'j' }, required: ['--j'] }),
    ).toThrow(new Error("createParser: required names undeclared flag '--j'"));
  });
});

describe('createParser -- spec validation', () => {
  it('rejects a spec whose default names no declared flag', () => {
    // Cheap guard against a rename leaving a dead default behind.
    expect(() =>
      createParser({
        prog: 'x',
        values: { '--a': { key: 'a' } },
        defaults: { b: 1 },
      }),
    ).toThrow(/unknown key 'b'/);
  });

  it('rejects a required flag that is not declared', () => {
    expect(() =>
      createParser({
        prog: 'x',
        values: { '--a': { key: 'a' } },
        required: ['--b'],
      }),
    ).toThrow(/undeclared flag '--b'/);
  });
});
