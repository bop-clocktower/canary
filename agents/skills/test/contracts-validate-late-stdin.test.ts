/**
 * validate.mjs must wait for a stdin payload that arrives late (#1617).
 *
 * The CLI imports `node:process`, which leaves a piped stdin socket in
 * O_NONBLOCK mode, so `readFileSync(0)` issued before the parent wrote threw
 * EAGAIN. readInput() reports a failed read as a usage error, so a valid
 * document piped by a slow producer was refused with exit 2. The payload is
 * written after node startup here to make that arrival order deterministic.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', 'lib', 'contracts', 'validate.mjs');
const RUN = path.join(HERE, 'fixtures', 'contracts', 'run.valid.json');
const LATE_MS = 300;

function runLate(args: string[], payload: string) {
  return new Promise<{ status: number | null; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(process.execPath, [CLI, ...args]);
      let stderr = '';
      child.stdout.resume();
      child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
      // A reader that already gave up closes its end; the status says so.
      child.stdin.on('error', () => undefined);
      child.on('error', reject);
      const timer = setTimeout(() => child.stdin.end(payload), LATE_MS);
      child.on('close', (status) => {
        clearTimeout(timer);
        resolve({ status, stderr });
      });
    },
  );
}

describe('validate.mjs with a late stdin payload', () => {
  it('validates the document instead of refusing the read', async () => {
    const r = await runLate(['-'], fs.readFileSync(RUN, 'utf8'));
    expect(r.stderr).not.toMatch(/EAGAIN/);
    expect(r.status).toBe(0);
  });
});
