/**
 * canary-harley (#616) -- name cues, the CRUD/UI boundary, and candidate
 * derivation, scoring and ids. Cases are tagged with the spec's success
 * criteria (docs/changes/616-canary-harley/proposal.md). Fixtures are
 * synthetic.
 */
import { describe, expect, it } from 'vitest';

import {
  makeCandidate,
  sortCandidates,
} from '../claude-code/canary-harley/scripts/candidate.mjs';
import {
  BOUNDARY,
  boundarySkip,
  cueFor,
  pairCue,
} from '../claude-code/canary-harley/scripts/cues.mjs';
import { deriveCandidates } from '../claude-code/canary-harley/scripts/invariants.mjs';
import { readSignatures } from '../claude-code/canary-harley/scripts/signatures.mjs';

describe('canary-harley cues: cueFor', () => {
  it.each([
    ['idempotence', 'normalizeSlug', 'normalize'],
    ['idempotence', 'normalize_slug', 'normalize'],
    ['idempotence', 'deepTrim', 'trim'],
    ['involution', 'reverseWords', 'reverse'],
    ['commutativity', 'mergeCounts', 'merge'],
    ['commutativity', 'address', null],
    ['commutativity', 'padding', null],
    ['length-preserving', 'sortScores', 'sort'],
    ['total-predicate', 'isSlug', 'is'],
    ['total-predicate', 'island', null],
    ['determinism', 'anything', null],
    ['round-trip', 'encodeToken', null],
    ['no-such-kind', 'normalizeSlug', null],
  ])('cueFor(%s, %s) is %s', (kind, name, cue) => {
    expect(cueFor(kind, name)).toBe(cue);
  });
});

describe('canary-harley cues: pairCue', () => {
  it('orders an encode/decode pair whichever way it is given', () => {
    const expected = {
      first: 'encodeToken',
      second: 'decodeToken',
      label: 'encode/decode',
    };
    expect(pairCue('decodeToken', 'encodeToken')).toEqual(expected);
    expect(pairCue('encodeToken', 'decodeToken')).toEqual(expected);
  });

  it.each([
    ['parse', 'stringify', 'stringify', 'parse', 'stringify/parse'],
    ['toJson', 'fromJson', 'toJson', 'fromJson', 'to/from'],
    [
      'deserializeRow',
      'serializeRow',
      'serializeRow',
      'deserializeRow',
      'serialize/deserialize',
    ],
    [
      'encode_token',
      'decode_token',
      'encode_token',
      'decode_token',
      'encode/decode',
    ],
    ['rowToText', 'rowFromText', 'rowToText', 'rowFromText', 'to/from'],
  ])('pairs %s with %s', (a, b, first, second, label) => {
    expect(pairCue(a, b)).toEqual({ first, second, label });
  });

  it.each([
    ['encodeToken', 'decodeHeader'],
    ['encodeToken', 'encodeToken'],
    ['encodeToken', 'normalizeSlug'],
    ['encoder', 'decoder'],
  ])('does not pair %s with %s', (a, b) => {
    expect(pairCue(a, b)).toBeNull();
  });
});

describe('canary-harley cues: the boundary (SC7)', () => {
  it.each([
    ['createWidget', 'CRUD-shaped by name (create)'],
    ['delete_row', 'CRUD-shaped by name (delete)'],
    ['list', 'CRUD-shaped by name (list)'],
    ['renderBadge', 'UI-shaped by name (render)'],
    ['onClick', 'UI-shaped by name (on)'],
    ['useWidget', 'UI-shaped by name (use)'],
  ])('skips %s', (name, reason) => {
    expect(boundarySkip(name)).toBe(reason);
  });

  it.each(['getChecksum', 'readVarint', 'encodeToken', 'listen', 'toCreate'])(
    'keeps %s',
    (name) => {
      expect(boundarySkip(name)).toBeNull();
    },
  );

  it('states what property testing suits and what it does not', () => {
    for (const word of [
      'parsers',
      'serializers',
      'encoders',
      'validators',
      'CRUD',
      'UI',
    ]) {
      expect(BOUNDARY).toContain(word);
    }
  });
});

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
export function scoreWidget(widget: Widget): number {
  return widget.weight;
}
function clampLevel(level: number): number {
  return Math.max(0, level);
}
`;

const CODEC_NAMES_TS = [
  'encodeToken',
  'decodeToken',
  'normalizeSlug',
  'mergeCounts',
  'sortScores',
  'scoreWidget',
  'clampLevel',
  'isSlug',
];

type Candidate = {
  id: string;
  kind: string;
  functions: string[];
  statement: string;
  score: number;
  tier: string;
  basis: string;
  evidence: string[];
  failsWhen: string;
  emittable: boolean;
  blocked: string[];
  status: string;
};

type Lang = 'typescript' | 'javascript' | 'python';

/** Signatures for the named functions of a source, in the order asked. */
const sigs = (source: string, names: string[], lang: Lang = 'typescript') => {
  const result = readSignatures(source, lang, names);
  expect(result.skipped).toEqual([]);
  return result.signatures;
};

const codec = (...names: string[]) => sigs(CODEC_TS, names);

const make = (
  kind: string,
  signatures: object[],
  cue: string | null = null,
  statement = 'a statement',
) => makeCandidate(kind, signatures, cue, statement) as Candidate;

const hexOf = (id: string) => id.split(':')[2];

describe('canary-harley candidate: makeCandidate', () => {
  it('builds the full candidate shape', () => {
    const candidate = make(
      'idempotence',
      codec('normalizeSlug'),
      'normalize',
      'normalizeSlug(normalizeSlug(x)) equals normalizeSlug(x)',
    );
    expect(Object.keys(candidate)).toEqual([
      'id',
      'kind',
      'functions',
      'statement',
      'score',
      'tier',
      'basis',
      'evidence',
      'failsWhen',
      'emittable',
      'blocked',
      'status',
    ]);
    expect(candidate).toMatchObject({
      kind: 'idempotence',
      functions: ['normalizeSlug'],
      statement: 'normalizeSlug(normalizeSlug(x)) equals normalizeSlug(x)',
      basis: 'heuristic',
      emittable: true,
      blocked: [],
      status: 'proposed',
    });
  });

  it.each([
    ['round-trip', 0.55, 'plausible', 0.9, 'likely'],
    ['idempotence', 0.3, 'speculative', 0.75, 'likely'],
    ['involution', 0.1, 'speculative', 0.75, 'likely'],
    ['commutativity', 0.25, 'speculative', 0.75, 'likely'],
    ['length-preserving', 0.35, 'speculative', 0.8, 'likely'],
    ['total-predicate', 0.6, 'plausible', 0.85, 'likely'],
    ['determinism', 0.65, 'plausible', 0.65, 'plausible'],
  ])(
    'scores %s at %d (%s) and at %d (%s) with a cue',
    (kind, prior, priorTier, boosted, boostedTier) => {
      const plain = make(kind, codec('normalizeSlug'));
      const cued = make(kind, codec('normalizeSlug'), 'a-cue');
      expect([plain.score, plain.tier]).toEqual([prior, priorTier]);
      expect([cued.score, cued.tier]).toEqual([boosted, boostedTier]);
    },
  );

  it('issues an id of kind, functions and 8 hex, the same every time', () => {
    const pair = codec('encodeToken', 'decodeToken');
    const first = make('round-trip', pair, 'encode/decode');
    const second = make('round-trip', codec('encodeToken', 'decodeToken'));
    expect(first.id).toMatch(
      /^round-trip:encodeToken\+decodeToken:[0-9a-f]{8}$/,
    );
    expect(second.id).toBe(first.id);
    expect(first.functions).toEqual(['encodeToken', 'decodeToken']);
  });

  it('changes the id when a type changes and keeps it on a rename (SC6)', () => {
    const source = 'export function encodeToken(text: string): string {}';
    const base = make('determinism', sigs(source, ['encodeToken']));
    const retyped = make(
      'determinism',
      sigs(source.replace('text: string', 'text: number'), ['encodeToken']),
    );
    const renamed = make(
      'determinism',
      sigs(source.replace('text: string', 'input: string'), ['encodeToken']),
    );
    const returns = make(
      'determinism',
      sigs(source.replace('): string', '): number'), ['encodeToken']),
    );
    const otherKind = make('idempotence', sigs(source, ['encodeToken']));
    expect(hexOf(retyped.id)).not.toBe(hexOf(base.id));
    expect(hexOf(returns.id)).not.toBe(hexOf(base.id));
    expect(renamed.id).toBe(base.id);
    expect(hexOf(otherKind.id)).not.toBe(hexOf(base.id));
  });

  it('blocks a candidate whose parameter type is unresolved (SC3)', () => {
    const candidate = make('determinism', codec('scoreWidget'));
    expect(candidate.emittable).toBe(false);
    expect(candidate.blocked).toHaveLength(1);
    expect(candidate.blocked[0]).toContain("'Widget'");
    expect(candidate.blocked[0]).toContain('named type');
    expect(candidate.blocked[0]).toContain('scoreWidget');
  });

  it('blocks a function that is not exported', () => {
    const candidate = make('determinism', codec('clampLevel'));
    expect(candidate.emittable).toBe(false);
    expect(candidate.blocked).toEqual(['clampLevel: not exported']);
  });

  it('blocks untyped JavaScript with one reason', () => {
    const source = 'export function trimTag(value) {}';
    const candidate = make(
      'determinism',
      sigs(source, ['trimTag'], 'javascript'),
    );
    expect(candidate.emittable).toBe(false);
    expect(candidate.blocked).toEqual(['trimTag: untyped JavaScript']);
  });

  it('names a missing annotation without quoting an empty type', () => {
    const candidate = make(
      'determinism',
      sigs('export function tag(value): string {}', ['tag']),
    );
    expect(candidate.blocked).toEqual([
      'tag: parameter value has no type annotation',
    ]);
  });

  it('lists a blocked reason per function of a pair', () => {
    const candidate = make('round-trip', codec('scoreWidget', 'clampLevel'));
    expect(candidate.blocked).toHaveLength(2);
    expect(candidate.blocked[1]).toBe('clampLevel: not exported');
  });

  it('records the shape and the cue as evidence', () => {
    const cued = make(
      'round-trip',
      codec('encodeToken', 'decodeToken'),
      'encode/decode',
    );
    expect(cued.evidence).toEqual([
      'shape: encodeToken(string) -> bytes; decodeToken(bytes) -> string',
      'name cue: encode/decode',
    ]);
    const plain = make('determinism', codec('mergeCounts'));
    expect(plain.evidence).toEqual([
      'shape: mergeCounts(array<number>, array<number>) -> array<number>',
    ]);
  });

  it.each([
    ['round-trip', 'A lossy encoder; a parser that normalizes'],
    ['idempotence', 'A function that appends or counts'],
    ['involution', 'Anything that is not its own inverse'],
    ['commutativity', 'Subtraction, concatenation, "right side wins"'],
    ['length-preserving', 'A filter or a dedupe'],
    ['total-predicate', 'A validator that throws by contract'],
    ['determinism', 'Reads a clock, randomness or mutable state'],
  ])('says when %s legitimately fails', (kind, failsWhen) => {
    expect(make(kind, codec('normalizeSlug')).failsWhen).toBe(failsWhen);
  });
});

describe('canary-harley candidate: sortCandidates', () => {
  const order = (list: Candidate[]) =>
    (sortCandidates(list) as Candidate[]).map(
      (candidate) => `${candidate.kind}:${candidate.functions[0]}`,
    );

  it('sorts by score, highest first', () => {
    const list = [
      make('involution', codec('normalizeSlug')),
      make('determinism', codec('normalizeSlug')),
      make('idempotence', codec('normalizeSlug'), 'normalize'),
    ];
    expect(order(list)).toEqual([
      'idempotence:normalizeSlug',
      'determinism:normalizeSlug',
      'involution:normalizeSlug',
    ]);
  });

  it('breaks a score tie by kind order', () => {
    const list = [
      make('commutativity', codec('normalizeSlug'), 'merge'),
      make('involution', codec('normalizeSlug'), 'reverse'),
      make('idempotence', codec('normalizeSlug'), 'normalize'),
    ];
    expect(order(list)).toEqual([
      'idempotence:normalizeSlug',
      'involution:normalizeSlug',
      'commutativity:normalizeSlug',
    ]);
  });

  it('breaks a kind tie by the first function name', () => {
    const list = [
      make('determinism', codec('sortScores')),
      make('determinism', codec('encodeToken')),
      make('determinism', codec('mergeCounts')),
    ];
    expect(order(list)).toEqual([
      'determinism:encodeToken',
      'determinism:mergeCounts',
      'determinism:sortScores',
    ]);
  });

  it('does not reorder the list it was given', () => {
    const list = [
      make('involution', codec('normalizeSlug')),
      make('determinism', codec('normalizeSlug')),
    ];
    const before = list.map((candidate) => candidate.id);
    sortCandidates(list);
    expect(list.map((candidate) => candidate.id)).toEqual(before);
  });

  it('keeps every kind in the documented order on equal scores', () => {
    const kinds = [
      'determinism',
      'total-predicate',
      'length-preserving',
      'commutativity',
      'involution',
      'idempotence',
      'round-trip',
    ];
    const sorted = sortCandidates(
      kinds.map((kind) => ({ ...make(kind, codec('isSlug')), score: 0.5 })),
    ) as Candidate[];
    expect(sorted.map((candidate) => candidate.kind)).toEqual(
      [...kinds].reverse(),
    );
  });
});

const derive = (signatures: object[]) =>
  deriveCandidates(signatures) as Candidate[];

/** Candidates for one inline TypeScript source. */
const deriveTs = (source: string, ...names: string[]) =>
  derive(sigs(source, names));

/** `kind score tier` per candidate, in rank order. */
const summary = (list: Candidate[]) =>
  list.map(
    (candidate) => `${candidate.kind} ${candidate.score} ${candidate.tier}`,
  );

const kindsOf = (list: Candidate[]) => list.map((candidate) => candidate.kind);

describe('canary-harley invariants: single-function kinds', () => {
  it('proposes idempotence, determinism and involution for A -> A', () => {
    const list = derive(codec('normalizeSlug'));
    expect(summary(list)).toEqual([
      'idempotence 0.75 likely',
      'determinism 0.65 plausible',
      'involution 0.1 speculative',
    ]);
    expect(list[0].statement).toBe(
      'normalizeSlug(normalizeSlug(x)) equals normalizeSlug(x)',
    );
    expect(list[0].evidence).toContain('name cue: normalize');
    expect(list[2].statement).toBe('normalizeSlug(normalizeSlug(x)) equals x');
    expect(list[1].statement).toContain('normalizeSlug(x)');
  });

  it('raises involution on a reverse cue', () => {
    const list = deriveTs(
      'export function reverseWords(text: string): string {}',
      'reverseWords',
    );
    expect(summary(list)).toEqual([
      'involution 0.75 likely',
      'determinism 0.65 plausible',
      'idempotence 0.3 speculative',
    ]);
  });

  it('proposes length-preserving for array(A) -> array(A)', () => {
    const list = derive(codec('sortScores'));
    expect(summary(list)).toEqual([
      'length-preserving 0.8 likely',
      'idempotence 0.75 likely',
      'determinism 0.65 plausible',
      'involution 0.1 speculative',
    ]);
    expect(list[0].statement).toBe('sortScores(x) has the same length as x');
  });

  it('proposes total-predicate for a boolean function', () => {
    const cued = derive(codec('isSlug'));
    expect(summary(cued)).toEqual([
      'total-predicate 0.85 likely',
      'determinism 0.65 plausible',
    ]);
    expect(cued[0].statement).toBe(
      'isSlug(x) returns a boolean and does not throw',
    );
    const plain = deriveTs(
      'export function accepts(value: string, strict: boolean): boolean {}',
      'accepts',
    );
    expect(summary(plain)).toEqual([
      'determinism 0.65 plausible',
      'total-predicate 0.6 plausible',
    ]);
    expect(plain[1].statement).toBe(
      'accepts(a, b) returns a boolean and does not throw',
    );
  });

  it('proposes no idempotence or involution when A differs from B', () => {
    const list = deriveTs(
      'export function toLength(text: string): number {}',
      'toLength',
    );
    expect(kindsOf(list)).toEqual(['determinism']);
  });

  it('proposes no length-preserving when the result is not an array', () => {
    const list = deriveTs(
      'export function head(values: number[]): number {}',
      'head',
    );
    expect(kindsOf(list)).toEqual(['determinism']);
  });

  it('proposes no length-preserving when the item type changes', () => {
    const list = deriveTs(
      'export function label(values: number[]): string[] {}',
      'label',
    );
    expect(kindsOf(list)).toEqual(['determinism']);
  });

  it('proposes no idempotence for a two-parameter function', () => {
    const list = deriveTs(
      'export function pad(text: string, width: number): string {}',
      'pad',
    );
    expect(kindsOf(list)).toEqual(['determinism']);
    expect(list[0].statement).toContain('pad(a, b)');
  });

  it('proposes nothing for a function with no parameters', () => {
    expect(deriveTs('export function now(): number {}', 'now')).toEqual([]);
    expect(derive([])).toEqual([]);
  });

  it('still proposes determinism for an unresolved parameter (SC3)', () => {
    const list = derive(codec('scoreWidget'));
    expect(kindsOf(list)).toEqual(['determinism']);
    expect(list[0].emittable).toBe(false);
  });

  it('reads no shape from a missing annotation', () => {
    const list = derive(
      sigs('export function trimTag(value) {}', ['trimTag'], 'javascript'),
    );
    expect(kindsOf(list)).toEqual(['determinism']);
    expect(list[0].blocked).toEqual(['trimTag: untyped JavaScript']);
  });

  it('proposes shape kinds for a named type, blocked (SC3)', () => {
    const list = deriveTs(
      'export function normalizeWidget(w: Widget): Widget {}',
      'normalizeWidget',
    );
    expect(kindsOf(list)).toEqual(['idempotence', 'determinism', 'involution']);
    expect(list.every((candidate) => !candidate.emittable)).toBe(true);
  });
});

const CODEC_PY = `def encode_token(text: str) -> bytes:
    return text.encode("utf-8")


def decode_token(data: bytes) -> str:
    return data.decode("utf-8")


def normalize_slug(value: str) -> str:
    return value.strip().lower()


def is_slug(value: str) -> bool:
    return value.isalnum()
`;

const CODEC_NAMES_PY = [
  'encode_token',
  'decode_token',
  'normalize_slug',
  'is_slug',
];

const roundTrips = (list: Candidate[]) =>
  list.filter((candidate) => candidate.kind === 'round-trip');

describe('canary-harley invariants: pair kinds and ranking', () => {
  it('ranks the encode/decode round trip first for TypeScript (SC1)', () => {
    const list = derive(sigs(CODEC_TS, CODEC_NAMES_TS));
    expect(list[0]).toMatchObject({
      kind: 'round-trip',
      functions: ['encodeToken', 'decodeToken'],
      score: 0.9,
      tier: 'likely',
      statement: 'decodeToken(encodeToken(x)) equals x',
      emittable: true,
    });
    expect(list[0].evidence).toContain('name cue: encode/decode');
    const firstDeterminism = kindsOf(list).indexOf('determinism');
    expect(firstDeterminism).toBeGreaterThan(0);
    expect(roundTrips(list)).toHaveLength(1);
  });

  it('ranks the encode/decode round trip first for Python (SC1)', () => {
    const list = derive(sigs(CODEC_PY, CODEC_NAMES_PY, 'python'));
    expect(list[0]).toMatchObject({
      kind: 'round-trip',
      functions: ['encode_token', 'decode_token'],
      score: 0.9,
      tier: 'likely',
      statement: 'decode_token(encode_token(x)) equals x',
      emittable: true,
    });
    expect(kindsOf(list).indexOf('determinism')).toBeGreaterThan(0);
    expect(roundTrips(list)).toHaveLength(1);
  });

  it('takes the direction from the names, not the declaration order', () => {
    const source = [
      'export function decodeToken(bytes: Uint8Array): string {}',
      'export function encodeToken(text: string): Uint8Array {}',
    ].join('\n');
    const list = deriveTs(source, 'decodeToken', 'encodeToken');
    expect(roundTrips(list)).toHaveLength(1);
    expect(roundTrips(list)[0].functions).toEqual([
      'encodeToken',
      'decodeToken',
    ]);
  });

  it('proposes an unnamed A -> B, B -> A pair in declaration order', () => {
    const source = [
      'export function toHex(n: number): string {}',
      'export function parseHex(s: string): number {}',
    ].join('\n');
    const found = roundTrips(deriveTs(source, 'toHex', 'parseHex'));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      functions: ['toHex', 'parseHex'],
      score: 0.55,
      tier: 'plausible',
      statement: 'parseHex(toHex(x)) equals x',
    });
    expect(found[0].evidence).toHaveLength(1);
  });

  it('proposes no round trip for A -> A without a name pair', () => {
    const source = [
      'export function trimTag(s: string): string {}',
      'export function padTag(s: string): string {}',
    ].join('\n');
    expect(roundTrips(deriveTs(source, 'trimTag', 'padTag'))).toEqual([]);
  });

  it('proposes a round trip for A -> A with a name pair', () => {
    const source = [
      'export function encodeTag(s: string): string {}',
      'export function decodeTag(s: string): string {}',
    ].join('\n');
    const found = roundTrips(deriveTs(source, 'encodeTag', 'decodeTag'));
    expect(found).toHaveLength(1);
    expect(found[0].score).toBe(0.9);
  });

  it('proposes no round trip when the shapes do not close', () => {
    const source = [
      'export function encodeToken(text: string): Uint8Array {}',
      'export function decodeToken(bytes: Uint8Array): number {}',
      'export function encodePair(a: string, b: string): Uint8Array {}',
      'export function decodePair(bytes: Uint8Array): string {}',
    ].join('\n');
    const list = deriveTs(
      source,
      'encodeToken',
      'decodeToken',
      'encodePair',
      'decodePair',
    );
    expect(
      roundTrips(list).map((candidate) => candidate.functions.join('+')),
    ).toEqual(['encodeToken+decodePair']);
  });

  it('reads no round trip from missing annotations', () => {
    const source = [
      'export function encodeTag(s) {}',
      'export function decodeTag(s) {}',
    ].join('\n');
    const list = derive(sigs(source, ['encodeTag', 'decodeTag'], 'javascript'));
    expect(roundTrips(list)).toEqual([]);
  });

  it('proposes commutativity for (A, A) -> A', () => {
    const merged = derive(codec('mergeCounts'));
    expect(summary(merged)).toEqual([
      'commutativity 0.75 likely',
      'determinism 0.65 plausible',
    ]);
    expect(merged[0].statement).toBe(
      'mergeCounts(a, b) equals mergeCounts(b, a)',
    );
    const concat = deriveTs(
      'export function concat(a: string, b: string): string {}',
      'concat',
    );
    expect(summary(concat)).toEqual([
      'determinism 0.65 plausible',
      'commutativity 0.25 speculative',
    ]);
  });

  it('proposes no commutativity when the types differ', () => {
    const mixed = deriveTs(
      'export function scale(a: number, b: string): number {}',
      'scale',
    );
    expect(kindsOf(mixed)).toEqual(['determinism']);
    const narrowed = deriveTs(
      'export function longer(a: string, b: string): boolean {}',
      'longer',
    );
    expect(kindsOf(narrowed)).not.toContain('commutativity');
    const three = deriveTs(
      'export function mid(a: number, b: number, c: number): number {}',
      'mid',
    );
    expect(kindsOf(three)).toEqual(['determinism']);
  });

  it('ranks the whole codec list by score, the same every time (SC2)', () => {
    const first = derive(sigs(CODEC_TS, CODEC_NAMES_TS));
    const second = derive(sigs(CODEC_TS, CODEC_NAMES_TS));
    expect(second).toEqual(first);
    const scores = first.map((candidate) => candidate.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    expect(new Set(first.map((candidate) => candidate.id)).size).toBe(
      first.length,
    );
    expect(summary(first).slice(0, 5)).toEqual([
      'round-trip 0.9 likely',
      'total-predicate 0.85 likely',
      'length-preserving 0.8 likely',
      'idempotence 0.75 likely',
      'idempotence 0.75 likely',
    ]);
  });
});
