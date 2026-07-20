#!/usr/bin/env node
'use strict';

const { execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const { isTsCommand, route } = require('../dist/router.js');

function getBinaryPath(platform) {
  const name = platform === 'win32' ? 'canary.exe' : 'canary';
  return path.join(__dirname, name);
}

/**
 * Forward a command to the bundled Python binary. Returns the exit code
 * (0 on success, the binary's status on failure, 1 when the binary is missing).
 * Dependencies are injectable for testing.
 */
function forwardToBinary(
  argv,
  {
    execFile = execFileSync,
    existsSync = fs.existsSync,
    platform = process.platform,
    stderr = process.stderr,
  } = {},
) {
  const binaryPath = getBinaryPath(platform);
  if (!existsSync(binaryPath)) {
    stderr.write(
      `canary binary not found at ${binaryPath}.\n` +
        `Try reinstalling: npm install -g canary-test-cli\n`,
    );
    return 1;
  }
  try {
    execFile(binaryPath, argv, { stdio: 'inherit' });
    return 0;
  } catch (err) {
    return err.status ?? 1;
  }
}

/**
 * Dispatch one invocation: TS-handled commands (e.g. `overlay`, `doctor`) go to
 * the router; everything else forwards verbatim to the Python binary. Returns
 * the process exit code, or a Promise of one for async commands (`doctor`).
 */
function run(argv, deps = {}) {
  if (isTsCommand(argv)) {
    return route(argv, deps) ?? 0;
  }
  return forwardToBinary(argv, deps);
}

function main() {
  // `run` may return a number (sync commands) or a Promise<number> (doctor).
  Promise.resolve(run(process.argv.slice(2))).then((code) =>
    process.exit(code),
  );
}

module.exports = { getBinaryPath, forwardToBinary, run };
if (require.main === module) main();
