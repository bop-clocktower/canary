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
// Everything else passes through, so `--json` and `--no-create` work as
// documented upstream. `--apply` additionally requires
// `--i-know-this-rewrites-bodies`, because a patch replaces issue bodies and
// upstream offers no way to turn that off (see below).
//
//   node scripts/roadmap-sync.mjs                  # dry run (the default)
//   node scripts/roadmap-sync.mjs --apply --i-know-this-rewrites-bodies
//
// Exit codes are forwarded unchanged, including 3 = ZERO DENOMINATOR (examined
// nothing — an abstention, never a pass). Refusing `--apply` exits 2.
import { spawnSync } from 'node:child_process';

const REQUIRED_FLAG = '--no-state-change';
const OVERRIDE_FLAG = '--i-know-this-rewrites-bodies';
const passthrough = process.argv.slice(2);

// The create hazard is gone — every row carries an External-ID as of #601-#619,
// so `--apply` files nothing new. What remains is worse and has no upstream
// flag: updateTicket sets `patch.body` from the row's Summary, so a patch
// REPLACES an issue's body with one roadmap paragraph. All 38 rows are linked,
// so a bare `--apply` flattens 38 issue bodies — the evidence in #486, the
// design notes in #591-#594, the provenance in #601-#619. `--no-state-change`
// covers open/closed only, and there is no `--no-patch`.
//
// A warning was not enough: a warning that scrolls past is indistinguishable
// from one nobody read, and the loss here is other people's writing. So
// `--apply` is gated behind a flag that cannot be typed by accident. It is a
// speed bump, not a prohibition — pushing the roadmap over the tracker is a
// legitimate thing to decide, once it is decided rather than defaulted into.
if (passthrough.includes('--apply') && !passthrough.includes(OVERRIDE_FLAG)) {
  console.error(
    `x Refusing --apply without ${OVERRIDE_FLAG}.\n` +
      '\n' +
      '  --apply patches every linked issue, and a patch REPLACES the issue\n' +
      '  body with the roadmap row summary. 38 rows are linked, so this would\n' +
      '  overwrite 38 hand-written bodies (#486, #591-#594, #601-#619).\n' +
      '  Upstream has no flag to disable the body push.\n' +
      '\n' +
      `  If the roadmap really should win, re-run with ${OVERRIDE_FLAG}.\n` +
      '  See bop-clocktower/canary#595.',
  );
  process.exit(2);
}

// Stripped, not forwarded — upstream would reject an unknown option.
const forwarded = passthrough.filter((arg) => arg !== OVERRIDE_FLAG);

// Appending REQUIRED_FLAG unconditionally is safe: it is idempotent, and
// commander offers no inverse that could turn state-change back on.
const args = ['roadmap', 'sync', REQUIRED_FLAG, ...forwarded];

// HARNESS_BIN lets the contract tests drive a stub offline. Unset in real use,
// where the command resolves through npx exactly as before.
const bin = process.env.HARNESS_BIN;
const result = bin
  ? spawnSync(bin, args, { stdio: 'inherit' })
  : spawnSync('npx', ['harness', ...args], { stdio: 'inherit' });

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
