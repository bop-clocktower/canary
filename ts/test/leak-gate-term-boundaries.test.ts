/**
 * Denylist term boundaries for the leak gate's FILE scan.
 *
 * Terms were compiled to `\b<term>\b`. A `\b` next to punctuation needs a word
 * character on its far side, so a term that ends in `+` or `.` ("Acme+",
 * "Acme Inc.") never matched a real mention like "Acme+ suite" — the term sat
 * in the denylist matching nothing, and the gate failed open. The authorship
 * scan learned this in its own compiler; the file scan had not.
 *
 * NOTE FOR EDITORS: this file is scanned by the gate. Terms are synthetic.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'check_removed_symbols.mjs');

const roots: string[] = [];
afterEach(() => {
  for (const d of roots.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Scan a one-file fixture tree against `denylist`; returns the exit status. */
function scan(denylist: string, body: string): number {
  const root = mkdtempSync(join(tmpdir(), 'leak-bounds-'));
  roots.push(root);
  mkdirSync(join(root, 'docs'), { recursive: true });
  writeFileSync(join(root, 'docs', 'notes.md'), body, 'utf-8');
  // The scanner walks git-tracked files; an untracked fixture scans nothing.
  execFileSync('git', ['-C', root, 'init', '-q']);
  execFileSync('git', ['-C', root, 'add', '-A']);
  const env: Record<string, string | undefined> = {
    ...process.env,
    CANARY_LEAK_SCAN_ROOT: root,
    CANARY_PROPRIETARY_DENYLIST: denylist,
    CANARY_DENYLIST_FILE: join(root, 'no-such-denylist'),
    CANARY_LEAK_SCAN_TREE: undefined,
    GITHUB_EVENT_NAME: undefined,
    GITHUB_BASE_REF: undefined,
    GITHUB_EVENT_BEFORE: undefined,
    CANARY_AUTHOR_RANGE: undefined,
  };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  return spawnSync(process.execPath, [SCRIPT], { encoding: 'utf-8', env })
    .status!;
}

describe('denylist terms ending in punctuation still match', () => {
  it.each([
    ['Quuxlander+', 'Built for Quuxlander+ last year.\n'],
    ['Quuxlander+', 'Built for Quuxlander+.\n'],
    ['Quux Inc.', 'Signed with Quux Inc. today.\n'],
    ['Quux Inc.', 'Signed with Quux Inc.\n'],
  ])('flags %j in %j', (term, body) => {
    expect(scan(term, body)).toBe(1);
  });
});

describe('word terms keep whole-word semantics', () => {
  it.each([
    ['Quuxlander', 'Quuxlanders are fine.\n'],
    ['Quuxlander', 'the quuxlander_id column\n'],
    ['Quuxlander', 'preQuuxlander\n'],
  ])('does not flag %j inside %j', (term, body) => {
    expect(scan(term, body)).toBe(0);
  });

  it('still flags a bare whole-word mention, case-insensitively', () => {
    expect(scan('Quuxlander', 'Ask the QUUXLANDER team.\n')).toBe(1);
  });
});
