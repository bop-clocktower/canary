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

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runCapture } from './subprocess-testkit.js';

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

describe('roadmap-groom', () => {
  let dir: string;
  let roadmap: string;
  let archive: string;

  const run = (...args: string[]): Run => {
    const { status, output } = runCapture(
      process.execPath,
      [SCRIPT, '--roadmap', roadmap, '--archive', archive, ...args],
      { failureStatus: 2 },
    );
    return { status, stdout: output };
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

  it('lands a long field in the archive as ONE physical line (#630)', () => {
    // The fixture above uses a short Summary, so "verbatim" above passes even
    // if a writer reflowed long values. Real rows carry 400-1200 character
    // summaries, and the archive is under the same one-line field contract as
    // the roadmap (ts/test/roadmap-field-contract.test.ts scans both). A wrap
    // introduced HERE is the one the field-contract test can only catch after
    // the fact, once the damaged archive is already committed.
    const long = `Long enough to exceed prettier's printWidth several times over, which is the length at which proseWrap: "always" would break the value across lines and harness would keep only the first of them. ${'Filler clause. '.repeat(8)}Ends deliberately.`;
    writeFileSync(
      roadmap,
      ROADMAP_HEAD +
        '## Intake\n\n' +
        `### Wordy thing\n\n- **Status:** done\n- **Summary:** ${long}\n\n`,
    );

    expect(run('--apply').status).toBe(0);

    const lines = readFileSync(archive, 'utf-8').split('\n');
    const field = lines.filter((l) => l.startsWith('- **Summary:** Long'));

    expect(field).toHaveLength(1);
    expect(field[0]).toBe(`- **Summary:** ${long}`);
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

  describe('tracker cross-check (#879)', () => {
    // The groom never looked at GitHub, so a row whose issue was closed — or
    // whose work already merged — sat as `backlog` and was ranked into build
    // batches (4 of 45 in the 2026-09-13 intake). The groom must surface those
    // rows before anyone ranks the roadmap. It reports; it never reconciles.
    const linked = (name: string, status: string, n: number) =>
      row(name, status).replace(
        '- **Plan:** —\n',
        `- **Plan:** —\n- **External-ID:** github:o/r#${n}\n`,
      );

    beforeEach(() => {
      writeFileSync(
        roadmap,
        ROADMAP_HEAD +
          '## Intake\n\n' +
          linked('Closed upstream', 'backlog', 452) +
          linked('Merged elsewhere', 'planned', 477) +
          linked('Genuinely open', 'backlog', 604) +
          row('Unlinked', 'backlog'),
      );
    });

    const withStates = (states: object, ...args: string[]) => {
      const file = join(dir, 'states.json');
      writeFileSync(file, JSON.stringify(states));
      return run('--issue-states', file, ...args);
    };

    it('flags a not-done row whose issue is closed or has a merged PR', () => {
      const r = withStates({
        '452': { state: 'CLOSED', mergedPrs: [] },
        '477': { state: 'OPEN', mergedPrs: [714] },
        '604': { state: 'OPEN', mergedPrs: [] },
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/Closed upstream.*#452.*closed/i);
      expect(r.stdout).toMatch(/Merged elsewhere.*#477.*PR #714/i);
      expect(r.stdout).not.toMatch(/Genuinely open.*#604/);
      // Denominator: linked rows checked, unlinked rows counted separately.
      expect(r.stdout).toMatch(/Checked 3 linked row\(s\).*2 stale/);
      expect(r.stdout).toMatch(/1 row\(s\) with no External-ID/);
    });

    it('never moves or edits a stale row, even with --apply', () => {
      // --apply re-serializes the roadmap as it always has; what must not
      // happen is a stale-but-not-done row being reconciled on the tracker's say.
      withStates({ '452': { state: 'CLOSED', mergedPrs: [] } }, '--apply');
      const after = readFileSync(roadmap, 'utf-8');
      expect(after).toContain(
        linked('Closed upstream', 'backlog', 452).trimEnd(),
      );
      expect(readFileSync(archive, 'utf-8')).not.toContain('Closed upstream');
    });

    it('abstains on a linked row the state source has no answer for', () => {
      // An unknown issue state is not "open": say it could not be checked.
      const r = withStates({ '452': { state: 'CLOSED', mergedPrs: [] } });
      expect(r.stdout).toMatch(/2 linked row\(s\) not checked/);
    });

    it('says so when it did not cross-check the tracker at all', () => {
      expect(run().stdout).toMatch(/tracker not checked/i);
    });
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
