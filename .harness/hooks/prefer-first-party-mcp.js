#!/usr/bin/env node
/* global console */
// prefer-first-party-mcp.js — PreToolUse:mcp__.* hook
//
// Non-blocking nudge: when a THIRD-PARTY MCP tool is about to run, inject a
// short reminder (via hookSpecificOutput.additionalContext, which reaches the
// model on its next request) to check for a first-party equivalent first —
// harness for anything, canary for testing — per AGENTS.md "Trusted MCP
// hierarchy". First-party bundle calls pass silently.
//
// Deliberately emits ONLY additionalContext — no permissionDecision. Setting
// "allow" would auto-approve the very calls we want to discourage (bypassing
// the normal permission prompt); we want to bias judgment, not open the gate.
//
// Fail-open by design: any unreadable/unparseable stdin or unexpected error
// exits 0 silently. A reminder hook must never break or block a tool call.
// Exit codes: always 0 (advisory only).

import { readFileSync } from 'node:fs';
import process from 'node:process';

// First-party trusted MCP prefixes: the harness server plus the canary MCP
// bundle (canary, context7, playwright) and the local IDE bridge. Anything
// else under mcp__ is third-party and earns the reminder.
const TRUSTED_PREFIXES = [
  'mcp__harness__',
  'mcp__plugin_mcp-bundle_canary__',
  'mcp__plugin_mcp-bundle_context7__',
  'mcp__playwright__',
  'mcp__ide__',
];

const REMINDER =
  'Tool-selection reminder (AGENTS.md "Trusted MCP hierarchy"): you are about ' +
  'to call a third-party MCP tool. Before proceeding, confirm no first-party ' +
  'equivalent fits — harness first (mcp__harness__* or a harness skill), and ' +
  'for anything test-related, canary (the canary MCP bundle or a canary-* ' +
  'skill). Use the third-party MCP only when no first-party option covers the ' +
  'task.';

function main() {
  let input;
  try {
    input = JSON.parse(readFileSync(0, 'utf-8'));
  } catch {
    process.exit(0); // no/!JSON stdin — nothing to advise on
  }

  const toolName = input?.tool_name ?? '';

  // Defensive: the matcher scopes this to mcp__.*, but never advise on a
  // non-MCP or already-trusted tool.
  if (!toolName.startsWith('mcp__')) process.exit(0);
  if (TRUSTED_PREFIXES.some((p) => toolName.startsWith(p))) process.exit(0);

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: REMINDER,
      },
    })
  );
  process.exit(0);
}

try {
  main();
} catch {
  process.exit(0); // fail-open — never break a tool call over a reminder
}
