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
