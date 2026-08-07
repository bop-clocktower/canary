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

// The create hazard is gone — every row carries an External-ID as of #601-#619,
// so `--apply` files nothing new. What remains is worse and has no flag:
// updateTicket sets `patch.body = summary`, so a patch REPLACES an issue's body
// with the roadmap's one-paragraph summary. All 38 rows are linked, so an
// unguarded `--apply` overwrites 38 issue bodies — including the evidence in
// #486 and the design notes in #591-#594. `--no-state-change` does not cover it.
if (passthrough.includes('--apply')) {
  console.warn(
    '! --apply PATCHES every linked issue, and a patch REPLACES the issue body\n' +
      '  with the roadmap row summary. 38 rows are linked; hand-written bodies\n' +
      '  (#486, #591-#594, #601-#619) would be overwritten. There is no flag to\n' +
      '  disable the body push. See bop-clocktower/canary#595.',
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
