/**
 * Fail-loud auto-detection messaging.
 *
 * Faithful TypeScript port of `agent/core/detection.py`.
 *
 * Several CLI paths auto-detect something (a test framework, a doctor persona)
 * and, when detection is uncertain, used to silently fall back to `unknown` /
 * `None` or a bare "flag required" failure. That erodes user trust: the caller
 * has no idea *what* was being detected, *why* it failed, or *what to do next*.
 *
 * {@link uncertainDetectionMessage} renders one clear, actionable message from
 * the pieces a call site has on hand, so every uncertain-detection path reads
 * the same way instead of each inventing its own ad hoc string. It is pure
 * string-building — it never prints, raises, or decides control flow; the
 * caller owns those. Message text is byte-for-byte identical to the oracle.
 */

/** Optional pieces a call site can supply to describe an uncertain detection. */
export interface UncertainDetectionOptions {
  /** Why detection is uncertain (e.g. "no config file or dependency matched"). */
  reason?: string | null;
  /** The known vocabulary of valid values, when the engine knows it. */
  candidates?: readonly string[] | null;
  /** How to specify the value explicitly (e.g. "--framework <name>"). */
  overrideHint?: string | null;
}

/**
 * Build a clear, actionable message for an uncertain/failed detection.
 *
 * Python: `uncertain_detection_message`. The keyword-only Python args
 * (`reason`, `candidates`, `override_hint`) map to the {@link
 * UncertainDetectionOptions} object; `override_hint` → `overrideHint`.
 *
 * @param what What we tried to detect, as a human-readable noun phrase (e.g.
 *   "test framework", "doctor persona").
 * @returns A single string. Always names `what` and always gives at least one
 *   next step when an override hint or candidate list is provided — never a
 *   bare `unknown`.
 */
export function uncertainDetectionMessage(
  what: string,
  options: UncertainDetectionOptions = {},
): string {
  const { reason, candidates, overrideHint } = options;
  const parts: string[] = [`Could not confidently auto-detect the ${what}.`];
  // Python `if reason:` — an empty string is falsy and omits the clause.
  if (reason) {
    parts.push(`Reason: ${reason}.`);
  }
  // Python `if candidates:` — a missing or empty list omits the "Known …"
  // clause entirely (no bare "Known …: ." string).
  if (candidates && candidates.length > 0) {
    const joined = candidates.join(', ');
    parts.push(`Known ${what}(s): ${joined}.`);
  }
  if (overrideHint) {
    parts.push(`Set it explicitly with ${overrideHint}.`);
  }
  return parts.join(' ');
}
