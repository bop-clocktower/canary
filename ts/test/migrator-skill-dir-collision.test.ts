/**
 * Two overlay tiers that ship different skills under the SAME directory name
 * must not let the lower-precedence one overwrite the higher-precedence one.
 *
 * Skills are de-duplicated by frontmatter `name`, but deployed to
 * `.canary/skills/<directory name>`. When the explicit overlay and the
 * `~/.canary/skills` home tier each carry a directory called `shared` holding
 * differently-named skills, both survive de-duplication and both target one
 * destination: the explicit overlay's copy lands first, then the home tier's
 * copy is treated as a safe refresh of it and replaces it -- while the report
 * lists both as deployed. The explicit overlay is documented to win.
 */

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { HarnessMigrator } from '../src/core/migrator.js';

function skill(root: string, dir: string, name: string): void {
  const skillDir = join(root, '.canary', 'skills', dir);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, 'SKILL.md'),
    `---\nname: ${name}\ndeploy_to: [all]\n---\n\n# ${name}\n`,
  );
}

describe('overlay tier directory-name collision', () => {
  it('keeps the explicit overlay skill when the home tier reuses its directory name', () => {
    const base = mkdtempSync(join(tmpdir(), 'canary-dircoll-'));
    try {
      const root = join(base, 'proj');
      const overlay = join(base, 'overlay');
      const home = join(base, 'home');
      mkdirSync(join(root, '.harness'), { recursive: true });
      writeFileSync(
        join(root, 'harness.config.json'),
        JSON.stringify({ language: 'python', layers: [] }),
      );
      skill(overlay, 'shared', 'alpha');
      skill(home, 'shared', 'beta');

      new HarnessMigrator(home).migrate(root, {
        dryRun: false,
        overlayPath: overlay,
      });

      const deployed = readFileSync(
        join(root, '.canary', 'skills', 'shared', 'SKILL.md'),
        'utf-8',
      );
      expect(deployed).toContain('name: alpha');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
