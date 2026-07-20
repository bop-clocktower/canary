#!/usr/bin/env node
'use strict';

const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');

const SUPPORTED = {
  'linux-x64': true,
  'darwin-arm64': true,
  'win32-x64': true,
};

function getPlatformKey(platform, arch) {
  const key = `${platform}-${arch}`;
  if (!SUPPORTED[key]) {
    throw new Error(
      `Unsupported platform: ${key}. Supported: ${Object.keys(SUPPORTED).join(', ')}`,
    );
  }
  return key;
}

function getBinaryName(platformKey) {
  return platformKey.startsWith('win32')
    ? `canary-${platformKey}.exe`
    : `canary-${platformKey}`;
}

function getDownloadUrl(version, binaryName) {
  return `https://github.com/bop-clocktower/canary/releases/download/v${version}/${binaryName}`;
}

const TRUSTED_HOSTS = new Set([
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
]);

function validateRedirectHost(location) {
  const { hostname } = new URL(location);
  if (!TRUSTED_HOSTS.has(hostname)) {
    throw new Error(`Redirect to untrusted host: ${hostname}`);
  }
}

function download(url, destPath, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    if (redirectsLeft === 0) return reject(new Error('Too many redirects'));
    https
      .get(url, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          res.resume(); // drain redirect response to free the socket
          try {
            validateRedirectHost(res.headers.location);
          } catch (e) {
            return reject(e);
          }
          return resolve(
            download(res.headers.location, destPath, redirectsLeft - 1),
          );
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
        }
        const file = fs.createWriteStream(destPath);
        res.pipe(file);
        file.on('finish', () => file.close(resolve));
        file.on('error', reject);
      })
      .on('error', reject);
  });
}

async function main() {
  const pkg = require('../package.json');
  const version = pkg.version;
  const platformKey = getPlatformKey(process.platform, process.arch);
  const binaryName = getBinaryName(platformKey);
  const url = getDownloadUrl(version, binaryName);
  const destDir = path.join(__dirname, '..', 'bin');
  const destName = process.platform === 'win32' ? 'canary.exe' : 'canary';
  const destPath = path.join(destDir, destName);

  fs.mkdirSync(destDir, { recursive: true });

  process.stdout.write(`Downloading canary ${version} for ${platformKey}...\n`);
  await download(url, destPath);
  fs.chmodSync(destPath, 0o755);
  process.stdout.write(`Done. Binary at: ${destPath}\n`);
}

// Export pure functions for testing; run main() only when executed directly.
module.exports = {
  getPlatformKey,
  getBinaryName,
  getDownloadUrl,
  validateRedirectHost,
};
if (require.main === module)
  main().catch((e) => {
    process.stderr.write(e.message + '\n');
    process.exit(1);
  });
