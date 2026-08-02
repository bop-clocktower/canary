/**
 * Deterministic emit for the harness reverse-handoff (#899) producer contract.
 *
 * Faithful TypeScript port of `agent/guardian/analysis_emit.py`.
 *
 * Phase 5 turns the guardian's Tier-0 result into a **structured canary
 * analysis** that a future harness gate surface can consume in-flow. This module
 * owns the producer half:
 *
 *   - {@link analysisFilename} -- the `canary-pr-guardian-<ref>.json` naming
 *     convention. The `canary-pr-guardian-` prefix is load-bearing: harness's own
 *     `AnalysisArchive` stores records as `<issueId>.json` and reads *every*
 *     `*.json` in `.harness/analyses/`, so the prefix + sanitized ref namespaces
 *     canary's records -- they never clobber a harness record and always pass
 *     `AnalysisArchive.safePath` (no traversal).
 *   - {@link buildAnalysisRecord} -- the v1.0 envelope wrapping the verbatim
 *     `render(fmt="json")` findings array.
 *
 * SC-11 boundary: this module is deterministic filesystem/JSON only. It imports
 * no `AgentTier`/LLM-SDK module (only intra-guardian, agent-free helpers).
 *
 * Python->TS nuances:
 *   - `json.dumps(record, indent=2)` becomes `ensureAscii(JSON.stringify(record,
 *     null, 2))`. `JSON.stringify` with indent 2 matches Python's `(', ', ': ')`
 *     separators byte-for-byte; `ensureAscii` restores the `ensure_ascii=True`
 *     default so a non-ASCII evidence char (em-dash) escapes identically.
 *   - insertion-ordered object literals reproduce Python dict key order, and a
 *     first-seen-ordered plain object reproduces `Counter` -> `dict` order for
 *     `byFidelity`.
 *   - `tempfile.mkstemp` + `os.replace` becomes a same-dir random temp +
 *     `renameSync`, both behind {@link emitSeams} so tests can spy them the way
 *     the Python tests monkeypatch `emit_mod.os.replace` / `build_analysis_record`.
 */

import { createHash, randomBytes } from 'node:crypto';
import {
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import { Finding, render } from './pr-check.js';

export const SCHEMA_VERSION = '1.0';
export const SOURCE = 'canary-pr-guardian';
const REF_SAFE = /[^A-Za-z0-9._-]/g;
const REF_MAX = 100; // cap the sanitized ref so a long branch never hits ENAMETOOLONG

// The loud-fallback notices carry an em-dash (U+2014) as output data; written as
// an escape to honor the ASCII-source rule.
const EM_DASH = '\u{2014}';

/**
 * Escape every non-ASCII (>= U+0080) code unit to a `\uXXXX` sequence, matching
 * Python's `json.dumps(..., ensure_ascii=True)` (the library default).
 */
function ensureAscii(json: string): string {
  // Escape every UTF-16 code UNIT >= 0x80 to \uXXXX, matching Python
  // json.dumps(ensure_ascii=True). Iterating by unit (not code point) means an
  // astral char's surrogate pair emits \udXXX\udXXX, like Python; a code-point
  // regex would stop at U+FFFF and leave astral chars raw.
  let out = '';
  for (let i = 0; i < json.length; i++) {
    const c = json.charCodeAt(i);
    out += c >= 0x80 ? '\\u' + c.toString(16).padStart(4, '0') : json[i];
  }
  return out;
}

/** Trim leading/trailing `-` characters (Python `str.strip("-")`). */
function stripDashes(value: string): string {
  return value.replace(/^-+/, '').replace(/-+$/, '');
}

/**
 * `<source>-<sanitized-ref>.json`; empty/blank ref -> `<source>-local.json`.
 *
 * A very long ref would produce a filename that trips `ENAMETOOLONG` (always
 * degrades, never uses the channel), so the sanitized ref is truncated to
 * `REF_MAX` chars with a short hash suffix appended to preserve uniqueness --
 * only when truncation actually happens. Short refs are unchanged.
 */
export function analysisFilename(ref: string, source: string = SOURCE): string {
  let safe = stripDashes(ref.replace(REF_SAFE, '-')) || 'local';
  if (safe.length > REF_MAX) {
    // sha1 is a filename disambiguator (not a security digest); it matches the
    // Python oracle's hashlib.sha1(ref)[:8] cache-filename contract and the
    // input is a non-secret git ref. Changing it would break that byte contract.
    const algo = 'sha1'; // harness-ignore SEC-CRY-001: filename hash, not crypto
    const digest = createHash(algo)
      .update(ref, 'utf-8')
      .digest('hex')
      .slice(0, 8);
    safe = `${safe.slice(0, REF_MAX)}-${digest}`;
  }
  return `${source}-${safe}.json`;
}

/** The v1.0 analysis envelope (see the producer contract). */
export interface AnalysisRecord {
  schemaVersion: string;
  source: string;
  ref: string;
  gate: string;
  exitCode: number;
  checked: number;
  abstained: boolean;
  tier: number;
  degradedNotice: string | null;
  summary: {
    total: number;
    unaddressed: number;
    suppressed: number;
    byFidelity: Record<string, number>;
  };
  findings: unknown[];
  analyzedAt: string;
}

export interface BuildAnalysisRecordArgs {
  ref: string;
  gate: string;
  effective_tier: number;
  degraded_notice: string | null;
  exit_code: number;
  checked?: number;
  abstained?: boolean;
  analyzed_at?: string | null;
}

/** ISO-8601 UTC timestamp with a `+00:00` offset (Python `isoformat`-shaped). */
function isoUtcNow(): string {
  return new Date().toISOString().replace('Z', '+00:00');
}

/**
 * Build the v1.0 envelope. `findings` is exactly `render(fmt='json')`'s array.
 */
export function buildAnalysisRecord(
  findings: Finding[],
  args: BuildAnalysisRecordArgs,
): AnalysisRecord {
  const { ref, gate, effective_tier, degraded_notice, exit_code } = args;
  const inner = JSON.parse(
    render(findings, 'json', effective_tier, degraded_notice),
  ) as { findings: unknown[] };
  const active = findings.filter((f) => !f.suppressed);
  const suppressed = findings.filter((f) => f.suppressed);
  const byFidelity: Record<string, number> = {};
  for (const f of findings) {
    byFidelity[f.fidelity] = (byFidelity[f.fidelity] ?? 0) + 1;
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    source: SOURCE,
    ref,
    gate,
    exitCode: exit_code,
    checked: args.checked ?? 0,
    abstained: args.abstained ?? false,
    tier: effective_tier,
    degradedNotice: degraded_notice,
    summary: {
      total: findings.length,
      unaddressed: active.length,
      suppressed: suppressed.length,
      byFidelity,
    },
    findings: inner.findings,
    analyzedAt: args.analyzed_at ?? isoUtcNow(),
  };
}

/**
 * Outcome of an emit attempt.
 *
 * `action` is `'emitted'` | `'unavailable'`. `path` is the written file (`null`
 * when unavailable); `notice` is the LOUD fallback message, set only when
 * unavailable (the CLI turns it into the SC-10 sticky-comment fallback).
 */
export interface EmitResult {
  action: string;
  path: string | null;
  notice: string | null;
}

/**
 * Seams the tests spy: `buildAnalysisRecord` (Python monkeypatches
 * `build_analysis_record`) and `replace` (Python monkeypatches `os.replace`).
 * `emitAnalysis` calls them through this object so a `vi.spyOn(emitSeams, ...)`
 * takes effect exactly like the Python `monkeypatch.setattr`.
 */
export const emitSeams = {
  buildAnalysisRecord,
  replace: (src: string, dst: string): void => renameSync(src, dst),
};

/**
 * True iff the harness home (`dirname(analysesDir)`, i.e. `.harness/`) exists.
 *
 * The analyses dir itself is created on demand by {@link emitAnalysis} (mirroring
 * harness `AnalysisArchive.save`'s recursive `mkdir`).
 */
export function channelAvailable(analysesDir: string): boolean {
  try {
    return statSync(dirname(analysesDir)).isDirectory();
  } catch {
    return false;
  }
}

export interface EmitAnalysisArgs extends BuildAnalysisRecordArgs {
  analysesDir: string;
}

/**
 * Write one record to `analysesDir/<filename>`.
 *
 * On an absent channel or an I/O error (read-only FS, permission), return an
 * `'unavailable'` {@link EmitResult} carrying a loud notice -- never silently
 * drop the record (SC-10 fallback).
 */
export function emitAnalysis(
  findings: Finding[],
  args: EmitAnalysisArgs,
): EmitResult {
  const { analysesDir } = args;
  if (!channelAvailable(analysesDir)) {
    return {
      action: 'unavailable',
      path: null,
      notice:
        'guardian: harness analyses channel unavailable ' +
        `(.harness/ absent) ${EM_DASH} falling back to the sticky comment`,
    };
  }
  const target = join(analysesDir, analysisFilename(args.ref));
  try {
    // Build INSIDE the try: a non-I/O error (from JSON/render) would otherwise
    // crash pr-check instead of degrading.
    const record = emitSeams.buildAnalysisRecord(findings, args);
    mkdirSync(analysesDir, { recursive: true });
    // Atomic write: stage into a same-dir temp then rename (atomic on one
    // filesystem). A torn/partial file would break the harness consumer.
    const tmp = join(
      analysesDir,
      `.tmp-${randomBytes(8).toString('hex')}.json`,
    );
    writeFileSync(tmp, ensureAscii(JSON.stringify(record, null, 2)), 'utf-8');
    try {
      emitSeams.replace(tmp, target);
    } catch (err) {
      // Clean up the staged temp so a failed rename leaves no leftover.
      try {
        unlinkSync(tmp);
      } catch {
        // best-effort
      }
      throw err;
    }
  } catch (exc) {
    // Broadened beyond I/O: any build/render/write failure degrades to the LOUD
    // fallback rather than crashing pr-check (the CLI turns this notice into a
    // `::warning::` + sticky comment).
    const message = exc instanceof Error ? exc.message : String(exc);
    return {
      action: 'unavailable',
      path: null,
      notice:
        `guardian: analyses build/write failed (${message}) ${EM_DASH} ` +
        'falling back to the sticky comment',
    };
  }
  return { action: 'emitted', path: String(target), notice: null };
}
