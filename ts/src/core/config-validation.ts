/**
 * Shared fail-loud-but-not-hard-fail JSON config reading.
 *
 * Faithful TypeScript port of `agent/core/config_validation.py`. Callers that
 * read a config file (`harness.config.json`, `.mcp.json`,
 * `.canary/company.json`, ...) have historically caught every read/parse error
 * in one blanket `catch` and treated the result the same as "file doesn't
 * exist" — silently falling back to defaults. That collapses two very different
 * situations into one:
 *
 *   - The file genuinely doesn't exist. Totally normal; fall back silently.
 *   - The file exists but is malformed or unreadable. The user has a broken
 *     config and deserves to know — silently treating it as absent produces
 *     wrong-but-confident output.
 *
 * {@link readJsonWithWarning} distinguishes the two. It never raises: a
 * malformed/unreadable file degrades to `[null, "<warning message>"]` rather
 * than an exception, so existing call sites can adopt it without introducing a
 * new failure mode. Callers are responsible for surfacing the warning message
 * (CLI output, log line, etc.) — this module only detects and describes the
 * problem.
 */

import { existsSync, readFileSync } from 'node:fs';

/** `[data, warning]` — the Python `tuple[Optional[dict], Optional[str]]`. */
export type ReadJsonResult = readonly [
  Record<string, unknown> | null,
  string | null,
];

/**
 * Read and parse a JSON file, distinguishing "absent" from "malformed".
 *
 * Returns a `[data, warning]` tuple:
 *
 *   - `[null, null]` — the file does not exist. Not an error; the caller
 *     should proceed as if there is no config.
 *   - `[null, "<message>"]` — the file exists but could not be read or parsed.
 *     The caller should surface this warning to the user instead of silently
 *     treating the config as absent.
 *   - `[data, null]` — the file exists and parsed successfully.
 *
 * Never raises.
 */
export function readJsonWithWarning(path: string): ReadJsonResult {
  let exists: boolean;
  try {
    exists = existsSync(path);
  } catch {
    // A broken symlink or similar can make even existence checks raise on some
    // platforms; treat it as "can't confirm presence" -> warn, don't crash.
    return [null, `${path} could not be accessed`];
  }

  if (!exists) {
    return [null, null];
  }

  let text: string;
  try {
    // ACCEPTED DIVERGENCE: Python's `read_text(encoding="utf-8")` raises an
    // UNCAUGHT `UnicodeDecodeError` on a non-UTF-8 file (the Python only catches
    // `OSError`), which contradicts this function's own "Never raises" contract.
    // Node's `readFileSync(path, 'utf-8')` substitutes U+FFFD instead, so a
    // non-UTF-8 config degrades to an invalid-JSON warning below rather than
    // crashing. We intentionally KEEP the safe behavior over the latent crash.
    text = readFileSync(path, 'utf-8');
  } catch (e) {
    return [null, `${path} exists but could not be read: ${errMessage(e)}`];
  }

  try {
    return [JSON.parse(text) as Record<string, unknown>, null];
  } catch (e) {
    return [null, `${path} exists but is not valid JSON: ${errMessage(e)}`];
  }
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
