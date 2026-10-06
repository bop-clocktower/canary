// Ingest reporter: POST with retry, response handling and log output.
import type { ResolvedConfig } from "./config";
import type { IngestPayload } from "./payload";

export interface IngestResponse {
  id?: number;
  duplicate?: boolean;
  result_count?: number;
  /** `null` when the dashboard recorded no catalog (including on a duplicate re-push). */
  collected_count?: number | null;
}

/**
 * What to tell the CI log about an ingest response. A `duplicate` answer is
 * only a harmless re-push when the stored run holds as many rows as this push
 * sent; otherwise this push's results were discarded, and that must not read
 * as a success line (#1148).
 */
export function ingestOutcome(
  data: IngestResponse,
  sent: { results: number; collected?: number },
): { level: "info" | "warn"; message: string } {
  const id = data.id ?? "?";
  if (!data.duplicate) {
    // Only checkable on a fresh ingest: a re-push records no catalog (null).
    if (sent.collected !== undefined && typeof data.collected_count === "number" && data.collected_count !== sent.collected) {
      return {
        level: "warn",
        message: `run ${id} ingested, but the dashboard recorded ${data.collected_count} collected tests and this push sent ${sent.collected}; the suite's denominator is wrong.`,
      };
    }
    return { level: "info", message: `run ${id} ingested.` };
  }
  if (data.result_count !== undefined && data.result_count !== sent.results) {
    return {
      level: "warn",
      message:
        `run ${id} was a duplicate: the stored run has ${data.result_count} results, this push sent ${sent.results}, ` +
        "and this push's results were discarded. Two jobs pushed the same suite under one run id; " +
        "push once per suite (merge-reports for sharded suites).",
    };
  }
  return { level: "info", message: `run ${id} already ingested (duplicate re-push).` };
}

/** A warning that must not scroll past: also raised as a GitHub Actions annotation. */
export function warn(message: string, env: NodeJS.ProcessEnv = process.env): void {
  if (env.GITHUB_ACTIONS === "true") console.log(`::warning title=canary ingest::${message}`);
  log(`WARNING — ${message}`);
}

export function log(message: string): void {
  console.log(`\ncanary ingest: ${message}`);
}

export function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** True for an answer worth retrying: the server's side, or rate limiting. */
function retryable(status: number): boolean {
  return status >= 500 || status === 429;
}

/** Longest wait a `Retry-After` can ask for; the dashboard's rate window is 60 s. */
const MAX_RETRY_AFTER_MS = 65_000;

/**
 * How long to wait before a retry: the backoff, or the server's `Retry-After`
 * (seconds) when longer, capped at 65 s. A date-form `Retry-After` is ignored.
 */
export function retryWaitMs(backoffMs: number, retryAfter: string | null | undefined): number {
  const seconds = retryAfter ? Number(retryAfter) : NaN;
  const asked = Number.isFinite(seconds) ? Math.min(seconds * 1000, MAX_RETRY_AFTER_MS) : 0;
  return Math.max(backoffMs, asked);
}

/** Per-request time limits; Playwright awaits `onEnd` with no limit of its own. */
export const PREFLIGHT_TIMEOUT_MS = 5_000;
const POST_TIMEOUT_MS = 30_000;

/**
 * POSTs with a bounded retry on 5xx, 429 and network errors (a timeout is a
 * network error). Ingest is idempotent on `(canary_run_id, suite)`, so a
 * retry can never double-count. A 4xx is a payload problem and is never
 * retried: the same bytes cannot succeed.
 */
async function postWithRetry(
  url: string,
  init: RequestInit,
  delaysMs: number[],
): Promise<{ resp?: Response; error?: unknown; attempts: number }> {
  let last: { resp?: Response; error?: unknown } = {};
  for (let attempt = 0; attempt <= delaysMs.length; attempt++) {
    if (attempt > 0) {
      const wait = retryWaitMs(delaysMs[attempt - 1], last.resp?.headers.get("retry-after"));
      await new Promise((r) => setTimeout(r, wait));
    }
    try {
      const resp = await fetch(url, { ...init, signal: AbortSignal.timeout(POST_TIMEOUT_MS) });
      if (!retryable(resp.status)) return { resp, attempts: attempt + 1 };
      last = { resp };
    } catch (error) {
      last = { error };
    }
  }
  return { ...last, attempts: delaysMs.length + 1 };
}

/** POSTs the run and turns the answer into one log line or warning. */
export async function push(cfg: ResolvedConfig, payload: IngestPayload): Promise<void> {
  const { resp, error, attempts } = await postWithRetry(
    `${cfg.url}/api/ingest/runs`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.token}` },
      body: JSON.stringify(payload),
    },
    cfg.retryDelaysMs,
  );
  if (resp?.ok) {
    const data = (await resp.json().catch(() => ({}))) as IngestResponse;
    const outcome = ingestOutcome(data, { results: payload.results.length, collected: payload.collected?.length });
    (outcome.level === "warn" ? warn : log)(outcome.message);
    return;
  }
  const why = resp ? `${resp.status} ${(await resp.text().catch(() => "")).slice(0, 200)}` : errText(error);
  warn(
    resp && !retryable(resp.status)
      ? `push rejected (${why}); run not ingested. A 4xx is a payload problem and is not retried.`
      : `run not ingested after ${attempts} attempts (${why}).`,
  );
}
