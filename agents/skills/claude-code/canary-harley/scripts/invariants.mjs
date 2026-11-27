/**
 * canary-harley -- candidate invariants from signatures.
 *
 * Each kind is decidable from a type shape alone; a name cue only raises the
 * score. Kinds that need a domain rule (an ordering, a conservation law, a
 * merge policy) are not derived here.
 */
import { makeCandidate, sortCandidates } from './candidate.mjs';
import { cueFor, pairCue } from './cues.mjs';
import { typeKey } from './types.mjs';

/** A missing annotation states no shape, so no shape kind reads one. */
const isDeclared = (node) =>
  !(node.kind === 'unresolved' && node.typeText === '');

const paramKeys = (sig) => sig.params.map((param) => typeKey(param.type));

/** `f: A -> A` with `A` declared. */
function isEndo(sig) {
  if (sig.params.length !== 1) return false;
  const type = sig.params[0].type;
  return isDeclared(type) && typeKey(type) === typeKey(sig.returns);
}

/** `x` for one parameter, `a, b, c` by position for several. */
function argNames(sig) {
  if (sig.params.length === 1) return ['x'];
  return sig.params.map((_param, index) => String.fromCharCode(97 + index));
}

const call = (sig, args) => `${sig.name}(${args.join(', ')})`;

/** One candidate of `kind` over `sig`, scored by the name cue for the kind. */
const single = (kind, sig, statement) =>
  makeCandidate(kind, [sig], cueFor(kind, sig.name), statement);

function idempotence(sig) {
  if (!isEndo(sig)) return [];
  const once = call(sig, ['x']);
  const statement = `${call(sig, [once])} equals ${once}`;
  return [single('idempotence', sig, statement)];
}

function involution(sig) {
  if (!isEndo(sig)) return [];
  const statement = `${call(sig, [call(sig, ['x'])])} equals x`;
  return [single('involution', sig, statement)];
}

function lengthPreserving(sig) {
  if (!isEndo(sig) || sig.returns.kind !== 'array') return [];
  const statement = `${call(sig, ['x'])} has the same length as x`;
  return [single('length-preserving', sig, statement)];
}

function totalPredicate(sig) {
  if (sig.returns.kind !== 'boolean') return [];
  const result = call(sig, argNames(sig));
  const statement = `${result} returns a boolean and does not throw`;
  return [single('total-predicate', sig, statement)];
}

/** `f: (A, A) -> A` with `A` declared. */
function commutativity(sig) {
  const keys = paramKeys(sig);
  const sameType =
    keys.length === 2 &&
    keys[0] === keys[1] &&
    keys[0] === typeKey(sig.returns) &&
    isDeclared(sig.returns);
  if (!sameType) return [];
  const statement = `${call(sig, ['a', 'b'])} equals ${call(sig, ['b', 'a'])}`;
  return [single('commutativity', sig, statement)];
}

/** `[A, B]` keys for a declared one-parameter `f: A -> B`, else null. */
function unaryShape(sig) {
  if (sig.params.length !== 1) return null;
  const declared = isDeclared(sig.params[0].type) && isDeclared(sig.returns);
  return declared ? [paramKeys(sig)[0], typeKey(sig.returns)] : null;
}

/** True when `f: A -> B` and `g: B -> A`. */
function closes(f, g) {
  const shapeF = unaryShape(f);
  const shapeG = unaryShape(g);
  if (shapeF === null || shapeG === null) return false;
  return shapeF[0] === shapeG[1] && shapeF[1] === shapeG[0];
}

/**
 * The round trip of `f` with a later `g`, or none. A name pair fixes the
 * order to compose in; without one the declaration order stands. `A -> A`
 * needs a name pair, or every two string functions would qualify.
 */
function roundTripOf(f, g) {
  if (!closes(f, g)) return [];
  const cue = pairCue(f.name, g.name);
  const [from, to] = unaryShape(f);
  if (cue === null && from === to) return [];
  const pair = cue !== null && cue.first === g.name ? [g, f] : [f, g];
  const inner = call(pair[0], ['x']);
  const statement = `${call(pair[1], [inner])} equals x`;
  return [makeCandidate('round-trip', pair, cue?.label ?? null, statement)];
}

/** Pairs `sig` with later signatures only, so no pair is proposed twice. */
function roundTrip(sig, all) {
  const later = all.slice(all.indexOf(sig) + 1);
  return later.flatMap((other) => roundTripOf(sig, other));
}

function determinism(sig) {
  const result = call(sig, argNames(sig));
  const statement = `${result} returns the same result for the same input`;
  return [single('determinism', sig, statement)];
}

// One function per kind: (sig, all) => candidate[].
const DERIVERS = [
  roundTrip,
  idempotence,
  involution,
  commutativity,
  lengthPreserving,
  totalPredicate,
  determinism,
];

/**
 * @param {object[]} signatures the signatures read from one file
 * @returns {object[]} ranked candidates; a function with no parameters has
 *   nothing to generate and yields none
 */
export function deriveCandidates(signatures) {
  const usable = signatures.filter((sig) => sig.params.length > 0);
  const found = usable.flatMap((sig) =>
    DERIVERS.flatMap((derive) => derive(sig, usable)),
  );
  return sortCandidates(found);
}
