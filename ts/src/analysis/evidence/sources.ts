/** File readers for the evidence pack (#855). A bad source is reported with its reason, never skipped. */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';

import { errnoCode } from '../../core/gate-result.js';
import {
  HistoryContentError,
  NdjsonHistoryStore,
} from '../../history/ndjson-store.js';
import type {
  CatalogueRow,
  EvidenceItem,
  Scope,
  SourceId,
  SourceReport,
} from './types.js';

type Src = { id: SourceId; path: string; scope: Scope };
type Dark = 'absent' | 'unreadable' | 'out-of-window';
type Ref = EvidenceItem['ref'];
type Raw = { date: unknown; summary: string; ref: Ref; repo?: unknown };
type Loaded = (Raw | string)[] | SourceReport;

const REPO_SLUG = /^[\w.-]+\/[\w.-]+$/;
const FULL_SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
/** Mirrors CAUSES in canary-katana's ledger.mjs; evidence-injection.test.ts fails if they drift. */
export const CAUSES = [
  'flaky',
  'product-defect',
  'blocked-data',
  'pending-feature',
  'obsolete',
  'env-gated',
];
const ZERO = { read: 0, inWindow: 0, undated: 0, items: [] };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** `src/data` under vitest, `dist/data` once built (ts/scripts/copy-data.mjs). */
export function loadCatalogue(): CatalogueRow[] {
  const url = new URL('../../data/evidence/controls.json', import.meta.url);
  const doc = JSON.parse(readFileSync(url, 'utf-8')) as unknown;
  return (doc as { controls: CatalogueRow[] }).controls;
}

export function noItems(src: Src, state: Dark, reason: string): SourceReport {
  return { id: src.id, path: src.path, state, reason, ...ZERO };
}

const shaOf = (ref: Ref): string =>
  ref.kind === 'commit' ? ref.id : (ref.commit ?? '');

/**
 * A commit URL is built only from the repository the caller gave and a full
 * SHA (D13). A `repo` inside a data file is never linked to; one that differs
 * from the caller's is said to be unverified.
 */
function toItem(src: Src, raw: Raw, ms: number): EvidenceItem {
  const repo = src.scope.repo ?? '';
  const sha = shaOf(raw.ref);
  const foreign =
    repo !== '' && typeof raw.repo === 'string' && raw.repo !== repo;
  const ok = !foreign && REPO_SLUG.test(repo) && FULL_SHA.test(sha);
  const url = `https://github.com/${repo}/commit/${sha}`;
  const ref = ok ? { ...raw.ref, url } : raw.ref;
  const note = foreign
    ? ` [unverified: the report names ${String(raw.repo)}, not ${repo}]`
    : '';
  const at = new Date(ms).toISOString();
  return { source: src.id, at, summary: raw.summary + note, ref };
}

export function oneItem(src: Src, raw: Raw): SourceReport {
  const items = [toItem(src, raw, Date.parse(String(raw.date)))];
  const counts = { read: 1, inWindow: 1, undated: 0, items };
  return { id: src.id, path: src.path, state: 'read', ...counts };
}

function windowed(src: Src, loaded: (Raw | string)[]): SourceReport {
  const since = Date.parse(src.scope.since);
  const until = Date.parse(src.scope.until);
  const reasons = loaded.filter((r) => typeof r === 'string');
  const raws = loaded.filter((r) => typeof r !== 'string');
  const items: EvidenceItem[] = [];
  let undated = 0;
  let unlinked = 0;
  for (const raw of raws) {
    const ms = typeof raw.date === 'string' ? Date.parse(raw.date) : NaN;
    if (Number.isNaN(ms)) undated += 1;
    else if (raw.ref.id === '') unlinked += 1;
    else if (ms >= since && ms < until) items.push(toItem(src, raw, ms));
  }
  if (undated > 0) reasons.push(`${undated} record(s) have no usable date`);
  if (unlinked > 0) reasons.push(`${unlinked} record(s) have no identifier`);
  const counts = { read: raws.length, inWindow: items.length, undated, items };
  const { id, path } = src;
  if (reasons.length === 0) return { id, path, state: 'read', ...counts };
  return { id, path, state: 'partial', reason: reasons.join('; '), ...counts };
}

/** Why a read failed ('' for ENOENT). Any other kind of error is a bug and still throws. */
function problemOf(err: unknown, path: string): string {
  if (err instanceof SyntaxError) return 'not valid JSON';
  if (err instanceof HistoryContentError) return err.reasonFor(path);
  const code = errnoCode(err);
  if (code === null) throw err;
  return code === 'ENOENT' ? '' : `could not be read (${code})`;
}

type Loader = (file: string) => Loaded;

/** Sources live under the root; only a typed --batwoman directory is read where it was typed. */
function read(src: Src, hint: string, load: Loader, typed?: string) {
  try {
    const file = typed ?? `${src.scope.root}/${src.path}`;
    // A missing path is absent for every source: readAll() alone reads it as empty.
    statSync(file);
    const loaded = load(file);
    return Array.isArray(loaded) ? windowed(src, loaded) : loaded;
  } catch (err) {
    const why = problemOf(err, src.path);
    if (why !== '') return noItems(src, 'unreadable', why);
    return noItems(src, 'absent', `nothing at ${src.path}; ${hint}`);
  }
}

type StoredRun = ReturnType<NdjsonHistoryStore['readAll']>[number];

const count = (n: number | undefined): number => n ?? 0;

function runRaw(r: StoredRun): Raw {
  const id = typeof r.run_id === 'string' ? r.run_id : '';
  // Counts only: error_text can hold secrets (D12).
  const summary = `run ${id} (${r.suite}): ${count(r.passed)} passed, ${count(r.failed)} failed, ${count(r.flaky)} flaky of ${count(r.total)}`;
  const commit = r.commit_sha ? { commit: r.commit_sha } : {};
  return { date: r.timestamp, summary, ref: { kind: 'run', id, ...commit } };
}

export function readHistory(scope: Scope): SourceReport {
  const hint = 'record runs with `canary history record`';
  // The default store of `canary history` (DEFAULT_HISTORY_FILE in history/cli.ts).
  const path = 'test-results/reports/history-v2.jsonl';
  return read({ id: 'history', path, scope }, hint, (file) =>
    new NdjsonHistoryStore(file).readAll().map(runRaw),
  );
}

function ledgerRaw(entry: unknown): Raw {
  const row = isRecord(entry) ? entry : {};
  const text = (key: string, fallback = ''): string => {
    const value = row[key];
    return typeof value === 'string' && value !== '' ? value : fallback;
  };
  const [file, test, commit] = [text('file'), text('test'), text('commit')];
  const cause = text('cause');
  const known = CAUSES.includes(cause) ? cause : 'unrecognised cause';
  const why = cause === '' ? text('reason', 'no reason recorded') : known;
  const id = file && test ? `${file}::${test}` : '';
  return {
    date: row.date,
    summary: `${text('kind', 'recorded')} ${test} in ${file} by ${text('author', 'unknown author')}: ${why}`,
    ref: { kind: 'ledger-entry', id, ...(commit ? { commit } : {}) },
  };
}

export function readLedger(scope: Scope): SourceReport {
  const src: Src = { id: 'katana', path: '.canary/quarantine.json', scope };
  return read(src, 'canary-katana writes it', (file) => {
    const doc: unknown = JSON.parse(readFileSync(file, 'utf-8'));
    const entries = isRecord(doc) && doc.schema_version === 2 ? doc.entries : 0;
    if (Array.isArray(entries)) return entries.map(ledgerRaw);
    return noItems(src, 'unreadable', 'not a katana v2 ledger with entries');
  });
}

function statusTally(files: unknown[]): string {
  const statuses = files.map((f) => (isRecord(f) ? String(f.status) : '?'));
  const times = (s: string): number => statuses.filter((x) => x === s).length;
  const tally = [...new Set(statuses)].map((s) => `${s}: ${times(s)}`);
  return tally.join(', ') || 'no files';
}

function reportRaw(dir: string, name: string): Raw | string {
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(`${dir}/${name}`, 'utf-8'));
  } catch (err) {
    return `${name}: ${problemOf(err, name) || 'gone before it was read'}`;
  }
  const r = isRecord(doc) ? doc : {};
  const { issue, mergeSha, mergedAt, files, pullRequest, repo } = r;
  const shaped = typeof issue === 'number' && typeof mergeSha === 'string';
  if (!shaped || typeof mergedAt !== 'string' || !Array.isArray(files)) {
    return `${name}: lacks issue, mergeSha, mergedAt or files`;
  }
  const summary = `issue #${issue} (PR #${String(pullRequest)}) from ${name}: ${statusTally(files)}`;
  const ref = { kind: 'commit' as const, id: mergeSha };
  return { date: mergedAt, summary, ref, repo };
}

/** D9: a path or slug the caller typed that is wrong is a usage error, never an absent source. */
export function typo(scope: Scope): string | null {
  const paths = [scope.root, scope.batwoman ?? scope.root];
  const gone = paths.find((path) => !existsSync(path));
  if (gone !== undefined) return `${gone} does not exist`;
  const slug = scope.repo === undefined || REPO_SLUG.test(scope.repo);
  return slug ? null : `${scope.repo} is not an owner/name slug`;
}

export function readBatwoman(scope: Scope): SourceReport {
  const path = scope.batwoman ?? '.canary/batwoman';
  const src: Src = { id: 'batwoman', path, scope };
  const hint = `save one with \`canary batwoman --issue <n> --json > ${path}/<n>.json\``;
  const load: Loader = (dir) => {
    const names = readdirSync(dir).filter((n) => n.endsWith('.json'));
    if (names.length > 0) return names.sort().map((n) => reportRaw(dir, n));
    return noItems(src, 'absent', `no *.json report; ${hint}`);
  };
  return read(src, hint, load, scope.batwoman);
}
