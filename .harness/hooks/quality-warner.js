#!/usr/bin/env node
// quality-warner.js — PostToolUse:Edit/Write hook (standard profile)
// Runs the project formatter/linter after edits.
// Blocks (exit 2) on real formatter/linter violations; fails open (exit 0)
// when the tool couldn't run at all (missing binary, timeout, usage error).
// Exit codes: 0 = allow, 2 = block
//
// format-check.js is the shared detection core (also usable by any future
// blocking-only entrypoint). It never calls process.exit itself — it returns
// a `status` of 'clean' | 'violations' | 'infra-error' and leaves the
// exit-code policy to the caller. 'violations' means the formatter actually
// spawned and reported real problems (deterministic, reliable — safe to
// block on). 'infra-error' means the tool is absent/misconfigured/timed out
// (ambiguous — stays fail-open so a broken toolchain can't wall off an
// edit).

import process from 'node:process';
import { runFormatCheck, readHookInput } from './format-check.js';

function main() {
  const input = readHookInput(0);
  if (!input) {
    process.exit(0);
  }

  try {
    const result = runFormatCheck(input, process.cwd());
    if (result.status === 'violations') {
      process.stderr.write(`[quality-warner] BLOCKED: ${result.message}\n`);
      process.exit(2);
    }
    if (result.status === 'infra-error') {
      process.stderr.write(`[quality-warner] ${result.message}\n`);
    }
    process.exit(0);
  } catch {
    // Unexpected error — fail open.
    process.exit(0);
  }
}

main();
