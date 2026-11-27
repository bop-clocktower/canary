/**
 * canary-harley -- one candidate invariant: its score, tier, id, evidence and
 * whether a test can be emitted for it.
 *
 * The score is a fixed prior per kind, raised when the function's name carries
 * a cue. Nothing here measures whether the invariant holds, so every candidate
 * is labelled `heuristic`. The id hashes the kind and the signatures read, so
 * a confirmation stops matching when a parameter or return type changes;
 * parameter names are left out, so a rename keeps it valid.
 */
import { createHash } from 'node:crypto';

import { collectUnresolved, typeKey } from './types.mjs';

// Scores are held in hundredths so 0.55 and 0.90 are exact.
const KINDS = new Map([
  [
    'round-trip',
    {
      order: 0,
      prior: 55,
      boost: 90,
      failsWhen: 'A lossy encoder; a parser that normalizes',
    },
  ],
  [
    'idempotence',
    {
      order: 1,
      prior: 30,
      boost: 75,
      failsWhen: 'A function that appends or counts',
    },
  ],
  [
    'involution',
    {
      order: 2,
      prior: 10,
      boost: 75,
      failsWhen: 'Anything that is not its own inverse',
    },
  ],
  [
    'commutativity',
    {
      order: 3,
      prior: 25,
      boost: 75,
      failsWhen: 'Subtraction, concatenation, "right side wins"',
    },
  ],
  [
    'length-preserving',
    {
      order: 4,
      prior: 35,
      boost: 80,
      failsWhen: 'A filter or a dedupe',
    },
  ],
  [
    'total-predicate',
    {
      order: 5,
      prior: 60,
      boost: 85,
      failsWhen: 'A validator that throws by contract',
    },
  ],
  [
    'determinism',
    {
      order: 6,
      prior: 65,
      boost: 65,
      failsWhen: 'Reads a clock, randomness or mutable state',
    },
  ],
]);

// [lowest hundredths, tier], highest first.
const TIERS = [
  [70, 'likely'],
  [40, 'plausible'],
  [0, 'speculative'],
];

const tierOf = (hundredths) => TIERS.find(([floor]) => hundredths >= floor)[1];

/** `name(typeKey,...)->typeKey`: what the id hashes for one function. */
function signatureKey(sig) {
  const params = sig.params.map((param) => typeKey(param.type)).join(',');
  return `${sig.name}(${params})->${typeKey(sig.returns)}`;
}

function candidateId(kind, sigs) {
  const text = [kind, ...sigs.map(signatureKey)].join('\n');
  const hex = createHash('sha256').update(text).digest('hex').slice(0, 8);
  return `${kind}:${sigs.map((sig) => sig.name).join('+')}:${hex}`;
}

/** The same facts as the key, spaced for a reader. */
function shapeOf(sig) {
  const params = sig.params.map((param) => typeKey(param.type)).join(', ');
  return `${sig.name}(${params}) -> ${typeKey(sig.returns)}`;
}

function evidenceFor(sigs, cue) {
  const shape = `shape: ${sigs.map(shapeOf).join('; ')}`;
  return cue === null ? [shape] : [shape, `name cue: ${cue}`];
}

function unresolvedReason(sig, param, node) {
  const where = `${sig.name}: parameter ${param.name}`;
  if (node.typeText === '') return `${where} has ${node.reason}`;
  return `${where} has type '${node.typeText}' (${node.reason})`;
}

/** Why no generator can be written for one function's inputs. */
function blockedFor(sig) {
  // Untyped JavaScript declares no types at all: one reason says it.
  if (sig.lang === 'javascript') return [`${sig.name}: untyped JavaScript`];
  const exportReasons = sig.exported ? [] : [`${sig.name}: not exported`];
  const typeReasons = sig.params.flatMap((param) =>
    collectUnresolved(param.type).map((node) =>
      unresolvedReason(sig, param, node),
    ),
  );
  return [...exportReasons, ...typeReasons];
}

/**
 * @param {string} kind one of the seven candidate kinds
 * @param {object[]} signatures the functions involved, in composition order
 * @param {string | null} cue the name cue that raised the score, if any
 * @param {string} statement the invariant in words
 * @returns {object} a candidate with `status: 'proposed'`
 */
export function makeCandidate(kind, signatures, cue, statement) {
  const row = KINDS.get(kind);
  const hundredths = cue === null ? row.prior : row.boost;
  const blocked = signatures.flatMap(blockedFor);
  return {
    id: candidateId(kind, signatures),
    kind,
    functions: signatures.map((sig) => sig.name),
    statement,
    score: hundredths / 100,
    tier: tierOf(hundredths),
    basis: 'heuristic',
    evidence: evidenceFor(signatures, cue),
    failsWhen: row.failsWhen,
    emittable: blocked.length === 0,
    blocked,
    status: 'proposed',
  };
}

const byText = (a, b) => (a < b ? -1 : Number(a > b));

function compareCandidates(a, b) {
  return (
    b.score - a.score ||
    KINDS.get(a.kind).order - KINDS.get(b.kind).order ||
    byText(a.functions[0], b.functions[0]) ||
    byText(a.id, b.id)
  );
}

/**
 * @param {object[]} list candidates in any order
 * @returns {object[]} a new list: score descending, then kind order, then
 *   first function name, then id
 */
export function sortCandidates(list) {
  return [...list].sort(compareCandidates);
}
