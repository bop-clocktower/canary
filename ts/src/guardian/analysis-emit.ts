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
 *     `renderFindings(fmt="json")` findings array.
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

import { SkipEntry } from '../core/gate-result.js';
import { ensureAscii } from '../util/ensure-ascii.js';
import {
  CoverageInputState,
  coverageDegradedNotice,
  coverageStatus,
} from './coverage.js';
import {
  DiffProvenance,
  GuardianFinding,
  combineNotices,
  renderFindings,
} from './pr-check.js';

// 1.1 adds the additive `coverage` block (#554); readers of 1.0 are unaffected.
// 1.2 adds the additive `skipped` list (#582). Additive again, and bumped again
// for the reason recorded in #572: a reader that pins a version must be able to
// tell which fields it can rely on being present, and silence about a new field
// is indistinguishable from the field being absent for a real reason.
// 1.3 adds the additive `provenance` block (#761). Same additive rule. This is
// the field an archived record needs most: when a run is questioned WEEKS later
// from its uploaded artifact, `checked: 43` is only interpretable next to the
// diff endpoints that produced it.
export const SCHEMA_VERSION = '1.3';
const ANALYSIS_SOURCE = 'canary-pr-guardian';
const REF_SAFE = /[^A-Za-z0-9._-]/g;
const REF_MAX = 100; // cap the sanitized ref so a long branch never hits ENAMETOOLONG

// The loud-fallback notices carry an em-dash (U+2014) as output data; written as
// an escape to honor the ASCII-source rule.
const EM_DASH = '\u{2014}';

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
export function analysisFilename(
  ref: string,
  source: string = ANALYSIS_SOURCE,
): string {
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
  /**
   * What the coverage input actually was (#554). `null` only for a producer
   * that never ran the coverage ladder — `pr-check` always populates it, so a
   * null here is "not applicable", never "unknown".
   */
  coverage: (CoverageInputState & { status: string }) | null;
  /**
   * Every unit this run declined to judge, with its suppression class (#582).
   *
   * Always an array — `[]` means "nothing was dropped", never "unknown". The
   * `reason` tokens are deliberately distinct per filter ('test support' vs
   * 'type-only module'), and that distinction only buys anything if it survives
   * into the record: adjudication measures suppression classes over time from
   * here, which is what makes a precision regression in one filter visible.
   */
  skipped: SkipEntry[];
  /**
   * What the diff was taken between (#761), or `null` for a producer that
   * never resolved one. Every count in this record is scoped by these
   * endpoints, so a record without them cannot be audited after the fact —
   * which is the position #761's inflated-diff run left its own artifact in.
   */
  provenance: DiffProvenance | null;
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
  /** The run's coverage-input state; folded into `degradedNotice` too (#554). */
  coverage?: CoverageInputState | null;
  /** What the run declined to judge, and why; defaults to `[]` (#582). */
  skipped?: SkipEntry[];
  /** What the diff was taken between (#761). */
  provenance?: DiffProvenance | null;
}

/** ISO-8601 UTC timestamp with a `+00:00` offset (Python `isoformat`-shaped). */
function isoUtcNow(): string {
  return new Date().toISOString().replace('Z', '+00:00');
}

/**
 * Build the v1.0 envelope. `findings` is exactly the array from
 * `renderFindings(fmt='json')`.
 */
export function buildAnalysisRecord(
  findings: GuardianFinding[],
  args: BuildAnalysisRecordArgs,
): AnalysisRecord {
  const { ref, gate, effective_tier, degraded_notice, exit_code } = args;
  // #554: the record states BOTH degradations — the tier's and the coverage
  // input's — so "no findings" can never be read as "coverage said so".
  const coverage = args.coverage ?? null;
  const notice = combineNotices(
    degraded_notice,
    coverage ? coverageDegradedNotice(coverage) : null,
  );
  const inner = JSON.parse(
    renderFindings(findings, 'json', effective_tier, notice),
  ) as { findings: unknown[] };
  const active = findings.filter((f) => !f.suppressed);
  const suppressed = findings.filter((f) => f.suppressed);
  const byFidelity: Record<string, number> = {};
  for (const f of findings) {
    byFidelity[f.fidelity] = (byFidelity[f.fidelity] ?? 0) + 1;
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    source: ANALYSIS_SOURCE,
    ref,
    gate,
    exitCode: exit_code,
    checked: args.checked ?? 0,
    abstained: args.abstained ?? false,
    tier: effective_tier,
    degradedNotice: notice,
    coverage:
      coverage === null
        ? null
        : { status: coverageStatus(coverage), ...coverage },
    skipped: args.skipped ?? [],
    provenance: args.provenance ?? null,
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
export function isChannelAvailable(analysesDir: string): boolean {
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
  findings: GuardianFinding[],
  args: EmitAnalysisArgs,
): EmitResult {
  const { analysesDir } = args;
  if (!isChannelAvailable(analysesDir)) {
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
    // Build INSIDE the try: a non-I/O error (from JSON/renderFindings) would
    // otherwise crash pr-check instead of degrading.
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
