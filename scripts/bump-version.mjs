#!/usr/bin/env node
// bump-version.mjs — the single source of truth for stamping a release version.
//
// The version string is unavoidably duplicated: npm, the Claude Code plugin
// loader, and the marketplace catalog each mandate a version in their own
// manifest, and none will read it from a shared file. Rather than hand-edit N
// files (which historically drifted — see ts/test/version-consistency.test.ts),
// this script writes them all from one argument. The consistency test stays as
// the safety net; this makes drift impossible in normal use.
//
// Usage: node scripts/bump-version.mjs <version>   e.g. 6.1.0 or 6.1.0-rc.1
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;

const version = process.argv[2];
if (!version || !SEMVER.test(version)) {
  process.stderr.write(
    `usage: bump-version.mjs <version>\n` +
      `  <version> must be semver-shaped, e.g. 6.1.0 or 6.1.0-rc.1\n`,
  );
  process.exit(2);
}

/** Read a JSON file, mutate it, write it back as prettier-clean 2-space JSON. */
function editJson(relPath, mutate) {
  const abs = resolve(REPO, relPath);
  const data = JSON.parse(readFileSync(abs, 'utf-8'));
  const before = mutate(data);
  writeFileSync(abs, JSON.stringify(data, null, 2) + '\n');
  return before;
}

const changed = [];

changed.push([
  'npm/package.json',
  editJson('npm/package.json', (d) => {
    const b = d.version;
    d.version = version;
    return b;
  }),
]);

changed.push([
  '.claude-plugin/plugin.json',
  editJson('.claude-plugin/plugin.json', (d) => {
    const b = d.version;
    d.version = version;
    return b;
  }),
]);

changed.push([
  '.claude-plugin/marketplace.json',
  editJson('.claude-plugin/marketplace.json', (d) => {
    const canary = (d.plugins ?? []).find((p) => p.name === 'canary');
    if (!canary)
      throw new Error('no plugin named "canary" in marketplace.json');
    const b = canary.version;
    canary.version = version;
    return b;
  }),
]);

// README shields.io badge is a display artifact (not gated by the consistency
// test) but kept accurate: `...badge/version-<semver>-<color>...`.
{
  const abs = resolve(REPO, 'README.md');
  const text = readFileSync(abs, 'utf-8');
  const re = /(badge\/version-)\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?(-)/;
  const m = text.match(re);
  writeFileSync(abs, text.replace(re, `$1${version}$2`));
  changed.push(['README.md (badge)', m ? m[0].split('-')[1] : '(not found)']);
}

process.stdout.write(`Bumped version -> ${version}\n`);
for (const [file, before] of changed) {
  process.stdout.write(`  ${file}: ${before} -> ${version}\n`);
}
