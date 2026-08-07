#!/usr/bin/env node
// The only sanctioned way to run `harness roadmap sync` in this repo (#595).
//
// Always appends `--no-state-change`. That flag is upstream's CI-safe mode:
// planning fields and labels converge, but no issue's open/closed state is
// patched. Without it, `statusMap` maps a roadmap row of `done` to a CLOSED
// issue — so a hand-edited row that drifts ahead of reality acquires the
// authority to close someone's open bug, and `reverseStatusMap` reopens one in
// the other direction. Closure belongs to the PR-merge auto-done path, which is
// tied to work actually landing.
//
// The requirement is enforced, not remembered: ts/test/roadmap-sync-guard.test.ts
// fails on any executable surface that invokes the command without the flag.
//
// Everything else passes through, so `--apply`, `--json`, and `--no-create` all
// work as documented upstream.
//
//   node scripts/roadmap-sync.mjs                  # dry run (the default)
//   node scripts/roadmap-sync.mjs --apply --no-create
//
// Exit codes are forwarded unchanged, including 3 = ZERO DENOMINATOR (examined
// nothing — an abstention, never a pass).
import { spawnSync } from 'node:child_process';

const REQUIRED_FLAG = '--no-state-change';
const passthrough = process.argv.slice(2);

// Appending unconditionally is safe: the flag is idempotent, and commander
// offers no inverse that could turn state-change back on.
const args = ['harness', 'roadmap', 'sync', REQUIRED_FLAG, ...passthrough];

// Not an error — `--apply` without `--no-create` is legitimate once the unlinked
// rows in #595 are resolved. Until then it would file an issue per row lacking
// an External-ID, several of which describe already-shipped work.
if (passthrough.includes('--apply') && !passthrough.includes('--no-create')) {
  console.warn(
    '! --apply without --no-create: rows lacking an External-ID each get a NEW\n' +
      '  tracker issue. As of 2026-08-07 that is 29 rows, mostly done/shipped\n' +
      '  work. See bop-clocktower/canary#595 before proceeding.',
  );
}

const result = spawnSync('npx', args, { stdio: 'inherit' });

if (result.error) {
  console.error(`x failed to run harness: ${result.error.message}`);
  process.exit(2);
}

// A signal death has no exit code; report it as an error rather than as 0.
if (result.status === null) {
  console.error(`x harness terminated by signal ${result.signal}`);
  process.exit(2);
}

process.exit(result.status);
