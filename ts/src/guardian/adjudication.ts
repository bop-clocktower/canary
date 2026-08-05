/**
 * Finding adjudication collection — the precision the hard gate depends on
 * (#490).
 *
 * `pr-check.ts` documents the soft→hard promotion contract as
 * `precision = TP / (TP + FP)` fed by reviewer adjudication — but until this
 * module nothing collected adjudications, so no repo could ever earn the hard
 * gate. Reviewers already give the lowest-friction feedback available: a 👍
 * (true positive) or 👎 (false positive) reaction on the guardian's sticky
 * comment. This module reads those reactions back off the comment the guardian
 * already upserts by marker, and persists a per-PR adjudication record to the
 * existing `.harness/analyses/` channel (no new store — see
 * {@link module:./analysis-emit}).
 *
 * Granularity (per the #490 design sketch): **whole-comment first**. One sticky
 * comment carries N findings, so a reaction adjudicates the *run*, not one
 * finding — except when the comment shows exactly one active finding, in which
 * case the reaction is attributable to that finding's path. Per-finding
 * comments were rejected as a worse artifact (N comments per PR).
 *
 * Zero-denominator discipline: a precision computed over 0 adjudicated
 * findings is **unknown**, never 100%. {@link summarizePrecision} returns
 * `precision: null` and {@link renderPrecision} says so in words. Most
 * reviewers react to neither — the sample is small and self-selected, and every
 * rendered surface states the sample size rather than presenting the number as
 * ground truth.
 *
 * SC-11 boundary: deterministic HTTP/filesystem behind seams — no agent/LLM
 * import. Network lives ONLY in {@link RestReactionsClient}; every unit test
 * uses {@link FakeReactionsClient}.
 */

import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';

import { Comment, STICKY_MARKER, findSticky } from './pr-comment.js';

/** Schema tag for adjudication records (independent of the findings schema). */
export const ADJUDICATION_SCHEMA_VERSION = '1.0';

/**
 * Record `source` + filename prefix. Deliberately namespaced UNDER the
 * `canary-pr-guardian-` prefix (harness's `AnalysisArchive` reads every
 * `*.json` in `.harness/analyses/`) while never colliding with a pr-check
 * findings record: those are `canary-pr-guardian-<sanitized-ref>.json` and a
 * ref is sanitized from a git ref / `pr-<n>`, never `adjudication-pr-<n>`.
 */
export const ADJUDICATION_SOURCE = 'canary-pr-guardian-adjudication';

/** GitHub reaction contents that carry an adjudication verdict. */
const THUMBS_UP = '+1';
const THUMBS_DOWN = '-1';

// Loud notices carry an em-dash as output data; escaped per the ASCII-source rule.
const EM_DASH = '\u{2014}';

/** One reaction row off the GitHub API (only the fields we read). */
export interface Reaction {
  /** Reacting user's login (`user.login` in the REST payload). */
  user: string;
  /** Reaction content: `+1`, `-1`, `laugh`, `confused`, `heart`, ... */
  content: string;
}

/**
 * The reactions seam. Reads the PR's comments (to locate the sticky comment by
 * marker) and a comment's reactions. Read-only — collection never writes to
 * GitHub, so it works on fork PRs where the token cannot comment.
 */
export interface ReactionsClient {
  listComments(): Promise<Comment[]>;
  listReactions(commentId: number): Promise<Reaction[]>;
}

/** In-memory {@link ReactionsClient} for unit tests — no network. */
export class FakeReactionsClient implements ReactionsClient {
  comments: Comment[];
  reactionsByComment: Map<number, Reaction[]>;

  constructor(
    init: {
      comments?: Comment[];
      reactions?: Record<number, Reaction[]>;
    } = {},
  ) {
    this.comments = init.comments ?? [];
    this.reactionsByComment = new Map(
      Object.entries(init.reactions ?? {}).map(([id, rows]) => [
        Number(id),
        rows,
      ]),
    );
  }

  async listComments(): Promise<Comment[]> {
    return this.comments;
  }

  async listReactions(commentId: number): Promise<Reaction[]> {
    return this.reactionsByComment.get(commentId) ?? [];
  }
}

/**
 * Thin real {@link ReactionsClient} over the GitHub REST API (`fetch`).
 * Network lives ONLY here; no unit test exercises this class. Both endpoints
 * are reads, so a fork's read-only token is sufficient.
 */
export class RestReactionsClient implements ReactionsClient {
  private static readonly API = 'https://api.github.com';

  constructor(
    private readonly repo: string,
    private readonly prNumber: number,
    private readonly token: string,
  ) {}

  private async get(url: string): Promise<unknown> {
    const resp = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'canary-pr-guardian',
      },
    });
    if (!resp.ok) {
      throw new Error(`GitHub API ${resp.status}: ${url}`);
    }
    return resp.json();
  }

  async listComments(): Promise<Comment[]> {
    const url = `${RestReactionsClient.API}/repos/${this.repo}/issues/${this.prNumber}/comments`;
    const result = await this.get(url);
    return Array.isArray(result) ? (result as Comment[]) : [];
  }

  async listReactions(commentId: number): Promise<Reaction[]> {
    const url = `${RestReactionsClient.API}/repos/${this.repo}/issues/comments/${commentId}/reactions`;
    const result = await this.get(url);
    if (!Array.isArray(result)) return [];
    const rows: Reaction[] = [];
    for (const raw of result) {
      if (typeof raw !== 'object' || raw === null) continue;
      const rec = raw as { content?: unknown; user?: { login?: unknown } };
      const content = typeof rec.content === 'string' ? rec.content : '';
      const user =
        typeof rec.user?.login === 'string' ? rec.user.login : 'unknown';
      if (content) rows.push({ user, content });
    }
    return rows;
  }
}

/** The 👍/👎 tally over one comment's reactions, one vote per human user. */
export interface AdjudicationTally {
  /** Users whose only verdict reaction was 👍 (true positive). */
  tp: number;
  /** Users whose only verdict reaction was 👎 (false positive). */
  fp: number;
  /** Users who reacted BOTH ways — contradictory, dropped from the sample. */
  ambiguous: number;
}

/**
 * Tally verdict reactions: one vote per user, bots excluded (PURE).
 *
 * - Only `+1`/`-1` carry a verdict; every other content is ignored.
 * - Logins ending in `[bot]` are excluded so the guardian's own automation (or
 *   any other bot) can never inflate its own precision.
 * - A user who reacted both 👍 and 👎 is contradictory: counted as `ambiguous`
 *   and excluded from both TP and FP rather than guessed at.
 */
export function tallyAdjudications(reactions: Reaction[]): AdjudicationTally {
  const up = new Set<string>();
  const down = new Set<string>();
  for (const reaction of reactions) {
    if (reaction.user.endsWith('[bot]')) continue;
    if (reaction.content === THUMBS_UP) up.add(reaction.user);
    else if (reaction.content === THUMBS_DOWN) down.add(reaction.user);
  }
  let ambiguous = 0;
  for (const user of up) {
    if (down.has(user)) ambiguous += 1;
  }
  return {
    tp: up.size - ambiguous,
    fp: down.size - ambiguous,
    ambiguous,
  };
}

// A findings-table row in the sticky comment: `| <icon> <sev> | `path`... |`.
// The header row's second cell is ` File ` and the separator's is ` --- `,
// neither of which starts with a backtick, so anchoring on the second cell's
// leading backtick selects exactly the finding rows. Paths never contain `|`
// or backticks (see `fileLabel` in pr-check.ts), so the naive anchor is safe.
//
// The optional `[` accommodates the permalinked cell — `fileLabel` wraps the
// path as `[`path`](<blob url>)` whenever a blob base is resolvable, which is
// the normal case in CI. Without it this regex matched nothing on every posted
// comment and `activeFindingPaths` returned `[]`, zeroing the precision
// denominator silently instead of failing (#490, #508).
const FINDING_ROW_RE = /^\|[^|]*\|\s*\[?`([^`]+)`/;

/**
 * Extract the file paths of the ACTIVE findings shown in a sticky-comment body
 * (PURE). Reads the rendered table `render(fmt='comment')` emitted — this is
 * deliberately parsing the exact body reviewers reacted to, not the current
 * finding set, so a reaction is attributed to what the reviewer actually saw.
 * Returns `[]` for a no-gaps body (no table).
 */
export function activeFindingPaths(commentBody: string): string[] {
  const paths: string[] = [];
  for (const line of commentBody.split(/\r\n|\r|\n/)) {
    const match = FINDING_ROW_RE.exec(line);
    if (match) paths.push(match[1]!);
  }
  return paths;
}

/** One persisted adjudication record — the latest reaction state for one PR. */
export interface AdjudicationRecord {
  schemaVersion: string;
  source: string;
  repo: string;
  prNumber: number;
  commentId: number;
  /**
   * `finding` when the comment showed exactly one active finding (the reaction
   * adjudicates that finding); `run` when it showed several (the reaction
   * adjudicates the run as a whole and cannot name which finding was wrong).
   */
  granularity: 'finding' | 'run';
  /** The adjudicated finding's path; set only when `granularity === 'finding'`. */
  attributedPath: string | null;
  /** Active finding paths shown in the reacted-to comment body. */
  findingPaths: string[];
  tp: number;
  fp: number;
  ambiguous: number;
  collectedAt: string;
}

/** ISO-8601 UTC timestamp with a `+00:00` offset (matches analysis-emit). */
function isoUtcNow(): string {
  return new Date().toISOString().replace('Z', '+00:00');
}

/** Build the v1.0 adjudication record (PURE given `collectedAt`). */
export function buildAdjudicationRecord(init: {
  repo: string;
  prNumber: number;
  commentId: number;
  commentBody: string;
  tally: AdjudicationTally;
  collectedAt?: string | undefined;
}): AdjudicationRecord {
  const findingPaths = activeFindingPaths(init.commentBody);
  const single = findingPaths.length === 1;
  return {
    schemaVersion: ADJUDICATION_SCHEMA_VERSION,
    source: ADJUDICATION_SOURCE,
    repo: init.repo,
    prNumber: init.prNumber,
    commentId: init.commentId,
    granularity: single ? 'finding' : 'run',
    attributedPath: single ? findingPaths[0]! : null,
    findingPaths,
    tp: init.tally.tp,
    fp: init.tally.fp,
    ambiguous: init.tally.ambiguous,
    collectedAt: init.collectedAt ?? isoUtcNow(),
  };
}

/** `canary-pr-guardian-adjudication-pr-<n>.json` under the analyses dir. */
export function adjudicationFilename(prNumber: number): string {
  return `${ADJUDICATION_SOURCE}-pr-${prNumber}.json`;
}

/**
 * Outcome of a {@link collectAdjudications} attempt.
 *
 * `action`:
 *   - `collected`     — reactions found; record written to `path`.
 *   - `no-comment`    — the PR has no guardian sticky comment (nothing posted
 *                       yet, or a fork degradation) — nothing to adjudicate.
 *   - `no-reactions`  — sticky comment exists but carries no 👍/👎 yet; no
 *                       record is written (absence of a reaction is neutral,
 *                       never a data point).
 *   - `unavailable`   — the `.harness/` channel is absent or the write failed;
 *                       `notice` carries the loud message.
 */
export interface CollectResult {
  action: 'collected' | 'no-comment' | 'no-reactions' | 'unavailable';
  path: string | null;
  record: AdjudicationRecord | null;
  notice: string | null;
}

/** True iff the harness home (`dirname(analysesDir)`) exists. */
function channelAvailable(analysesDir: string): boolean {
  try {
    return statSync(dirname(analysesDir)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Read the sticky comment's reactions and persist the PR's adjudication record.
 *
 * Idempotent per PR: the record is the LATEST reaction state, overwritten in
 * place on each collection (reactions live on the comment, which the guardian
 * upserts rather than re-creates, so they accumulate monotonically). Records
 * for different PRs never collide — the store is append-only across PRs.
 *
 * Never throws for an expected shape: a missing comment, zero reactions, or an
 * unavailable channel each return a distinct non-`collected` result so the
 * caller can report honestly instead of crashing the gate.
 */
export async function collectAdjudications(
  client: ReactionsClient,
  args: {
    repo: string;
    prNumber: number;
    analysesDir: string;
    marker?: string;
    collectedAt?: string;
  },
): Promise<CollectResult> {
  const sticky = findSticky(
    await client.listComments(),
    args.marker ?? STICKY_MARKER,
  );
  if (sticky === null) {
    return { action: 'no-comment', path: null, record: null, notice: null };
  }

  const tally = tallyAdjudications(await client.listReactions(sticky.id));
  if (tally.tp + tally.fp + tally.ambiguous === 0) {
    return { action: 'no-reactions', path: null, record: null, notice: null };
  }

  const record = buildAdjudicationRecord({
    repo: args.repo,
    prNumber: args.prNumber,
    commentId: sticky.id,
    commentBody: sticky.body,
    tally,
    collectedAt: args.collectedAt,
  });

  if (!channelAvailable(args.analysesDir)) {
    return {
      action: 'unavailable',
      path: null,
      record,
      notice:
        'guardian: harness analyses channel unavailable (.harness/ absent) ' +
        `${EM_DASH} adjudication not persisted`,
    };
  }

  const target = join(args.analysesDir, adjudicationFilename(args.prNumber));
  try {
    mkdirSync(args.analysesDir, { recursive: true });
    // Atomic write (same-dir temp + rename), matching analysis-emit: a torn
    // record would poison every later precision summary.
    const tmp = join(
      args.analysesDir,
      `.tmp-${randomBytes(8).toString('hex')}.json`,
    );
    writeFileSync(tmp, JSON.stringify(record, null, 2), 'utf-8');
    try {
      renameSync(tmp, target);
    } catch (err) {
      try {
        unlinkSync(tmp);
      } catch {
        // best-effort cleanup
      }
      throw err;
    }
  } catch (exc) {
    const message = exc instanceof Error ? exc.message : String(exc);
    return {
      action: 'unavailable',
      path: null,
      record,
      notice:
        `guardian: adjudication write failed (${message}) ${EM_DASH} ` +
        'adjudication not persisted',
    };
  }
  return { action: 'collected', path: target, record, notice: null };
}

/**
 * Load every adjudication record under `analysesDir` (best-effort).
 *
 * Reads only `canary-pr-guardian-adjudication-*.json`; pr-check findings
 * records and harness's own records are never touched. A malformed or
 * wrong-`source` file is skipped, never fatal — one corrupt record must not
 * take down the precision report.
 */
export function loadAdjudicationRecords(
  analysesDir: string,
): AdjudicationRecord[] {
  let names: string[];
  try {
    names = readdirSync(analysesDir);
  } catch {
    return [];
  }
  const records: AdjudicationRecord[] = [];
  for (const name of names.sort()) {
    if (!name.startsWith(`${ADJUDICATION_SOURCE}-`) || !name.endsWith('.json'))
      continue;
    try {
      const raw = JSON.parse(
        readFileSync(join(analysesDir, name), 'utf-8'),
      ) as Partial<AdjudicationRecord> | null;
      if (
        raw !== null &&
        typeof raw === 'object' &&
        raw.source === ADJUDICATION_SOURCE &&
        typeof raw.tp === 'number' &&
        typeof raw.fp === 'number'
      ) {
        records.push(raw as AdjudicationRecord);
      }
    } catch {
      // skip malformed record
    }
  }
  return records;
}

/** The aggregate precision a rollout decision consumes. */
export interface PrecisionSummary {
  /** Adjudicated verdicts: `tp + fp` (the fair denominator, per #490). */
  adjudicated: number;
  tp: number;
  fp: number;
  ambiguous: number;
  /** PRs contributing at least one verdict. */
  prCount: number;
  /**
   * `tp / (tp + fp)`, or `null` when nothing has been adjudicated. A `null`
   * here MUST render as "unknown" — zero adjudications is an absent
   * measurement, not a perfect score.
   */
  precision: number | null;
}

/** Aggregate records into the precision summary (PURE). */
export function summarizePrecision(
  records: AdjudicationRecord[],
): PrecisionSummary {
  let tp = 0;
  let fp = 0;
  let ambiguous = 0;
  let prCount = 0;
  for (const record of records) {
    tp += record.tp;
    fp += record.fp;
    ambiguous += record.ambiguous ?? 0;
    if (record.tp + record.fp > 0) prCount += 1;
  }
  const adjudicated = tp + fp;
  return {
    adjudicated,
    tp,
    fp,
    ambiguous,
    prCount,
    precision: adjudicated === 0 ? null : tp / adjudicated,
  };
}

/**
 * Render the precision summary as human text (PURE).
 *
 * Zero-denominator discipline: with no adjudications the FIRST word after the
 * label is `unknown` — the report never implies 100% (or any number) from an
 * empty sample. With data, the sample size and its self-selected nature ride
 * alongside the number on the same line.
 */
export function renderPrecision(summary: PrecisionSummary): string {
  if (summary.precision === null) {
    return (
      `guardian precision: unknown ${EM_DASH} no adjudications yet ` +
      `(0 reviewer verdicts collected). React with a thumbs-up (finding was ` +
      `right) or thumbs-down (false positive) on the guardian's PR comment.`
    );
  }
  const pct = (summary.precision * 100).toFixed(1).replace(/\.0$/, '');
  const ambiguousNote =
    summary.ambiguous > 0
      ? ` ${summary.ambiguous} contradictory verdict(s) excluded.`
      : '';
  return (
    `guardian precision: ${pct}% (${summary.tp} true / ${summary.fp} false ` +
    `positive${summary.adjudicated === 1 ? '' : 's'}, n=${summary.adjudicated} ` +
    `across ${summary.prCount} PR(s)).${ambiguousNote} Sample is ` +
    `self-selected (reviewers who chose to react) ${EM_DASH} a signal, not ` +
    `ground truth.`
  );
}
