/**
 * The one `ensure_ascii=True` implementation (#710).
 *
 * Python's `json.dumps` escapes every non-ASCII character to `\uXXXX` by
 * default; `JSON.stringify` emits raw UTF-8. Every module that reproduces a
 * Python payload byte-for-byte therefore has to post-process its stringify
 * output, and eight of them used to do it with a private copy of this function.
 *
 * It lives under `util/` rather than in `cli-common.ts` (which documented it
 * first) because the copies were spread across the `core`, `guardian`, and
 * entry layers, and the layer model in `harness.config.json` lets nothing
 * depend on `cli`. `util` is the one leaf every layer is allowed to reach.
 *
 * `ts/test/shared-helper-single-source.test.ts` fails if a ninth copy appears.
 */

/**
 * Escape every non-ASCII UTF-16 code UNIT to `\uXXXX`, matching Python
 * `json.dumps(ensure_ascii=True)`.
 *
 * Iterating by code unit rather than code point is the load-bearing detail: an
 * astral character's surrogate pair emits `\udXXX\udXXX`, exactly as CPython
 * writes it. A code-point walk (`for (const ch of json)`) would instead reach
 * a value above `0xffff`, which does not fit a four-hex-digit `\uXXXX` escape
 * at all -- so it would either truncate or leave the character raw.
 *
 * Only the `>= 0x80` range is touched, so the ASCII escapes `JSON.stringify`
 * already produced (`\"`, `\\`, control characters) pass through intact.
 */
export function ensureAscii(json: string): string {
  let out = '';
  for (let i = 0; i < json.length; i++) {
    const c = json.charCodeAt(i);
    out += c >= 0x80 ? '\\u' + c.toString(16).padStart(4, '0') : json[i];
  }
  return out;
}
