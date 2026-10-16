'use strict';
// Preload (`node --require <this> <bin> ...`) that makes stdout and stderr
// behave like an asynchronous pipe on any OS, then records what `process.exit`
// would have thrown away (#1284, #1356).
//
// On macOS and Windows a piped stdout is asynchronous: a write queues in libuv
// and completes later, and `process.exit` discards whatever is still queued.
// Linux pipes are synchronous, so a slow-reader repro is green on the ubuntu
// CI runners whether or not the bin drains. This probe moves the asynchrony
// into the process instead: every write completes on a later timer tick, and
// `process.exit` writes `{ pending, code }` to $CANARY_EXIT_PROBE_REPORT before
// exiting. `pending > 0` means the bin exited with output still in flight,
// which is exactly the truncation, asserted the same way on every platform.
//
// A bin that never calls `process.exit` writes no report: the pending timers
// keep the loop alive until every write lands, so nothing is lost.

const fs = require('node:fs');

const reportPath = process.env.CANARY_EXIT_PROBE_REPORT;
let pending = 0;

for (const stream of [process.stdout, process.stderr]) {
  const realWrite = stream.write.bind(stream);
  stream.write = function asyncPipeWrite(chunk, encoding, callback) {
    const done = typeof encoding === 'function' ? encoding : callback;
    pending += 1;
    // Same delay for every write, so timers fire in write order (FIFO), like
    // a pipe draining its queue.
    setTimeout(() => {
      pending -= 1;
      realWrite(chunk);
      if (typeof done === 'function') done();
    }, 5);
    return true;
  };
}

const realExit = process.exit.bind(process);
process.exit = function probedExit(code) {
  if (reportPath) {
    fs.writeFileSync(
      reportPath,
      JSON.stringify({ pending, code: code ?? process.exitCode ?? 0 }),
    );
  }
  return realExit(code);
};
