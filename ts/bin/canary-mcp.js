#!/usr/bin/env node
// Console-script entry point for `canary-mcp` (mirrors agent/mcp_server.py's
// main() -> mcp.run()). Starts the Canary MCP server over the stdio transport.
//
// This launcher imports the COMPILED server from ../dist, so run `npm run build`
// (tsc) before invoking it. Keeping the bin as plain .js keeps it outside tsc's
// rootDir (src/) while still shipping with the package.
import { runStdio } from '../dist/mcp-server.js';

runStdio().catch((err) => {
  // stderr only - stdout carries the JSON-RPC stream and must not be polluted.
  console.error(err);
  process.exit(1);
});
