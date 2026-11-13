// Read all of stdin, waiting for a payload that has not arrived yet (#1617).
//
// `readFileSync(0)` does not wait. Once anything touches `process.stdin` (an
// `import process from 'node:process'` is enough), a piped stdin socket is in
// O_NONBLOCK mode, and a read issued before the writer has written throws
// EAGAIN. Callers that read that throw as "no input" ran on nothing. This loop
// retries EAGAIN with a short sleep, so it returns at EOF and never earlier,
// like a blocking read. No deadline, for the same reason a blocking read has
// none. Same helper as ts/src/util/read-stdin.ts; kept separate because this
// lib is vendored into consumer repos and takes no dependency on ts/.

import { Buffer } from 'node:buffer';
import { readSync } from 'node:fs';

const CHUNK_BYTES = 64 * 1024;
const EAGAIN_BACKOFF_MS = 5;

/** @type {(fd: number, buf: Buffer) => number} */
const readChunk = (fd, buf) => readSync(fd, buf, 0, buf.length, null);

/** @param {number} ms */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Stdin as UTF-8, read to EOF. Errors other than EAGAIN are rethrown so the
 * caller keeps its own policy for an unreadable stdin.
 *
 * @param {(fd: number, buf: Buffer) => number} [read] test seam: 0 means EOF
 * @param {(ms: number) => void} [wait] test seam for the EAGAIN backoff
 * @returns {string}
 */
export function readStdinToEof(read = readChunk, wait = sleepSync) {
  const chunks = [];
  const buf = Buffer.alloc(CHUNK_BYTES);
  for (;;) {
    let bytes;
    try {
      bytes = read(0, buf);
    } catch (err) {
      const code = /** @type {{ code?: string }} */ (err).code;
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
  return Buffer.concat(chunks).toString('utf8');
}
