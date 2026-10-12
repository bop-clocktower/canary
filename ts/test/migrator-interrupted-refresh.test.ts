/**
 * An interrupted skill refresh must not convert an untouched deployment into a
 * permanent "local edits" refusal.
 *
 * The refresh path deletes the deployed skill and then copies the overlay's
 * version over it. When that copy fails part-way (here: one overlay file the
 * process cannot read), the deployed directory is left holding a partial copy
 * whose hash matches neither the overlay nor the recorded manifest hash. Every
 * later run then classifies the skill as hand-edited and refuses to refresh it,
 * even after the cause of the failure is gone -- the consumer never touched it.
 */

import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { HarnessMigrator } from '../src/core/migrator.js';

const HOME = mkdtempSync(join(tmpdir(), 'canary-refresh-home-'));
afterAll(() => rmSync(HOME, { recursive: true, force: true }));

// chmod cannot make a file unreadable on Windows, nor to root.
const canRevokeRead = process.platform !== 'win32' && process.getuid?.() !== 0;

describe('interrupted skill refresh', () => {
  it.skipIf(!canRevokeRead)(
    'a refresh that failed mid-copy is retried, not refused as a local edit',
    () => {
      const base = mkdtempSync(join(tmpdir(), 'canary-refresh-'));
      const blocked = join(base, 'overlay', '.canary', 'skills', 'sample');
      try {
        const root = join(base, 'proj');
        const overlay = join(base, 'overlay');
        mkdirSync(join(root, '.harness'), { recursive: true });
        writeFileSync(
          join(root, 'harness.config.json'),
          JSON.stringify({ language: 'python', layers: [] }),
        );
        mkdirSync(blocked, { recursive: true });
        const skillMd = (body: string): string =>
          `---\nname: sample\ndeploy_to: [all]\n---\n\n${body}\n`;
        writeFileSync(join(blocked, 'SKILL.md'), skillMd('v1'));

        const m = new HarnessMigrator(HOME);
        m.migrate(root, { dryRun: false, overlayPath: overlay });

        // The overlay moves on to v2, which ships a file the copy cannot read.
        writeFileSync(join(blocked, 'SKILL.md'), skillMd('v2'));
        const extra = join(blocked, 'notes.md');
        writeFileSync(extra, 'notes\n');
        chmodSync(extra, 0o000);
        try {
          m.migrate(root, { dryRun: false, overlayPath: overlay });
        } catch {
          // The interrupted refresh is the setup, not the assertion.
        }

        // The cause is fixed; the next run should finish the refresh.
        chmodSync(extra, 0o644);
        const report = m.migrate(root, { dryRun: false, overlayPath: overlay });
        expect(
          report.deployed_skills.map((r) => [r.skill_name, r.status]),
        ).toEqual([['sample', 'updated']]);
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    },
  );
});
