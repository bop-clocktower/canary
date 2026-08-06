/**
 * Every skill that declares a `cli:` entry point ships it executable (#478).
 *
 * `canary skills run <name>` executes the declared file directly. A skill whose
 * CLI landed in git at mode 0644 installs cleanly, lists cleanly, documents
 * cleanly -- and cannot run. `canary-shadow` shipped that way: 1 of 7
 * first-party skill CLIs, undetectable from anything but an actual execution.
 *
 * The denominator matters here, so the suite asserts it: if the frontmatter
 * scan ever finds zero skills, that is an abstention and fails loudly rather
 * than passing as "all 0 skills are executable".
 */

import { accessSync, constants, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const SKILLS_ROOT = join(import.meta.dirname, '..', '..', 'agents', 'skills');

/** `cli: <path>` out of a SKILL.md YAML frontmatter block, or null. */
function declaredCli(skillMd: string): string | null {
  const match = /^cli:\s*(\S+)\s*$/m.exec(skillMd);
  return match === null ? null : match[1]!;
}

/** Every first-party skill directory holding a SKILL.md, per agent surface. */
function skillDirs(): string[] {
  const found: string[] = [];
  for (const surface of readdirSync(SKILLS_ROOT, { withFileTypes: true })) {
    // `node_modules` is vendored tooling, not a first-party skill surface.
    if (!surface.isDirectory() || surface.name === 'node_modules') continue;
    const surfaceDir = join(SKILLS_ROOT, surface.name);
    for (const skill of readdirSync(surfaceDir, { withFileTypes: true })) {
      if (!skill.isDirectory()) continue;
      found.push(join(surfaceDir, skill.name));
    }
  }
  return found;
}

/** `[skillDir, absolute cli path]` for every skill declaring a `cli:`. */
function skillsWithCli(): [string, string][] {
  const rows: [string, string][] = [];
  for (const dir of skillDirs()) {
    let body: string;
    try {
      body = readFileSync(join(dir, 'SKILL.md'), 'utf-8');
    } catch {
      continue; // not a skill directory
    }
    const cli = declaredCli(body);
    if (cli !== null) rows.push([dir, join(dir, cli)]);
  }
  return rows;
}

describe('skill CLI executability (#478)', () => {
  const rows = skillsWithCli();

  it('finds skills declaring a cli: entry point at all', () => {
    // Zero here would make every assertion below vacuously true -- the
    // false-green shape this repo exists to catch. If the frontmatter key or
    // the directory layout is renamed, this fails instead of going quiet.
    expect(rows.length).toBeGreaterThan(0);
  });

  it.each(rows)('%s ships its CLI executable', (_dir, cliPath) => {
    // X_OK is what `canary skills run` needs; R_OK alone is the #478 defect.
    expect(() => accessSync(cliPath, constants.X_OK)).not.toThrow();
  });
});
