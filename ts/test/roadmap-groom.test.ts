/**
 * Contract tests for `scripts/roadmap-groom.mjs` (#595).
 *
 * Context: `docs/roadmap.md`, `docs/roadmap-archive.md`, and
 * `scripts/roadmap_comment_guard.mjs` all instruct the reader to run
 * `harness roadmap groom`. That subcommand does not exist — v10 ships migrate,
 * shard, unshard, regen, reconcile, and sync, and nothing else. So grooming has
 * always been a hand edit against a file whose own header claims otherwise,
 * which is why ten `done` rows accumulated in the live roadmap.
 *
 * Run as a subprocess against fixture files rather than by importing the module.
 * That tests the contract that actually matters — exit codes, dry-run default,
 * and the bytes written — and keeps a plain `.mjs` out of the typecheck graph.
 *
 * Exit codes follow the repo's gate convention (#508):
 *   0 = examined rows, wrote (or would write) a result
 *   2 = error
 *   3 = ZERO DENOMINATOR — parsed no rows at all, an abstention, never a pass
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'roadmap-groom.mjs');

const ROADMAP_HEAD = `---
project: canary
version: 1
---

# Roadmap

<!-- markdownlint-disable-file MD013 -->

`;

const ARCHIVE_HEAD = `---
project: canary
version: 1
---

# Roadmap

<!-- markdownlint-disable-file MD013 -->

## Shipped

`;

function row(name: string, status: string): string {
  return `### ${name}

- **Status:** ${status}
- **Spec:** —
- **Summary:** Body for ${name}.
- **Blockers:** —
- **Plan:** —

`;
}

interface Run {
  status: number;
  stdout: string;
}

/**
 * `execFileSync` throws on a non-zero exit, which is the case under test for
 * three of the exit codes here — so a throw is a result, not a failure.
 *
 * Split out of `run` to keep that helper under the complexity threshold tests
 * are held to (10, against 15 for `ts/src`). The nullish defaults are each a
 * branch, and four of them in one function is enough to trip it.
 */
function asRun(error: unknown): Run {
  const e = error as { status?: number; stdout?: string; stderr?: string };
  return {
    status: e.status ?? 2,
    stdout: `${e.stdout ?? ''}${e.stderr ?? ''}`,
  };
}

describe('roadmap-groom', () => {
  let dir: string;
  let roadmap: string;
  let archive: string;

  const run = (...args: string[]): Run => {
    try {
      const stdout = execFileSync(
        process.execPath,
        [SCRIPT, '--roadmap', roadmap, '--archive', archive, ...args],
        { encoding: 'utf-8' },
      );
      return { status: 0, stdout };
    } catch (error) {
      return asRun(error);
    }
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'groom-'));
    roadmap = join(dir, 'roadmap.md');
    archive = join(dir, 'roadmap-archive.md');
    writeFileSync(
      roadmap,
      ROADMAP_HEAD +
        '## Intake\n\n' +
        row('Shipped thing', 'done') +
        row('Live thing', 'backlog') +
        row('Another shipped', 'done'),
    );
    writeFileSync(archive, ARCHIVE_HEAD + row('Old thing', 'done'));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('is dry by default and writes nothing', () => {
    const before = readFileSync(roadmap, 'utf-8');
    const result = run();

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/Dry run/);
    expect(readFileSync(roadmap, 'utf-8')).toBe(before);
  });

  it('reports its denominator, not just its findings', () => {
    // "2 moved" alone cannot be distinguished from a parser that found 2 of 40.
    expect(run().stdout).toMatch(/Examined 3 row/);
  });

  it('moves only done rows on --apply', () => {
    expect(run('--apply').status).toBe(0);

    const after = readFileSync(roadmap, 'utf-8');
    expect(after).toContain('### Live thing');
    expect(after).not.toContain('### Shipped thing');
    expect(after).not.toContain('### Another shipped');
  });

  it('appends moved rows to the archive without disturbing existing ones', () => {
    run('--apply');

    const after = readFileSync(archive, 'utf-8');
    expect(after).toContain('### Old thing');
    expect(after).toContain('### Shipped thing');
    expect(after).toContain('### Another shipped');
  });

  it('preserves a moved row verbatim, body and all', () => {
    run('--apply');
    expect(readFileSync(archive, 'utf-8')).toContain(
      '- **Summary:** Body for Shipped thing.',
    );
  });

  it('is idempotent — a second run finds nothing left to move', () => {
    run('--apply');
    const settled = readFileSync(archive, 'utf-8');

    const second = run('--apply');
    expect(second.status).toBe(0);
    expect(second.stdout).toMatch(/0 row\(s\) moved/);
    expect(readFileSync(archive, 'utf-8')).toBe(settled);
  });

  it('abstains with exit 3 when the roadmap parses to zero rows', () => {
    // Not a pass. A groom that examined nothing has verified nothing (#508).
    writeFileSync(roadmap, ROADMAP_HEAD + '## Intake\n\n');
    const result = run('--apply');

    expect(result.status).toBe(3);
    expect(result.stdout).toMatch(/ZERO DENOMINATOR|abstain/i);
  });

  it('errors with exit 2 when the archive has no ## Shipped section', () => {
    writeFileSync(archive, ARCHIVE_HEAD.replace('## Shipped', '## Nope'));
    const result = run('--apply');

    expect(result.status).toBe(2);
    expect(result.stdout).toMatch(/Shipped/);
  });

  it('errors with exit 2 on a missing roadmap rather than reporting zero', () => {
    rmSync(roadmap);
    expect(run('--apply').status).toBe(2);
  });

  it('leaves a section heading in place even when it empties out', () => {
    // Removing the heading would make the next row land in the wrong section.
    writeFileSync(
      roadmap,
      ROADMAP_HEAD + '## Intake\n\n' + row('Only', 'done'),
    );
    run('--apply');
    expect(readFileSync(roadmap, 'utf-8')).toContain('## Intake');
  });
});
