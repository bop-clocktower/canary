#!/usr/bin/env node
// quality-gate.mjs — PostToolUse:Edit/Write hook
// Runs ruff check after Python file edits and warns on violations.
// Never blocks (always exits 0). Warnings go to stderr.
import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';

import { harnessHookPresent, ruffConfigPresent } from './_harness_dedup.mjs';

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf-8');
}

async function main() {
  // Dedup: harness's quality-warner.js (via format-check.js) also runs ruff —
  // but only when it detects a standalone .ruff.toml/ruff.toml. When both that
  // config and the harness hook are present, defer so ruff runs once. With ruff
  // configured in pyproject.toml (which format-check.js can't see), this hook is
  // the only Python linter, so it keeps running (see #309).
  if (harnessHookPresent('quality-warner.js') && ruffConfigPresent()) {
    process.exit(0);
  }

  let raw;
  try {
    raw = await readStdin();
  } catch {
    process.exit(0);
  }
  if (!raw.trim()) process.exit(0);

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  try {
    const filePath = data?.tool_input?.file_path ?? '';
    if (typeof filePath !== 'string' || !filePath) process.exit(0);
    if (!filePath.endsWith('.py')) process.exit(0);
    if (!existsSync(filePath) || !statSync(filePath).isFile()) process.exit(0);

    const result = spawnSync('ruff', ['check', filePath], {
      encoding: 'utf-8',
      timeout: 30_000,
    });
    // ruff not installed (ENOENT) or any spawn error → stay silent, exit 0.
    if (result.error) process.exit(0);

    if (result.status !== 0) {
      process.stderr.write(
        `[quality-gate] ruff found issues:\n${(result.stdout ?? '').slice(0, 500)}\n`,
      );
    } else {
      process.stderr.write('[quality-gate] ruff check passed\n');
    }
    process.exit(0);
  } catch {
    process.exit(0);
  }
}

main();
