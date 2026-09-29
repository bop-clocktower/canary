/**
 * Heuristic failure categorisation for run-history rows (#1125).
 *
 * A rule-for-rule port of canary-fail-fast's `scripts/failures.mjs`, the one
 * categoriser canary ships, so `failure_category` means the same thing in the
 * store as in the fail-fast digest. The skill script is self-contained and
 * cannot be imported by the engine; `ts/test/enrich-failure-category.test.ts`
 * pins the two copies together. Change both, or neither.
 *
 * Order matters: the most distinctive signals are checked first, so a status
 * code quoted inside a schema error does not read as `server`.
 */

export const FAILURE_CATEGORIES = [
  'schema',
  'auth',
  'server',
  'client',
  'timeout',
  'network',
  'other',
] as const;

type FailureCategory = (typeof FAILURE_CATEGORIES)[number];

// [category, pattern] in match-priority order (not display order).
// Case-insensitive, no `g` flag, so `test` is stateless.
const RULES: ReadonlyArray<readonly [FailureCategory, RegExp]> = [
  [
    'schema',
    /ZodError|invalid[_ ]type|unrecognized key|expected .+ received|at path "|\bzod\b/i,
  ],
  [
    'auth',
    /\b401\b|unauthorized|\b403\b|forbidden|invalid(?: auth)? token|token expired/i,
  ],
  ['timeout', /timeout|timed out|etimedout|deadline exceeded/i],
  [
    'network',
    /econnrefused|enotfound|econnreset|socket hang up|getaddrinfo|network request failed/i,
  ],
  [
    'server',
    /\b5\d{2}\b|internal server error|bad gateway|service unavailable|gateway timeout/i,
  ],
  [
    'client',
    /\b4(?:0[045-9]|1\d|2\d)\b|bad request|not found|unprocessable|conflict/i,
  ],
];

/** The category of a failure message; `other` when nothing matches. */
export function categorizeFailure(
  error: string | null | undefined,
): FailureCategory {
  if (!error) return 'other';
  for (const [category, pattern] of RULES) {
    if (pattern.test(error)) return category;
  }
  return 'other';
}
