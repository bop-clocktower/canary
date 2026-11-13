/**
 * prefer-first-party-mcp.js must read its stdin payload to EOF (#1611).
 *
 * Root cause of the #1611 `spawnSync ... EPIPE` flake: the hook read stdin
 * with `readFileSync(0)`. The stdin a Node parent hands a child is a socket
 * that can be in O_NONBLOCK mode, so when the payload has not arrived yet
 * the read throws EAGAIN instead of waiting. The hook's fail-open `catch`
 * then exited 0 with no output, and the parent's still-pending write hit the
 * closed socket: EPIPE. Under full-suite load the parent's write lands late
 * often enough to show up as a flake.
 *
 * The EPIPE was the loud half. The quiet half was worse: a hook that bailed
 * before reading still exited 0 with empty stdout, which is exactly what the
 * "not nagged" assertions check for, so those tests could pass without the
 * hook ever seeing its input — and in real use a third-party MCP call whose
 * payload arrived late silently lost its reminder.
 *
 * These tests make the late arrival deterministic instead of hoping for load:
 * the payload is sent in two halves, and the second half is held back until
 * the hook has either exited (the bug) or had a generous window to do so.
 */

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HOOK = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '.harness',
  'hooks',
  'prefer-first-party-mcp.js',
);

/** How long the second half is held back while we watch for an early exit. */
const HOLD_MS = 1000;

interface SlowRun {
  /** True when the hook exited before the payload was complete. */
  exitedEarly: boolean;
  status: number | null;
  stdout: string;
  /** Error raised writing the held-back half, e.g. EPIPE. */
  stdinError: string;
}

function runWithLatePayload(toolName: string): Promise<SlowRun> {
  const payload = JSON.stringify({ tool_name: toolName });
  const half = Math.floor(payload.length / 2);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK]);
    let stdout = '';
    let stdinError = '';
    child.stdout.setEncoding('utf-8');
    child.stdout.on('data', (d: string) => (stdout += d));
    child.stdin.on('error', (e: NodeJS.ErrnoException) => {
      stdinError = String(e.code);
    });
    child.stdin.write(payload.slice(0, half));
    const timer = setTimeout(
      () => child.stdin.end(payload.slice(half)),
      HOLD_MS,
    );
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({
        // The second half is only ever sent by the timer, so a hook that
        // closed while stdin was still open quit on a partial payload.
        exitedEarly: !child.stdin.writableEnded,
        status,
        stdout,
        stdinError,
      });
    });
  });
}

describe('prefer-first-party-mcp reads stdin to EOF (#1611)', () => {
  it('a third-party call whose payload arrives late is still nagged', async () => {
    const r = await runWithLatePayload('mcp__slack__send_message');
    expect(r.exitedEarly).toBe(false);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('additionalContext');
  });

  it('a trusted call whose payload arrives late consumes it all, silently', async () => {
    const r = await runWithLatePayload('mcp__canary-mcp__write_test_file');
    expect(r.exitedEarly).toBe(false);
    expect(r.stdinError).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('');
  });
});
