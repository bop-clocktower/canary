/**
 * canary-harley -- what a function's name says about it: the cue words that
 * raise a candidate's score, the name pairs that fix a round-trip's direction,
 * and the CRUD/UI boundary this skill stays out of.
 *
 * Names are compared token by token (`mergeCounts` is `merge` + `counts`), so
 * `address` never matches the cue `add`.
 */

/** The statement every proposal prints. */
export const BOUNDARY =
  'Property testing pays for itself on large input spaces: parsers, ' +
  'serializers, encoders and validators. It does not suit simple CRUD or UI ' +
  'rendering code, so functions shaped like those are skipped by name.';

const KIND_CUES = new Map([
  [
    'idempotence',
    [
      'normalize',
      'sanitize',
      'trim',
      'canonicalize',
      'dedupe',
      'sort',
      'slugify',
    ],
  ],
  ['involution', ['reverse', 'negate', 'invert', 'toggle', 'flip', 'swap']],
  [
    'commutativity',
    ['add', 'merge', 'union', 'intersect', 'max', 'min', 'gcd', 'combine'],
  ],
  ['length-preserving', ['sort', 'reverse', 'shuffle', 'map', 'rotate']],
  ['total-predicate', ['is', 'has', 'validate', 'check', 'matches']],
]);

// [first, second]: `second(first(x))` is the round trip.
const PAIRS = [
  ['encode', 'decode'],
  ['stringify', 'parse'],
  ['serialize', 'deserialize'],
  ['to', 'from'],
];

// `get`, `set`, `read` and `load` are left out: they prefix many pure parsers.
const CRUD = new Set([
  'create',
  'fetch',
  'list',
  'update',
  'delete',
  'remove',
  'save',
  'insert',
  'upsert',
  'store',
  'find',
]);

const UI = new Set([
  'render',
  'draw',
  'mount',
  'unmount',
  'paint',
  'show',
  'hide',
  'handle',
  'on',
  'use',
]);

/** `mergeCounts` and `merge_counts` are both `['merge', 'counts']`. */
function tokens(name) {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .split('_')
    .filter((token) => token !== '')
    .map((token) => token.toLowerCase());
}

/**
 * @param {string} kind a candidate kind
 * @param {string} name a function name
 * @returns {string | null} the cue word found in the name
 */
export function cueFor(kind, name) {
  const cues = KIND_CUES.get(kind) ?? [];
  return tokens(name).find((token) => cues.includes(token)) ?? null;
}

/** The tokens of a name with its first `word` removed, or null if absent. */
function without(nameTokens, word) {
  const at = nameTokens.indexOf(word);
  if (at === -1) return null;
  return nameTokens.filter((_token, index) => index !== at).join('_');
}

/** True when `a` carries `first`, `b` carries `second`, and the rest agree. */
function fits(pair, a, b) {
  const restA = without(tokens(a), pair[0]);
  return restA !== null && restA === without(tokens(b), pair[1]);
}

/**
 * @param {string} a a function name
 * @param {string} b another function name
 * @returns {{ first: string, second: string, label: string } | null} the
 *   order to compose the two in, when their names form a known pair
 */
export function pairCue(a, b) {
  for (const pair of PAIRS) {
    const label = pair.join('/');
    if (fits(pair, a, b)) return { first: a, second: b, label };
    if (fits(pair, b, a)) return { first: b, second: a, label };
  }
  return null;
}

/**
 * @param {string} name a function name
 * @returns {string | null} why the function is outside the boundary
 */
export function boundarySkip(name) {
  const head = tokens(name)[0] ?? '';
  if (CRUD.has(head)) return `CRUD-shaped by name (${head})`;
  if (UI.has(head)) return `UI-shaped by name (${head})`;
  return null;
}
