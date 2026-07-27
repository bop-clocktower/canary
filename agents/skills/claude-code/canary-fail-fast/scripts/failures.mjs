// failures -- heuristic failure categorization (self-contained, pure). Ported
// behavior-for-behavior from the Python original.
//
// Order matters -- the most distinctive signals are checked first so 4xx/5xx
// status-code patterns don't swallow schema errors that happen to mention a
// status code in a response preview.

export const FAILURE_CATEGORIES = [
  'schema',
  'auth',
  'server',
  'client',
  'timeout',
  'network',
  'other',
];

// [category, pattern] pairs in match-priority order (distinct from the display
// order in FAILURE_CATEGORIES). Patterns are case-insensitive and stateless
// (no `g` flag), mirroring Python's re.search with re.IGNORECASE.
//
// Intentional deviation (exotic input only): the `\b` word boundaries use
// JavaScript's ASCII-only word-character definition, whereas Python's `re` is
// Unicode-aware by default. An accented/non-ASCII letter glued directly to a
// status code (a "u"-with-umlaut immediately before `401`, say) can therefore
// categorize differently than the Python original. This is negligible for real
// Playwright error messages, which are
// ASCII around status codes; documented so the behavior reads as deliberate.
const RULES = [
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

/** Return the category of a failure error message ('other' when unknown). */
export function categorizeFailure(error) {
  if (!error) return 'other';
  for (const [category, pattern] of RULES) {
    if (pattern.test(error)) return category;
  }
  return 'other';
}
