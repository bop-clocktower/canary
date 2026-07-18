#!/usr/bin/env node
/* global setTimeout, fetch, AbortSignal */
// telemetry-reporter.js — Stop:* hook
// Reads adoption.jsonl, resolves consent, sends telemetry events to PostHog,
// and shows a one-time first-run privacy notice.
// Exit codes: 0 = allow, unconditionally — this is a log-only hook that must
// not stop the session teardown, by design (see rationale below).
//
// This hook sends to a third-party analytics endpoint over the network,
// which is inherently flaky (DNS, connectivity, PostHog outages) and has
// nothing to do with code quality or correctness. Halting the agent from
// stopping just because PostHog was unreachable would be actively harmful
// UX, so this stays a fail-open, log-only hook rather than a gate. What WAS
// a real bug — fixed here — is that a failed send used to be silently
// swallowed: the hook printed a false "Sent N events" success message and
// advanced the cursor anyway, permanently losing those records. It now
// reports send failures loudly on stderr and only advances the cursor after
// a confirmed successful send, so failed batches are retried on the next
// run instead of silently dropped.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import process from 'node:process';

// PostHog project API key — public, write-only (cannot read data)
const POSTHOG_API_KEY = process.env.POSTHOG_API_KEY ?? 'phc_wNTdCMcfJXZPgdNeDociZW6vwoGGo4nb7vqEfWThFfsG'; // harness-ignore SEC-SEC-002: public PostHog write-only ingest key
const POSTHOG_BATCH_URL = 'https://app.posthog.com/batch';
const MAX_ATTEMPTS = 3;
const TIMEOUT_MS = 5000;

const FIRST_RUN_NOTICE = `Harness collects anonymous usage analytics to improve the tool.
No personal information is sent. Disable with:
  DO_NOT_TRACK=1  or  harness.config.json \u2192 telemetry.enabled: false\n`;

// --- Helpers ---

function readJsonSafe(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Consent ---

function resolveConsent(cwd) {
  if (process.env.DO_NOT_TRACK === '1') return { allowed: false };
  if (process.env.HARNESS_TELEMETRY_OPTOUT === '1') return { allowed: false };

  const config = readJsonSafe(join(cwd, 'harness.config.json'));
  if (config?.telemetry?.enabled === false) return { allowed: false };

  const installId = getOrCreateInstallId(cwd);

  const identityFile = readJsonSafe(join(cwd, '.harness', 'telemetry.json'));
  const identity = {};
  if (identityFile?.identity) {
    if (typeof identityFile.identity.project === 'string') identity.project = identityFile.identity.project;
    if (typeof identityFile.identity.team === 'string') identity.team = identityFile.identity.team;
    if (typeof identityFile.identity.alias === 'string') identity.alias = identityFile.identity.alias;
  }

  // Fallback: project name from harness.config.json
  if (!identity.project && typeof config?.name === 'string') {
    identity.project = config.name;
  }

  // Fallback: alias from git config user.name
  if (!identity.alias) {
    try {
      const gitName = execFileSync('git', ['config', 'user.name'], {
        cwd,
        encoding: 'utf-8',
        timeout: 2000,
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      if (gitName) identity.alias = gitName;
    } catch {
      // Git not available or no user.name set
    }
  }

  return { allowed: true, installId, identity };
}

// --- Install ID ---

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function getOrCreateInstallId(cwd) {
  const harnessDir = join(cwd, '.harness');
  const installIdFile = join(harnessDir, '.install-id');

  try {
    const existing = readFileSync(installIdFile, 'utf-8').trim();
    if (UUID_V4_RE.test(existing)) return existing;
  } catch {
    // File does not exist
  }

  const id = randomUUID();
  mkdirSync(harnessDir, { recursive: true });
  writeFileSync(installIdFile, id, { encoding: 'utf-8', mode: 0o600 });
  return id;
}

// --- Cursor ---

const TELEMETRY_CURSOR_FILE = '.telemetry-cursor';

function readCursor(cwd) {
  try {
    const data = JSON.parse(readFileSync(join(cwd, '.harness', 'metrics', TELEMETRY_CURSOR_FILE), 'utf-8'));
    return typeof data.offset === 'number' ? data.offset : 0;
  } catch {
    return 0;
  }
}

function writeCursor(cwd, offset) {
  const metricsDir = join(cwd, '.harness', 'metrics');
  mkdirSync(metricsDir, { recursive: true });
  writeFileSync(join(metricsDir, TELEMETRY_CURSOR_FILE), JSON.stringify({ offset }) + '\n');
}

// --- Collector ---

function readNewAdoptionRecords(cwd) {
  const adoptionFile = join(cwd, '.harness', 'metrics', 'adoption.jsonl');
  let raw;
  try {
    raw = readFileSync(adoptionFile, 'utf-8');
  } catch {
    return { records: [], newOffset: 0 };
  }

  const cursor = readCursor(cwd);
  // If file shrank (was manually reset), reprocess from start
  const effectiveCursor = cursor > raw.length ? 0 : cursor;
  const newContent = raw.slice(effectiveCursor);

  const records = [];
  for (const line of newContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (
        typeof parsed.skill === 'string' &&
        typeof parsed.startedAt === 'string' &&
        typeof parsed.duration === 'number' &&
        typeof parsed.outcome === 'string' &&
        Array.isArray(parsed.phasesReached)
      ) {
        records.push(parsed);
      }
    } catch {
      // Skip malformed lines
    }
  }
  return { records, newOffset: raw.length };
}

function collectEvents(cwd, records, consent) {
  if (records.length === 0) return [];

  const { installId, identity } = consent;
  const distinctId = identity.alias ?? installId;

  return records.map((record) => ({
    event: 'skill_invocation',
    distinct_id: distinctId,
    timestamp: record.startedAt,
    properties: {
      installId,
      os: process.platform,
      nodeVersion: process.version,
      harnessVersion: readHarnessVersion(cwd),
      skillName: record.skill,
      duration: record.duration,
      outcome: record.outcome === 'completed' ? 'success' : 'failure',
      phasesReached: record.phasesReached,
      ...(identity.project ? { project: identity.project } : {}),
      ...(identity.team ? { team: identity.team } : {}),
    },
  }));
}

function readHarnessVersion(cwd) {
  try {
    const pkg = readJsonSafe(join(cwd, 'node_modules', '@harness-engineering', 'core', 'package.json'));
    return pkg?.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

// --- Transport ---

/**
 * POST the batch to PostHog, retrying transient failures.
 *
 * This is a best-effort, network-dependent send to a third-party service —
 * genuinely flaky by nature (DNS, connectivity, PostHog outages), and this
 * hook must never block session teardown on it (see main()). What it CAN
 * control is honesty: the caller needs to know whether delivery actually
 * succeeded so it never claims "Sent N events" after a silent failure.
 *
 * @returns {Promise<{ ok: boolean, reason?: string }>}
 */
async function sendEvents(events) {
  if (events.length === 0) return { ok: true };

  const payload = JSON.stringify({ api_key: POSTHOG_API_KEY, batch: events });
  let lastReason = 'unknown';

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(POSTHOG_BATCH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.ok) return { ok: true };
      if (res.status < 500) {
        // 4xx = permanent, do not retry.
        return { ok: false, reason: `PostHog rejected batch (HTTP ${res.status})` };
      }
      lastReason = `PostHog returned HTTP ${res.status}`;
    } catch (err) {
      // Network error or timeout — retry.
      lastReason = err?.message ?? 'network error';
    }
    if (attempt < MAX_ATTEMPTS - 1) {
      await sleep(1000 * (attempt + 1));
    }
  }
  return { ok: false, reason: `all ${MAX_ATTEMPTS} attempts failed (${lastReason})` };
}

// --- First-run notice ---

function showFirstRunNotice(cwd) {
  const flagFile = join(cwd, '.harness', '.telemetry-notice-shown');
  if (existsSync(flagFile)) return;

  process.stderr.write(FIRST_RUN_NOTICE);

  try {
    mkdirSync(join(cwd, '.harness'), { recursive: true });
    writeFileSync(flagFile, new Date().toISOString(), { encoding: 'utf-8' });
  } catch {
    // Non-fatal — notice will show again next time
  }
}

// --- Main ---

async function main() {
  let raw = '';
  try {
    raw = readFileSync(0, 'utf-8');
  } catch {
    process.exit(0);
  }

  if (!raw.trim()) {
    process.exit(0);
  }

  // Parse stdin (stop hook receives session JSON)
  try {
    JSON.parse(raw);
  } catch {
    process.stderr.write('[telemetry-reporter] Could not parse stdin — skipping\n');
    process.exit(0);
  }

  try {
    const cwd = process.cwd();
    const consent = resolveConsent(cwd);

    if (!consent.allowed) {
      process.exit(0);
    }

    // Show first-run notice (before sending, so user sees it even if send fails)
    showFirstRunNotice(cwd);

    const { records, newOffset } = readNewAdoptionRecords(cwd);
    const events = collectEvents(cwd, records, consent);
    if (events.length === 0) {
      process.stderr.write('[telemetry-reporter] No new adoption records to report\n');
      process.exit(0);
    }

    const result = await sendEvents(events);

    if (!result.ok) {
      // Loud, honest failure signal instead of a silent pass. Still exits 0:
      // this is a best-effort send to a third-party analytics endpoint, and
      // blocking session teardown on PostHog being unreachable would be
      // strictly worse than just telling the user delivery failed. The
      // cursor is NOT advanced, so these records are retried next run.
      process.stderr.write(
        `[telemetry-reporter] WARNING: failed to send ${events.length} telemetry event(s): ${result.reason}\n`
      );
      process.exit(0);
    }

    // Advance cursor past sent records (adoption.jsonl is preserved for CLI reads)
    writeCursor(cwd, newOffset);

    process.stderr.write(`[telemetry-reporter] Sent ${events.length} telemetry event(s)\n`);
    process.exit(0);
  } catch (err) {
    process.stderr.write(`[telemetry-reporter] Failed: ${err.message}\n`);
    process.exit(0);
  }
}

main();
