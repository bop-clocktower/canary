// json_report -- JSON serializer for Playwright test results (self-contained,
// pure). Ported behavior-for-behavior from the Python original.
//
// The field NAMES and ORDER are a downstream contract (a flat, TCM-row-ish
// shape); do not rename or reorder them.
//
// Accepted numeric-repr limitation (input-shape-dependent, consistent with the
// canary-instrument port): Python json.dumps renders a whole-number FLOAT with a
// trailing ".0" (300.0 -> "300.0"), but JS Number cannot distinguish 300 from
// 300.0, so a whole-number float duration serializes without the ".0". This is
// unreachable in practice -- Playwright's reporter emits integer millisecond
// durations, and genuinely fractional floats (12.5) already agree byte-for-byte.

/**
 * Serialize like Python's json.dumps(obj, indent=2) with the default
 * ensure_ascii=True. JSON.stringify already matches the 2-space indentation and
 * the empty-container ("[]"/"{}") forms, but leaves non-ASCII raw -- so escape
 * every code unit above 0x7F to a \uXXXX sequence (astral chars become their two
 * UTF-16 surrogate escapes, exactly as Python emits them). This keeps the JSON
 * artifact byte-identical when a title/error/file carries an emoji, accented, or
 * CJK character (or an em-dash inside a Playwright diff).
 */
function dumpsIndent2Ascii(obj) {
  const nonAscii = /[\u0080-\uffff]/g;
  return JSON.stringify(obj, null, 2).replace(
    nonAscii,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

/** Serialize a ReportData to the pinned JSON report string (indent=2). */
export function renderJson(data) {
  // Python: datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ") -- second
  // precision, no milliseconds. toISOString() carries `.mmmZ`; strip it so the
  // emitted bytes match the Python format exactly.
  const generatedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const output = {
    version: 1,
    generated_at: generatedAt,
    summary: {
      total: data.total,
      passed: data.passed,
      failed: data.failed,
      flaky: data.flaky,
      skipped: data.skipped,
      duration_ms: data.duration_ms,
    },
    results: data.results.map((r) => ({
      title: r.title,
      status: r.status,
      file: r.file,
      line: r.line,
      duration_ms: r.duration_ms,
      error: r.error,
    })),
  };
  return dumpsIndent2Ascii(output);
}
