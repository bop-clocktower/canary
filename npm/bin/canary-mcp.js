#!/usr/bin/env node
'use strict';

// Console-script entry for `canary-mcp` (#507): starts the Canary MCP server
// over stdio from the bundled TypeScript engine (dist/engine/mcp-server.js,
// staged by scripts/build-engine.mjs). The engine bundle is ESM while this
// package is CommonJS, so the server module is loaded via dynamic import().
// stdout carries the JSON-RPC stream and must never be polluted -- every
// failure path writes to stderr only.

const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

/** Absolute path to the bundled engine's MCP server module. */
function getServerPath() {
  return path.join(__dirname, '..', 'dist', 'engine', 'mcp-server.js');
}

/**
 * Start the server. Returns the exit code (0 when runStdio resolves, 1 when
 * the bundle is missing). Dependencies are injectable for testing.
 */
async function main({
  serverPath = getServerPath(),
  existsSync = fs.existsSync,
  stderr = process.stderr,
} = {}) {
  if (!existsSync(serverPath)) {
    stderr.write(
      `canary MCP server not found at ${serverPath}.\n` +
        `The package looks incomplete; try reinstalling: npm install -g canary-test-cli\n`,
    );
    return 1;
  }
  const { runStdio } = await import(pathToFileURL(serverPath).href);
  await runStdio();
  return 0;
}

if (require.main === module) {
  main()
    .then((code) => {
      if (code !== 0) process.exit(code);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

module.exports = { getServerPath, main };
