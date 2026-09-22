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
// #1059: npm/package-lock.json declares the version twice and was NOT stamped
// here, so it sat two releases stale while the consistency test — which did
// not cover it either — stayed green. Both halves are fixed: the lockfile is
// stamped below, and it is now inside that test's denominator.
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

// #1064: `JSON.stringify` always emits non-ASCII literally, so a file that
// stored a character as a `\uXXXX` escape came back re-encoded and every
// release commit carried an unrelated one-line diff. The two `.claude-plugin/`
// manifests store their non-ASCII literally, so a blanket ASCII-escaping
// serializer would just move the noise to them. Instead the writer preserves
// whichever style the SOURCE used, per code unit, which makes a no-op bump a
// fixed point for every manifest.
//
// Assumption: a code unit is written one way throughout a given file. If a
// file ever mixes both styles for the same character, the escaped form wins
// for all of its occurrences — still a valid, value-identical JSON document.

/** UTF-16 code units the source text wrote as `\uXXXX` escapes. */
function escapedCodeUnits(text) {
  const units = new Set();
  for (const m of text.matchAll(/\\u([0-9a-fA-F]{4})/g)) {
    units.add(Number.parseInt(m[1], 16));
  }
  return units;
}

/** Re-escape the code units the source had escaped; leave the rest literal. */
function restoreEscapes(json, units) {
  if (units.size === 0) return json;
  // No `u` flag on purpose: matching per UTF-16 code unit means an astral
  // character round-trips as the escaped surrogate pair a source would have
  // stored, rather than falling through as one unmatched code point.
  return json.replace(/[^\x00-\x7f]/g, (ch) => {
    const unit = ch.charCodeAt(0);
    return units.has(unit) ? `\\u${unit.toString(16).padStart(4, '0')}` : ch;
  });
}

/** Read a JSON file, mutate it, write it back as prettier-clean 2-space JSON. */
function editJson(relPath, mutate) {
  const abs = resolve(REPO, relPath);
  const text = readFileSync(abs, 'utf-8');
  const data = JSON.parse(text);
  const before = mutate(data);
  const serialized = JSON.stringify(data, null, 2);
  writeFileSync(abs, restoreEscapes(serialized, escapedCodeUnits(text)) + '\n');
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

// The lockfile carries the version in two places (root and the root package
// entry). `npm install --package-lock-only` would also do this, but it needs a
// registry round-trip; stamping both fields directly keeps the bump offline
// and deterministic.
changed.push([
  'npm/package-lock.json',
  editJson('npm/package-lock.json', (d) => {
    const b = d.version;
    d.version = version;
    if (!d.packages?.['']) {
      throw new Error('npm/package-lock.json has no root ("") package entry');
    }
    d.packages[''].version = version;
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
