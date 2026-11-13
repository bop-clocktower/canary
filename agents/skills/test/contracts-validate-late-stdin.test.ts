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

import { readStdinToEof } from '../lib/read-stdin.mjs';

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

describe('readStdinToEof (lib)', () => {
  const eagain = Object.assign(new Error('not ready'), { code: 'EAGAIN' });

  it('retries EAGAIN and concatenates chunks to EOF', () => {
    const steps: Array<string | Error> = [eagain, 'ab', eagain, 'c', ''];
    let waits = 0;
    const text = readStdinToEof(
      (_fd: number, buf: Buffer) => {
        const step = steps.shift() ?? '';
        if (step instanceof Error) throw step;
        return buf.write(step);
      },
      () => void waits++,
    );
    expect(text).toBe('abc');
    expect(waits).toBe(2);
  });

  it('rethrows a non-EAGAIN error', () => {
    const ebadf = Object.assign(new Error('bad fd'), { code: 'EBADF' });
    expect(() =>
      readStdinToEof(
        () => {
          throw ebadf;
        },
        () => undefined,
      ),
    ).toThrow('bad fd');
  });
});
