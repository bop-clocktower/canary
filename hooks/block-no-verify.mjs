#!/usr/bin/env node
// block-no-verify.mjs — PreToolUse:Bash hook
// This hook exists to DETECT the bypass flag; every occurrence of the literal
// below is the detection pattern, not a bypass. Hence the SEC-AGT-006 waivers.
// harness-ignore SEC-AGT-006: definitional — this IS the detection pattern.
// Blocks git commands that use --no-verify to skip hooks.
// Exit codes: 0 = allow, 2 = block
import { harnessHookPresent } from './_harness_dedup.mjs';

function stripStringsAndComments(cmd) {
  let c = cmd;
  c = c.replace(/<<-?\s*['"]?(\w+)['"]?[\s\S]*?\n\s*\1\b/g, ' ');
  c = c.replace(/'[^']*'/g, ' ');
  c = c.replace(/"(?:[^"\\]|\\.)*"/g, ' ');
  c = c.replace(/(^|[\s;&|`(])#[^\n]*/g, '$1');
  return c;
}

function containsHookBypass(command) {
  const stripped = stripStringsAndComments(command);
  if (
    // harness-ignore SEC-AGT-006: definitional — the detection regex itself.
    /\bgit\s+(?:[\w-]+\s+)*?commit\b[^\n]*?--no-verify(?=\s|$)/.test(stripped)
  ) {
    return true;
  }
  if (
    /\bgit\s+(?:[\w-]+\s+)*?commit\b[^\n]*?(?:^|\s)-n(?=\s|$)/.test(stripped)
  ) {
    return true;
  }
  return false;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf-8');
}

async function main() {
  // Dedup: harness's block-no-verify.js enforces the identical policy. When it
  // is wired, defer to it so the bypass check runs exactly once (see #309).
  if (harnessHookPresent('block-no-verify.js')) process.exit(0);

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
    const command = data?.tool_input?.command ?? '';
    if (typeof command !== 'string') process.exit(0);

    if (containsHookBypass(command)) {
      process.stderr.write(
        // harness-ignore SEC-AGT-006: definitional — the block message text.
        'BLOCKED: --no-verify flag detected. Hooks must not be bypassed.\n',
      );
      process.exit(2);
    }
    process.exit(0);
  } catch {
    process.exit(0);
  }
}

main();
