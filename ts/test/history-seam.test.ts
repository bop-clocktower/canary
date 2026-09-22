/**
 * Guards #1074: the headroom the `ts/src/history` split bought has to stay
 * bought.
 *
 * `ts/src/history` sat EXACTLY on its 1800-LOC arch module-size ceiling and
 * `ts/src/history/cli.ts` EXACTLY on the 15-import perf threshold, so the next
 * `history` subcommand tripped both required checks on its first CI run. The
 * perf delta rule is unwaivable (`--admin` cannot bypass a red required
 * check), so paydown was the only legal route and the fix was to split the
 * command root into one directory per subcommand family.
 *
 * None of the three ratchets that enforce that live locally -- module LOC, the
 * perf file-length/coupling delta, and the import threshold are all CI-only,
 * which is precisely why #1074 was filed rather than discovered mid-PR. This
 * file is the local half: it fails at the desk, on the four gates, when a
 * change starts re-growing the root.
 *
 * It deliberately asserts the STRUCTURAL rule, not a line count of the current
 * files: a new subcommand opens its own `<family>/cli.ts`, and the root gains
 * at most one import for it.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { createHistoryCommand } from '../src/history/cli.js';

const HISTORY = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'history',
);

/**
 * Cap on the command root's imports: well under the perf gate's 15 so this
 * test trips first, with room for several more subcommand families.
 */
const MAX_ROOT_IMPORTS = 10;

/**
 * `harness check-perf` flags a file over 300 lines, and the perf ratchet fails
 * a PR that introduces a finding its merge base did not have. A family module
 * that crosses this is a red required check, not a style note.
 */
const MAX_CLI_FILE_LINES = 300;

function importCount(file: string): number {
  return [...readFileSync(file, 'utf8').matchAll(/^import\b/gm)].length;
}

function lineCount(file: string): number {
  return readFileSync(file, 'utf8').split('\n').length;
}

/** Every `ts/src/history/<family>/cli.ts` -- the per-family command modules. */
function familyCliModules(): string[] {
  return readdirSync(HISTORY)
    .filter((e) => statSync(join(HISTORY, e)).isDirectory())
    .map((e) => join(HISTORY, e, 'cli.ts'))
    .filter((p) => {
      try {
        return statSync(p).isFile();
      } catch {
        return false;
      }
    });
}

describe('history command seam (#1074)', () => {
  it('keeps the command root under the import threshold', () => {
    expect(importCount(join(HISTORY, 'cli.ts'))).toBeLessThanOrEqual(
      MAX_ROOT_IMPORTS,
    );
  });

  it('keeps the command root free of subcommand bodies', () => {
    // The root builds the program and delegates. A `.command(` here means a
    // subcommand was added to the root instead of to a family module, which is
    // the growth #1074 paid down.
    const src = readFileSync(join(HISTORY, 'cli.ts'), 'utf8');
    expect(src).not.toMatch(/\.command\(/);
  });

  it('mounts every family module it registers', () => {
    // A registrar that is written but never called is the failure this whole
    // split invites: help stays correct-looking while a subcommand is gone.
    const registered = createHistoryCommand({
      out: () => {},
      err: () => {},
    }).commands.map((c) => c.name());
    expect(registered).toEqual([
      'record',
      'push',
      'migrate',
      'flaky',
      'timeline',
      'summary',
    ]);
  });

  it('finds at least the four family modules the split created', () => {
    // A zero here would make every per-file assertion below vacuous: 0 files
    // checked is an abstention, not a pass.
    expect(familyCliModules().length).toBeGreaterThanOrEqual(4);
  });

  it.each(familyCliModules())(
    'keeps %s under the perf file-length threshold',
    (file) => {
      expect(lineCount(file)).toBeLessThanOrEqual(MAX_CLI_FILE_LINES);
    },
  );
});
