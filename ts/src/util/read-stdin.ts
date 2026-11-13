/**
 * Read all of stdin, waiting for a payload that has not arrived yet (#1617).
 *
 * Why not `readFileSync(0)`: once anything touches `process.stdin` (commander
 * imports `node:process`, which is enough), a piped stdin socket is in
 * O_NONBLOCK mode. A read issued before the writer has written then throws
 * EAGAIN instead of waiting, and callers that read that throw as "no input"
 * silently ran on nothing. This loop retries EAGAIN with a short sleep, so it
 * behaves like a blocking read: it returns at EOF and never earlier.
 *
 * No deadline, on purpose: a blocking read has none either, and a reader that
 * gives up early is exactly the defect. Same shape as harness's
 * `read-hook-stdin.js`, minus its 5 s cutoff, which suits a hook but not a
 * CLI fed by a slow producer such as `gh pr diff`.
 */
import { readSync } from 'node:fs';

/** Read up to `buf.length` bytes from `fd` into `buf`; 0 means EOF. */
export type ReadChunk = (fd: number, buf: Buffer) => number;

const CHUNK_BYTES = 64 * 1024;
const EAGAIN_BACKOFF_MS = 5;

const readChunk: ReadChunk = (fd, buf) =>
  readSync(fd, buf, 0, buf.length, null);

/** Sleep without spinning the CPU. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Stdin as UTF-8, read to EOF. Errors other than EAGAIN are rethrown so each
 * caller keeps its own policy for an unreadable stdin. `read` and `wait` are
 * seams for tests.
 */
export function readStdinToEof(
  read: ReadChunk = readChunk,
  wait: (ms: number) => void = sleepSync,
): string {
  const chunks: Buffer[] = [];
  const buf = Buffer.alloc(CHUNK_BYTES);
  for (;;) {
    let bytes: number;
    try {
      bytes = read(0, buf);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EAGAIN') {
        wait(EAGAIN_BACKOFF_MS);
        continue;
      }
      // Some platforms report a closed tty as an EOF error, not a 0-byte read.
      if (code === 'EOF') break;
      throw err;
    }
    if (bytes === 0) break;
    chunks.push(Buffer.from(buf.subarray(0, bytes)));
  }
  return Buffer.concat(chunks).toString('utf-8');
}
