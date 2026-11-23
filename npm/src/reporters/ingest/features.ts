// Ingest reporter: how two copies of one test's `features` merge, in a leaf
// module so the results, the JUnit catalog, catalog redaction and the
// Playwright catalog all apply the same rule (three of them used to keep the
// first copy while results took the union, so a run could say one thing in
// `results` and another in `collected`).

/**
 * The features of a test seen twice (two reports, two projects, or two titles
 * that redact alike): the union of what either copy said. Absent on both stays
 * absent — "the suite said nothing" — and `[]` on either side survives as an
 * answer, so the distinction the dashboard relies on is never lost in a merge.
 */
export function mergedFeatures(
  a: readonly string[] | undefined,
  b: readonly string[] | undefined,
): { features?: string[] } {
  if (a === undefined && b === undefined) return {};
  return { features: [...new Set([...(a ?? []), ...(b ?? [])])] };
}
