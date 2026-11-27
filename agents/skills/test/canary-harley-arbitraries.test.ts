/**
 * canary-harley (#616) -- type nodes to fast-check and Hypothesis expressions,
 * and the text of the two generated test files. Cases are tagged with the
 * spec's success criteria (docs/changes/616-canary-harley/proposal.md).
 * Fixtures are synthetic.
 */
import { describe, expect, it } from 'vitest';

import {
  toFastCheck,
  toHypothesis,
} from '../claude-code/canary-harley/scripts/arbitraries.mjs';
import { renderFastCheck } from '../claude-code/canary-harley/scripts/emit-fast-check.mjs';
import { renderHypothesis } from '../claude-code/canary-harley/scripts/emit-hypothesis.mjs';
import { buildProposal } from '../claude-code/canary-harley/scripts/proposal.mjs';
import { parseType } from '../claude-code/canary-harley/scripts/types.mjs';

type Lang = 'typescript' | 'javascript' | 'python';

const ts = (text: string) => parseType(text, 'typescript' as Lang);
const py = (text: string) => parseType(text, 'python' as Lang);

// [label, node, fast-check, Hypothesis]
const TABLE: [string, object, string, string][] = [
  ['string', ts('string'), 'fc.string()', 'st.text()'],
  [
    'number',
    ts('number'),
    'fc.double({ noNaN: true })',
    'st.floats(allow_nan=False)',
  ],
  ['integer', py('int'), 'fc.integer()', 'st.integers()'],
  ['boolean', ts('boolean'), 'fc.boolean()', 'st.booleans()'],
  ['bigint', ts('bigint'), 'fc.bigInt()', 'st.integers()'],
  ['bytes', ts('Uint8Array'), 'fc.uint8Array()', 'st.binary()'],
  ['null', ts('null'), 'fc.constant(null)', 'st.none()'],
  ['array', ts('string[]'), 'fc.array(fc.string())', 'st.lists(st.text())'],
  [
    'tuple',
    py('tuple[str, int]'),
    'fc.tuple(fc.string(), fc.integer())',
    'st.tuples(st.text(), st.integers())',
  ],
  [
    'record',
    ts('Record<string, number>'),
    'fc.dictionary(fc.string(), fc.double({ noNaN: true }))',
    'st.dictionaries(st.text(), st.floats(allow_nan=False))',
  ],
  [
    'object',
    ts('{ id: string }'),
    'fc.record({ "id": fc.string() })',
    'st.fixed_dictionaries({"id": st.text()})',
  ],
  [
    'object with an optional field',
    ts('{ id: string; tag?: boolean }'),
    'fc.record({ "id": fc.string(), "tag": fc.boolean() }, ' +
      '{ requiredKeys: ["id"] })',
    'st.fixed_dictionaries({"id": st.text()}, ' +
      'optional={"tag": st.booleans()})',
  ],
  [
    'optional',
    ts('string | undefined'),
    'fc.option(fc.string(), { nil: undefined })',
    'st.one_of(st.none(), st.text())',
  ],
  [
    'union',
    ts('string | boolean'),
    'fc.oneof(fc.string(), fc.boolean())',
    'st.one_of(st.text(), st.booleans())',
  ],
  ['literal text', ts("'asc'"), 'fc.constant("asc")', 'st.just("asc")'],
  ['literal true', ts('true'), 'fc.constant(true)', 'st.just(True)'],
  ['literal false', ts('false'), 'fc.constant(false)', 'st.just(False)'],
  ['literal number', ts('3'), 'fc.constant(3)', 'st.just(3)'],
];

const CODEC_TS = `export function encodeToken(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}
export function decodeToken(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}
export function normalizeSlug(value: string): string {
  return value.trim().toLowerCase();
}
export const isSlug = (value: string): boolean => /^[a-z0-9-]+$/.test(value);
export function mergeCounts(a: number[], b: number[]): number[] {
  return a.map((n, i) => n + (b[i] ?? 0));
}
export function sortScores(values: number[]): number[] {
  return [...values].sort((x, y) => x - y);
}
`;

const CODEC_NAMES_TS = [
  'encodeToken',
  'decodeToken',
  'normalizeSlug',
  'mergeCounts',
  'sortScores',
  'isSlug',
];

const CODEC_PY = `def encode_token(text: str) -> bytes:
    return text.encode("utf-8")


def decode_token(data: bytes) -> str:
    return data.decode("utf-8")


def normalize_slug(value: str) -> str:
    return value.strip().lower()


def is_slug(value: str) -> bool:
    return value.isalnum()


def merge_counts(a: list[int], b: list[int]) -> list[int]:
    return a


def sort_scores(values: list[int]) -> list[int]:
    return sorted(values)
`;

const CODEC_NAMES_PY = [
  'encode_token',
  'decode_token',
  'normalize_slug',
  'is_slug',
  'merge_counts',
  'sort_scores',
];

type Candidate = { id: string; kind: string; functions: string[] };
type Signature = { name: string };
type Proposal = { candidates: Candidate[]; signatures: Signature[] };

const TS_PROPOSAL = buildProposal({
  path: 'src/codec.ts',
  source: CODEC_TS,
  names: CODEC_NAMES_TS,
}) as Proposal;

const PY_PROPOSAL = buildProposal({
  path: 'src/codec.py',
  source: CODEC_PY,
  names: CODEC_NAMES_PY,
}) as Proposal;

/** The render spec for the one candidate of `kind` whose first function is `fn`. */
function specOf(proposal: Proposal, kind: string, fn: string) {
  const found = proposal.candidates.filter(
    (c) => c.kind === kind && c.functions[0] === fn,
  );
  expect(found).toHaveLength(1);
  const signatures: object[] = found[0].functions.map(
    (name) => proposal.signatures.filter((sig) => sig.name === name)[0],
  );
  const python = proposal === PY_PROPOSAL;
  return {
    candidate: found[0],
    signatures,
    importPath: python ? 'src.codec' : '../../../src/codec',
    stem: 'codec',
    seed: 4242,
    runs: 100,
  };
}

const ASCII = /^[\n\x20-\x7E]*$/;

/** Lines that are code: not blank and not a comment. */
const codeLines = (text: string) =>
  text
    .split('\n')
    .filter((line) => line.trim() !== '' && !/^\s*(\/\/|#)/.test(line));

describe('canary-harley emit: renderFastCheck', () => {
  const spec = specOf(TS_PROPOSAL, 'round-trip', 'encodeToken');
  const text = renderFastCheck(spec);

  it('records the candidate, statement and seed in the header (SC5)', () => {
    const header = text.split('\n').filter((line) => line.startsWith('//'));
    const joined = header.join('\n');
    expect(joined).toContain(`Candidate: ${spec.candidate.id}`);
    expect(joined).toContain('decodeToken(encodeToken(x)) equals x');
    expect(joined).toContain('Seed: 4242');
    expect(joined).toContain('harness-property-test');
    expect(joined).toMatch(/Adjust the import/);
  });

  it('imports vitest, fast-check and the functions, names sorted', () => {
    expect(text).toContain("import { describe, expect, it } from 'vitest';\n");
    expect(text).toContain("import fc from 'fast-check';\n");
    expect(text).toContain(
      "import { decodeToken, encodeToken } from '../../../src/codec';\n",
    );
  });

  it('passes the SEED constant to fc.assert and nothing else (SC5)', () => {
    expect(text).toContain('const SEED = 4242;\n');
    expect(text).toContain('const NUM_RUNS = 100;\n');
    expect(text).toMatch(
      /fc\.assert\(\n\s+fc\.property\([\s\S]+?\}\),\n\s+\{ seed: SEED, numRuns: NUM_RUNS \},\n\s+\);/,
    );
    const withSeed = codeLines(text).filter((line) => line.includes('4242'));
    expect(withSeed).toEqual(['const SEED = 4242;']);
  });

  it("generates the first function's parameter, not the second's", () => {
    expect(text).toContain('fc.property(fc.string(), (a) => {');
    expect(text).toContain('expect(decodeToken(encodeToken(a))).toEqual(a);');
    expect(text).not.toContain('fc.uint8Array()');
  });

  it.each([
    [
      'idempotence',
      'normalizeSlug',
      'expect(normalizeSlug(normalizeSlug(a))).toEqual(normalizeSlug(a));',
    ],
    [
      'involution',
      'normalizeSlug',
      'expect(normalizeSlug(normalizeSlug(a))).toEqual(a);',
    ],
    [
      'commutativity',
      'mergeCounts',
      'expect(mergeCounts(a, b)).toEqual(mergeCounts(b, a));',
    ],
    [
      'length-preserving',
      'sortScores',
      'expect(sortScores(a)).toHaveLength(a.length);',
    ],
    ['total-predicate', 'isSlug', "expect(typeof isSlug(a)).toBe('boolean');"],
  ])('writes the %s body', (kind, fn, line) => {
    const out = renderFastCheck(specOf(TS_PROPOSAL, kind, fn));
    expect(out.split('\n').map((l) => l.trim())).toContain(line);
    expect(out).not.toContain('outcome');
  });

  // A parser that throws on bad input is still deterministic. Comparing the
  // two calls directly would fail on the first throw, for a reason unrelated
  // to the invariant, so both outcomes are captured and compared.
  it('compares outcomes for determinism, so a repeated throw passes', () => {
    const out = renderFastCheck(
      specOf(TS_PROPOSAL, 'determinism', 'mergeCounts'),
    );
    expect(out).toContain(
      'const outcome = (run: () => unknown) => {\n' +
        '  try {\n' +
        '    return { value: run() };\n' +
        '  } catch (error) {\n' +
        '    return { threw: String(error) };\n' +
        '  }\n' +
        '};\n',
    );
    const lines = out.split('\n').map((l) => l.trim());
    expect(lines).toContain('const first = outcome(() => mergeCounts(a, b));');
    expect(lines).toContain(
      'expect(outcome(() => mergeCounts(a, b))).toEqual(first);',
    );
  });

  it('generates one argument per parameter', () => {
    const out = renderFastCheck(
      specOf(TS_PROPOSAL, 'commutativity', 'mergeCounts'),
    );
    const item = 'fc.array(fc.double({ noNaN: true }))';
    expect(out).toContain(`fc.property(${item}, ${item}, (a, b) => {`);
  });

  it('is ASCII, ends with one newline and renders the same twice', () => {
    expect(text).toMatch(ASCII);
    expect(text.endsWith(';\n')).toBe(true);
    expect(renderFastCheck(spec)).toBe(text);
  });

  it('keeps planted text inside its string or its comment line', () => {
    const planted = {
      ...spec,
      importPath: "../src/it's\n'; danger(); //",
      candidate: {
        ...spec.candidate,
        id: 'round-trip:x\n*/ danger();',
        statement: "x'\n); danger(); /* */ \u2028 y",
      },
    };
    const out = renderFastCheck(planted);
    expect(out).toMatch(ASCII);
    expect(out).toContain("from '../src/it\\'s\\n\\'; danger(); //';\n");
    const code = codeLines(out).filter((line) => line.includes('danger'));
    // Each survivor is one line that is a single string literal's host.
    expect(code).toHaveLength(2);
    expect(code[0]).toMatch(/^import \{.*\} from '.*';$/);
    expect(code[1]).toMatch(/^describe\('.*', \(\) => \{$/);
    const comments = out.split('\n').filter((line) => line.startsWith('//'));
    expect(comments.join('\n')).not.toContain('*/');
    expect(comments.join('\n')).toContain('Candidate: round-trip:x * / dan');
    expect(out.split('\n')).toHaveLength(text.split('\n').length);
  });
});

describe('canary-harley emit: renderHypothesis', () => {
  const spec = specOf(PY_PROPOSAL, 'round-trip', 'encode_token');
  const text = renderHypothesis(spec);

  it('records the candidate, statement and seed in the header (SC5)', () => {
    const header = text.split('\n').filter((line) => line.startsWith('#'));
    const joined = header.join('\n');
    expect(joined).toContain(`Candidate: ${spec.candidate.id}`);
    expect(joined).toContain('decode_token(encode_token(x)) equals x');
    expect(joined).toContain('Seed: 4242');
    expect(joined).toContain('harness-property-test');
    expect(joined).toMatch(/Adjust the import/);
  });

  it('imports hypothesis and the functions, names sorted', () => {
    expect(text).toContain('from hypothesis import given, seed, settings\n');
    expect(text).toContain('from hypothesis import strategies as st\n');
    expect(text).toContain(
      'from src.codec import decode_token, encode_token\n',
    );
  });

  it('seeds the test and switches off the varying parts (SC5)', () => {
    expect(text).toContain('SEED = 4242\n');
    expect(text).toContain('MAX_EXAMPLES = 100\n');
    expect(text).toContain(
      '@seed(SEED)\n' +
        '@settings(max_examples=MAX_EXAMPLES, database=None, deadline=None)\n' +
        '@given(a=st.text())\n' +
        'def test_codec_encode_token_decode_token_round_trip(a):\n' +
        '    assert decode_token(encode_token(a)) == a\n',
    );
    const withSeed = codeLines(text).filter((line) => line.includes('4242'));
    expect(withSeed).toEqual(['SEED = 4242']);
  });

  it.each([
    [
      'idempotence',
      'normalize_slug',
      'assert normalize_slug(normalize_slug(a)) == normalize_slug(a)',
    ],
    [
      'involution',
      'normalize_slug',
      'assert normalize_slug(normalize_slug(a)) == a',
    ],
    [
      'commutativity',
      'merge_counts',
      'assert merge_counts(a, b) == merge_counts(b, a)',
    ],
    [
      'length-preserving',
      'sort_scores',
      'assert len(sort_scores(a)) == len(a)',
    ],
    ['total-predicate', 'is_slug', 'assert isinstance(is_slug(a), bool)'],
  ])('writes the %s body', (kind, fn, line) => {
    const out = renderHypothesis(specOf(PY_PROPOSAL, kind, fn));
    expect(out.split('\n').map((l) => l.trim())).toContain(line);
    expect(out).not.toContain('_outcome');
  });

  it('compares outcomes for determinism, so a repeated raise passes', () => {
    const out = renderHypothesis(
      specOf(PY_PROPOSAL, 'determinism', 'merge_counts'),
    );
    expect(out).toContain(
      'def _outcome(run):\n' +
        '    try:\n' +
        '        return ("value", run())\n' +
        '    except Exception as error:\n' +
        '        return ("raised", type(error).__name__, str(error))\n',
    );
    expect(out).toContain(
      '    first = _outcome(lambda: merge_counts(a, b))\n' +
        '    assert _outcome(lambda: merge_counts(a, b)) == first\n',
    );
  });

  it('generates one keyword argument per parameter', () => {
    const out = renderHypothesis(
      specOf(PY_PROPOSAL, 'commutativity', 'merge_counts'),
    );
    const item = 'st.lists(st.integers())';
    expect(out).toContain(`@given(a=${item}, b=${item})\n`);
    expect(out).toContain('def test_codec_merge_counts_commutativity(a, b):\n');
  });

  it('is ASCII, ends with one newline and renders the same twice', () => {
    expect(text).toMatch(ASCII);
    expect(text.endsWith('== a\n')).toBe(true);
    expect(renderHypothesis(spec)).toBe(text);
  });

  it('keeps planted text on its comment line and out of the test name', () => {
    const planted = {
      ...spec,
      stem: 'co-dec\n    danger()',
      candidate: {
        ...spec.candidate,
        id: 'round-trip:x\ndanger()',
        statement: 'x\r\ndanger() \u2028 y',
      },
    };
    const out = renderHypothesis(planted);
    expect(out).toMatch(ASCII);
    expect(codeLines(out).filter((l) => l.includes('danger'))).toEqual([
      'def test_co_dec_____danger___encode_token_decode_token_round_trip(a):',
    ]);
    expect(out.split('\n')).toHaveLength(text.split('\n').length);
  });
});

describe('canary-harley arbitraries: toFastCheck and toHypothesis', () => {
  it.each(TABLE)('maps %s', (_label, node, fastCheck, hypothesis) => {
    expect(toFastCheck(node)).toBe(fastCheck);
    expect(toHypothesis(node)).toBe(hypothesis);
  });

  it.each([
    ['a named type', ts('Widget')],
    ['an array of a named type', ts('Widget[]')],
    ['an object with one unresolved field', ts('{ id: string; w: Widget }')],
    ['a missing annotation', ts('')],
  ])('writes no generator for %s (SC3)', (_label, node) => {
    expect(toFastCheck(node)).toBeNull();
    expect(toHypothesis(node)).toBeNull();
  });

  it('escapes a literal so it cannot leave its string', () => {
    const node = { kind: 'literal', value: 'a"\n); danger(' };
    expect(toFastCheck(node)).toBe('fc.constant("a\\"\\n); danger(")');
    expect(toHypothesis(node)).toBe('st.just("a\\"\\n); danger(")');
  });

  it('writes an astral character per language and keeps NUL inert', () => {
    const node = { kind: 'literal', value: '\u{1f600}\u0000U0001f600' };
    expect(toFastCheck(node)).toBe(
      'fc.constant("\\ud83d\\ude00\\u0000U0001f600")',
    );
    expect(toHypothesis(node)).toBe('st.just("\\U0001f600\\u0000U0001f600")');
  });

  it('escapes non-ASCII and field names in both languages', () => {
    const node = {
      kind: 'object',
      fields: [
        {
          name: 'k"\u00e9\u2028',
          type: { kind: 'literal', value: '\u00e9' },
          optional: false,
        },
      ],
    };
    expect(toFastCheck(node)).toBe(
      'fc.record({ "k\\"\\u00e9\\u2028": fc.constant("\\u00e9") })',
    );
    expect(toHypothesis(node)).toBe(
      'st.fixed_dictionaries({"k\\"\\u00e9\\u2028": st.just("\\u00e9")})',
    );
  });
});
