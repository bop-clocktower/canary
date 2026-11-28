// dimension -- the scorecard's dimension model (spec "Dimension model").
//
// A dimension is either ASSESSED (a value, a direction, a basis sentence and
// the numbers behind it) or NOT ASSESSED (a reason, and a null value). There is
// no third state and no default: a dimension with no backing data never reads
// as 0 or 100% (spec D6). There is deliberately no composite either (spec D3):
// an average over the assessed dimensions would rise whenever a bad
// dimension's input was withheld.
//
// Every id, title and detail key below is batgirl's own constant. Nothing an
// input says becomes a key.

/** The six dimensions, in report order (spec "Signals considered"). */
export const DIMENSIONS = Object.freeze([
  {
    id: 'escaped-defects',
    title: 'Escaped-defect ratio',
    better: 'lower',
    kind: 'ratio',
  },
  {
    id: 'coverage-verified-share',
    title: 'Coverage-verified share',
    better: 'higher',
    kind: 'ratio',
  },
  {
    id: 'closure-exercise',
    title: 'Closure exercise share',
    better: 'higher',
    kind: 'ratio',
  },
  {
    id: 'unexplained-switch-offs',
    title: 'Unexplained switch-offs',
    better: 'lower',
    kind: 'count',
  },
  {
    id: 'vacuous-tests',
    title: 'Vacuous tests',
    better: 'lower',
    kind: 'count',
  },
  {
    id: 'red-mainline-commits',
    title: 'Red mainline commits',
    better: 'lower',
    kind: 'count',
  },
]);

const BY_ID = new Map(DIMENSIONS.map((d) => [d.id, d]));

/** A plain JSON object: not null, not an array. */
export const isRecord = (v) =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * What an evaluator returns: a value with its basis and detail, or a reason.
 *
 * @typedef {{value?: number, basis?: string, detail?: any, reason?: string}} Evaluation
 */

/** `n noun` or `n nouns`. */
export const plural = (n, noun) => `${n} ${noun}${n === 1 ? '' : 's'}`;

/**
 * Score one dimension from its input.
 *
 * @param {string} id one of DIMENSIONS
 * @param {{source: string|null, read: {kind: string, value?: any, reason?: string}}} input
 * @param {(value: any, opts: any) => Evaluation} evaluator
 * @param {{limits: object, branch: string}} opts
 */
export function evaluate(id, input, evaluator, opts) {
  const meta = BY_ID.get(id);
  if (!meta) throw new Error(`unknown dimension: ${id}`);
  const base = { ...meta, source: input.source };
  if (input.read.kind !== 'ok') {
    const reason = input.read.reason ?? `nothing at ${input.source}`;
    return notAssessed(base, reason, {});
  }
  const out = evaluator(input.read.value, opts);
  if (out.reason) return notAssessed(base, out.reason, out.detail ?? {});
  return {
    ...base,
    status: 'assessed',
    value: out.value,
    basis: out.basis,
    reason: null,
    detail: out.detail ?? {},
  };
}

function notAssessed(base, reason, detail) {
  return {
    ...base,
    status: 'not-assessed',
    value: null,
    basis: null,
    reason,
    detail,
  };
}
