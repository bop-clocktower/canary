// Every shipped skill script must be text as far as git is concerned. Git
// (and GitHub, and plain grep) call a file binary once they see a NUL byte, and
// then hide its diffs, blame and search hits without saying so. That happened to
// canary-katana's diffscan.mjs for months (#1250): a map-key delimiter was typed
// as a raw 0x00 instead of the escape \u0000. Per-skill "ascii-only" tests used
// the class [\x00-\x7F], which admits control bytes, so nothing caught it.
//
// This sweep covers every .mjs under agents/skills (skills and the shared lib),
// so the byte class cannot come back in a skill that lacks its own check.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// Raw C0 controls other than tab, LF and CR, plus DEL.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/;

const scripts = (dir: string, out: string[] = []): string[] => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'coverage') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) scripts(full, out);
    else if (e.name.endsWith('.mjs')) out.push(full);
  }
  return out;
};

describe('shipped skill scripts', () => {
  const files = scripts(ROOT);

  // A sweep over zero files passes vacuously; prove it saw the tree.
  it('finds the scripts it is meant to check', () => {
    expect(files.length).toBeGreaterThan(50);
    expect(
      files.some((f) => f.endsWith('canary-katana/scripts/diffscan.mjs')),
    ).toBe(true);
  });

  it('contain no raw control bytes (git would treat them as binary)', () => {
    const offenders = files
      .filter((f) => CONTROL.test(fs.readFileSync(f, 'latin1')))
      .map((f) => path.relative(ROOT, f));
    expect(offenders).toEqual([]);
  });
});
