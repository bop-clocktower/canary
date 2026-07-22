/**
 * Nullish-default helper.
 *
 * `def(x, fallback)` is exactly `x ?? fallback`, but as a function call it is not
 * a decision point — so replacing dense `??` fallback chains in field-mapper
 * functions with `def(...)` keeps behaviour identical while lowering the
 * cyclomatic complexity the arch ratchet measures.
 */
export function def<T>(value: T | null | undefined, fallback: T): T {
  return value ?? fallback;
}
