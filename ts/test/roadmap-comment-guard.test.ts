/**
 * Contract tests for `scripts/roadmap_comment_guard.mjs` (#629).
 *
 * The strip is upstream, not ours. Verified on 2026-08-10 against
 * `@harness-engineering/cli` v11.1.1 (and reported on v10.2.0 in #629): a
 * `harness roadmap shard` + `harness roadmap regen` round-trip over a copy of
 * `docs/roadmap.md` writes the header comment block into no shard and no
 * `_meta.md`, so `regen` rebuilds the aggregate without it. Exit code 0 both
 * ways, no warning. Reported upstream as
 * Intense-Visions/harness-engineering#1328. Canary cannot fix that here — the
 * only defence available in this repo is a guard that makes the loss impossible
 * to land silently.
 *
 * Two halves of the block, two very different failure modes:
 *
 *   - `<!-- markdownlint-disable-file MD013 -->` — losing it fails the required
 *     `docs-lint` check loudly, and `roadmap-field-contract.test.ts` already
 *     asserts it survives.
 *   - the machine-managed note that follows — losing it fails **nothing**. It
 *     is the only in-file record of why the roadmap is prettier-exempt and must
 *     not be reflowed, so a silent strip leaves the next reader treating the
 *     `.prettierignore` entry as arbitrary. That is the gap this suite closes.
 *
 * The script is run as a subprocess against fixture files rather than imported,
 * matching `roadmap-groom.test.ts`: it tests exit codes and the bytes written,
 * and keeps a plain `.mjs` out of the typecheck graph.
 *
 * Exit codes follow the repo's gate convention (#508):
 *   0 = block present, or restored
 *   2 = error (the roadmap file is not there at all)
 *   3 = ZERO DENOMINATOR — no `# Roadmap` heading, so there is no insertion
 *       point and nothing was checked. An abstention, never a pass.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runCapture } from './subprocess-testkit.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'roadmap_comment_guard.mjs');
const LIVE_ROADMAP = join(REPO_ROOT, 'docs', 'roadmap.md');

const MD013_DIRECTIVE = '<!-- markdownlint-disable-file MD013 -->';
const NOTE_MARKER = 'Machine-managed by harness roadmap tooling';

const FRONTMATTER = `---
project: canary
version: 1
---

# Roadmap

`;

const BODY = `## Intake

### A row

- **Status:** backlog

`;

/**
 * The header comment block exactly as it stands in the live `docs/roadmap.md` —
 * every HTML comment between the `# Roadmap` heading and the first section.
 */
function liveCommentBlock(): string {
  const text = readFileSync(LIVE_ROADMAP, 'utf8');
  const heading = /^# Roadmap\n\n/m.exec(text);
  if (heading === null) throw new Error('docs/roadmap.md has no # Roadmap');
  const rest = text.slice(heading.index + heading[0].length);
  const block = /^(?:<!--[\s\S]*?-->\n)+/.exec(rest);
  return block === null ? '' : block[0];
}

describe('roadmap comment guard', () => {
  describe('docs/roadmap.md (the thing being guarded)', () => {
    it('still carries the machine-managed contract note', () => {
      // Nothing else fails when this goes missing: markdownlint is silenced by
      // the directive above it, and prettier never reads the file. Without this
      // assertion an upstream regen deletes the repo's only explanation of the
      // one-physical-line field contract and no gate notices (#629).
      const text = readFileSync(LIVE_ROADMAP, 'utf8');

      expect(
        text.includes(NOTE_MARKER),
        'docs/roadmap.md lost its machine-managed header note — restore it ' +
          'with `node scripts/roadmap_comment_guard.mjs`',
      ).toBe(true);
    });

    it('keeps the guard and the file agreeing on the canonical block', () => {
      // A guard that restores a stale block is worse than no guard: it would
      // quietly overwrite an edited header on the next pre-commit run.
      const dir = mkdtempSync(join(tmpdir(), 'guard-drift-'));
      const roadmap = join(dir, 'roadmap.md');
      writeFileSync(roadmap, FRONTMATTER + BODY);

      runCapture(process.execPath, [SCRIPT, '--roadmap', roadmap], {
        failureStatus: 2,
      });
      const restored = /^(?:<!--[\s\S]*?-->\n)+/.exec(
        readFileSync(roadmap, 'utf8').split('# Roadmap\n\n')[1] ?? '',
      );
      rmSync(dir, { recursive: true, force: true });

      expect(restored === null ? '' : restored[0]).toBe(liveCommentBlock());
    });
  });

  describe('scripts/roadmap_comment_guard.mjs', () => {
    let dir: string;
    let roadmap: string;

    const run = (): { status: number; stdout: string } => {
      const { status, output } = runCapture(
        process.execPath,
        [SCRIPT, '--roadmap', roadmap],
        { failureStatus: 2 },
      );
      return { status, stdout: output };
    };

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'guard-'));
      roadmap = join(dir, 'roadmap.md');
    });

    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it('restores the whole block after an upstream regen deletes it', () => {
      writeFileSync(roadmap, FRONTMATTER + BODY);

      expect(run().status).toBe(0);
      const after = readFileSync(roadmap, 'utf8');
      expect(after).toContain(MD013_DIRECTIVE);
      expect(after).toContain(NOTE_MARKER);
      expect(after).toContain('## Intake');
    });

    it('restores the note when only the directive survived', () => {
      // The partial strip is the dangerous one: keying detection off the
      // directive alone reports a healthy header while the note is gone, and
      // the directive is exactly the line a lint failure would prompt someone
      // to paste back by hand.
      writeFileSync(roadmap, FRONTMATTER + MD013_DIRECTIVE + '\n\n' + BODY);

      expect(run().status).toBe(0);
      expect(readFileSync(roadmap, 'utf8')).toContain(NOTE_MARKER);
    });

    it('does not duplicate the directive when restoring a partial strip', () => {
      writeFileSync(roadmap, FRONTMATTER + MD013_DIRECTIVE + '\n\n' + BODY);
      run();

      const after = readFileSync(roadmap, 'utf8');
      expect(after.split(MD013_DIRECTIVE).length - 1).toBe(1);
    });

    it('is a byte-for-byte no-op when the block is intact', () => {
      writeFileSync(roadmap, FRONTMATTER + liveCommentBlock() + '\n' + BODY);
      const before = readFileSync(roadmap, 'utf8');

      expect(run().status).toBe(0);
      expect(readFileSync(roadmap, 'utf8')).toBe(before);
    });

    it('is idempotent — restoring twice settles', () => {
      writeFileSync(roadmap, FRONTMATTER + BODY);
      run();
      const settled = readFileSync(roadmap, 'utf8');

      expect(run().status).toBe(0);
      expect(readFileSync(roadmap, 'utf8')).toBe(settled);
    });

    it('leaves an unrelated extra comment alone when the block is intact', () => {
      const extra = '<!-- a human wrote this -->\n';
      writeFileSync(
        roadmap,
        FRONTMATTER + liveCommentBlock() + extra + '\n' + BODY,
      );

      expect(run().status).toBe(0);
      expect(readFileSync(roadmap, 'utf8')).toContain(extra);
    });

    it('errors with exit 2 on a missing roadmap rather than reporting success', () => {
      // The file it was pointed at is not there: it checked zero bytes. Exit 0
      // here is the false green this repo keeps closing (#508).
      expect(run().status).toBe(2);
    });

    it('abstains with exit 3 when there is no `# Roadmap` heading', () => {
      writeFileSync(roadmap, '---\nproject: canary\n---\n\n' + BODY);
      const result = run();

      expect(result.status).toBe(3);
      expect(result.stdout).toMatch(/ZERO DENOMINATOR|abstain/i);
    });

    it('defaults to the repo roadmap and no-ops on it', () => {
      // The pre-commit hook passes no arguments, so the default path is the
      // one that actually ships. Asserted as a no-op rather than as a restore:
      // a suite run must never rewrite a tracked file, and on a healthy tree
      // there is nothing to rewrite.
      const before = readFileSync(LIVE_ROADMAP, 'utf8');
      const { status, output } = runCapture(process.execPath, [SCRIPT], {
        cwd: REPO_ROOT,
        failureStatus: 2,
      });

      expect(status).toBe(0);
      expect(output).toBe('');
      expect(readFileSync(LIVE_ROADMAP, 'utf8')).toBe(before);
    });
  });
});
