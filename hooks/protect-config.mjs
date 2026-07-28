#!/usr/bin/env node
// protect-config.mjs — PreToolUse:Write/Edit hook
// Blocks modifications to Python project config files.
// Fail-open: parse errors and unexpected exceptions log to stderr and exit 0.
// Exit codes: 0 = allow, 2 = block
import { basename } from 'node:path';

import { harnessHookPresent } from './_harness_dedup.mjs';

const PROTECTED_PATTERNS = [
  /^pyproject\.toml$/,
  /^setup\.cfg$/,
  /^setup\.py$/,
  /^\.ruff\.toml$/,
  /^ruff\.toml$/,
  /^\.flake8$/,
  /^mypy\.ini$/,
  /^\.mypy\.ini$/,
  /^tox\.ini$/,
];

// Patterns harness's protect-config.js already guards. When that hook is wired
// we cede these to it and enforce only the Python-unique configs, so ruff.toml
// edits aren't double-blocked (see #309).
const HARNESS_COVERED = new Set(['^\\.ruff\\.toml$', '^ruff\\.toml$']);

function effectivePatterns() {
  if (harnessHookPresent('protect-config.js')) {
    return PROTECTED_PATTERNS.filter((p) => !HARNESS_COVERED.has(p.source));
  }
  return PROTECTED_PATTERNS;
}

function isProtected(filePath, patterns = PROTECTED_PATTERNS) {
  const base = basename(filePath);
  return patterns.some((p) => p.test(base));
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf-8');
}

async function main() {
  let raw;
  try {
    raw = await readStdin();
  } catch {
    process.stderr.write(
      '[protect-config] Could not read stdin — allowing (fail-open)\n',
    );
    process.exit(0);
  }
  if (!raw.trim()) {
    process.stderr.write(
      '[protect-config] Empty stdin — allowing (fail-open)\n',
    );
    process.exit(0);
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    process.stderr.write(
      '[protect-config] Could not parse stdin JSON — allowing (fail-open)\n',
    );
    process.exit(0);
  }

  try {
    const filePath = data?.tool_input?.file_path ?? '';
    if (typeof filePath !== 'string' || !filePath) {
      process.stderr.write(
        '[protect-config] Missing file_path in tool input — allowing (fail-open)\n',
      );
      process.exit(0);
    }

    if (isProtected(filePath, effectivePatterns())) {
      process.stderr.write(
        `BLOCKED: Modification to protected config file: ${basename(filePath)}. ` +
          'Project config files must not be weakened.\n',
      );
      process.exit(2);
    }
    process.exit(0);
  } catch {
    process.stderr.write(
      '[protect-config] Unexpected error — allowing (fail-open)\n',
    );
    process.exit(0);
  }
}

main();
