// Ingest reporter: the run as a `canary.run/1` record (#1151 phase 2).
//
// Built FROM the ingest payload, so the shard-aware id (#1148), the deduped
// rows and the run timing are the ones the dashboard receives. The payload
// itself is unchanged; this is a second, contract-shaped view of it.
import fs from "node:fs";
import path from "node:path";
import type { IngestPayload, ResultEntry, Shard } from "./payload.js";
import { errText, log, warn } from "./transport.js";

export interface RunRecordContext {
  scope: { id: string; env: string };
  shard: Shard;
  /** Playwright's `FullResult.status`. */
  fullResultStatus?: string;
  env: NodeJS.ProcessEnv;
  version: string;
}

const SHA = /^[0-9a-f]{7,64}$/;

export function toRunRecord(payload: IngestPayload, ctx: RunRecordContext) {
  const results = payload.results.map(toResult);
  const count = (s: string) => results.filter((r) => r.status === s).length;
  const shard = ctx.shard && ctx.shard.total > 1 ? { index: ctx.shard.current, total: ctx.shard.total } : null;
  return {
    contract: "canary.run/1",
    scope: ctx.scope,
    producer: {
      name: "canary-test-cli/reporter",
      version: ctx.version,
      channel: isCI(ctx.env) ? "ci" : "local",
    },
    run: {
      id: payload.canary_run_id,
      suite: payload.suite,
      branch: ctx.env.GITHUB_REF_NAME || null,
      commit_sha: payload.commit_sha && SHA.test(payload.commit_sha) ? payload.commit_sha : null,
      started_at: payload.started_at,
      finished_at: payload.finished_at,
      ci_url: ciUrl(ctx.env),
      status: contractStatus(payload.status, ctx.fullResultStatus),
      shard,
    },
    totals: {
      passed: count("passed"),
      failed: count("failed"),
      flaky: count("flaky"),
      skipped: count("skipped"),
      timed_out: count("timed_out"),
      interrupted: count("interrupted"),
      total: results.length,
    },
    results,
    // Omitted from the payload = not reported = null; `[]` stays a measured zero.
    collected: payload.collected ? payload.collected.map((c) => ({ title: c.full_title, file: c.test_file })) : null,
  };
}

/** The contract has no run-level `flaky`, and a run that did not finish is `cancelled`. */
function contractStatus(ingest: IngestPayload["status"], full?: string): "passed" | "failed" | "cancelled" {
  if (ingest === "cancelled" || full === "timedout") return "cancelled";
  return ingest === "failed" ? "failed" : "passed";
}

/** Ingest sends an interrupted test as `failed` + an `interrupted` tag (#1149); the contract has its own status. */
function toResult(r: ResultEntry) {
  return {
    title: r.full_title,
    file: r.test_file,
    status: r.tags.includes("interrupted") ? "interrupted" : r.status,
    // Absent only for a test that never started (Playwright reports -1).
    duration_ms: r.duration_ms ?? 0,
    retries: r.retries,
    area: r.area ?? null,
    tags: r.tags,
    error: resultError(r),
  };
}

function resultError(r: ResultEntry): { message: string; stack: string | null } | null {
  if (r.error_message === undefined && r.error_stack === undefined) return null;
  return { message: r.error_message ?? "", stack: r.error_stack ?? null };
}

function isCI(env: NodeJS.ProcessEnv): boolean {
  return env.CI === "true" || env.GITHUB_ACTIONS === "true";
}

function ciUrl(env: NodeJS.ProcessEnv): string | null {
  const { GITHUB_SERVER_URL: server, GITHUB_REPOSITORY: repo, GITHUB_RUN_ID: id } = env;
  return server && repo && id ? `${server}/${repo}/actions/runs/${id}` : null;
}

/** One file per shard: `run.json` → `run-s2of4.json`, so shards never overwrite each other. */
export function runFilePath(file: string, shard: Shard): string {
  if (!shard || shard.total <= 1) return file;
  const ext = path.extname(file);
  return `${file.slice(0, file.length - ext.length)}-s${shard.current}of${shard.total}${ext}`;
}

/**
 * Writes the `canary.run/1` file when `runFile` and a complete scope are set
 * (#1151). Its failure is a warning, never an exception: it must not cost the push.
 */
export function emitRunFile(
  cfg: { runFile: string | null; scope: { id: string; env: string } | null },
  payload: IngestPayload,
  shard: Shard,
  fullResultStatus: string | undefined,
): void {
  const { runFile, scope } = cfg;
  if (!runFile || !scope) return;
  try {
    const file = runFilePath(runFile, shard);
    const record = toRunRecord(payload, { scope, shard, fullResultStatus, env: process.env, version: packageVersion() });
    writeRunFile(file, record);
    log(`wrote canary.run/1 to ${file}.`);
  } catch (err) {
    warn(`canary.run/1 not written — ${errText(err)}`);
  }
}

function writeRunFile(file: string, record: ReturnType<typeof toRunRecord>): void {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(record, null, 2) + "\n", "utf8");
}

/** This package's version, for `producer.version`. */
function packageVersion(): string {
  try {
    return (require("../../../package.json") as { version: string }).version;
  } catch {
    return "unknown";
  }
}
