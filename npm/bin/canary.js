#!/usr/bin/env node
"use strict";

const { execFileSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

function getBinaryPath(platform) {
  const name = platform === "win32" ? "canary.exe" : "canary";
  return path.join(__dirname, name);
}

function main() {
  const binaryPath = getBinaryPath(process.platform);
  if (!fs.existsSync(binaryPath)) {
    process.stderr.write(
      `canary binary not found at ${binaryPath}.\n` +
      `Try reinstalling: npm install -g canary-test-cli\n`
    );
    process.exit(1);
  }
  try {
    execFileSync(binaryPath, process.argv.slice(2), { stdio: "inherit" });
  } catch (err) {
    process.exit(err.status ?? 1);
  }
}

module.exports = { getBinaryPath };
if (require.main === module) main();
