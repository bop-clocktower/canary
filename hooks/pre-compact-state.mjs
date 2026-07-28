#!/usr/bin/env node
// pre-compact-state.mjs — PreCompact:* hook
// Saves a brief session summary before context compaction.
// Writes to .harness/state/pre-compact-summary.json.
// Fail-open: always exits 0.
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { harnessHookPresent } from './_harness_dedup.mjs';

function readJsonSafe(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

function findActiveSession(sessionsDir) {
  try {
    let latest = null;
    let latestMtime = 0;
    for (const entry of readdirSync(sessionsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const statePath = join(sessionsDir, entry.name, 'autopilot-state.json');
      try {
        const mtime = statSync(statePath).mtimeMs;
        if (mtime > latestMtime) {
          latestMtime = mtime;
          latest = { dir: entry.name, state: readJsonSafe(statePath) };
        }
      } catch {
        // no autopilot-state.json in this session dir
      }
    }
    return latest;
  } catch {
    return null;
  }
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf-8');
}

async function main() {
  // Dedup: harness's pre-compact-state.js writes the same summary to the same
  // path. When it is wired, defer so only one writer runs (see #309).
  if (harnessHookPresent('pre-compact-state.js')) process.exit(0);

  let raw;
  try {
    raw = await readStdin();
  } catch {
    process.exit(0);
  }
  if (!raw.trim()) {
    process.stderr.write(
      '[pre-compact-state] Empty stdin — allowing (fail-open)\n',
    );
    process.exit(0);
  }
  try {
    JSON.parse(raw);
  } catch {
    process.stderr.write(
      '[pre-compact-state] Could not parse stdin — allowing (fail-open)\n',
    );
    process.exit(0);
  }

  try {
    const cwd = process.cwd();
    const harnessDir = join(cwd, '.harness');
    const stateDir = join(harnessDir, 'state');
    mkdirSync(stateDir, { recursive: true });

    const state = readJsonSafe(join(harnessDir, 'state.json')) ?? {};
    const session = findActiveSession(join(harnessDir, 'sessions'));

    const summary = {
      timestamp: new Date().toISOString(),
      sessionId: session ? session.dir : null,
      activeStream: session
        ? ((session.state || {}).currentState ?? null)
        : null,
      recentDecisions: (state.decisions ?? []).slice(-5),
      openQuestions: state.blockers ?? [],
      currentPhase: (state.position || {}).phase ?? null,
    };

    const outPath = join(stateDir, 'pre-compact-summary.json');
    writeFileSync(outPath, JSON.stringify(summary, null, 2) + '\n');

    process.stderr.write('[pre-compact-state] Saved pre-compact summary\n');
    process.exit(0);
  } catch (e) {
    process.stderr.write(`[pre-compact-state] Failed: ${e.message}\n`);
    process.exit(0);
  }
}

main();
