/**
 * The registry's job is dispatch plus the two honest non-answers: a file no
 * probe claimed, and a probe that blew up.
 */
import { describe, expect, it } from 'vitest';

import { describeArtifact } from '../src/analysis/batwoman/registry.js';

describe('describeArtifact', () => {
  it.each([
    ['ts/test/refresh-arch-baseline.test.ts', 'test file'],
    ['ts/src/analysis/engine.spec.ts', 'test file'],
    ['agents/skills/claude-code/canary-katana/SKILL.md', 'skill document'],
    ['harness.config.json', 'config'],
    ['mise.toml', 'config'],
    ['ts/src/core/persona.ts', 'source module'],
    ['scripts/roadmap-groom.mjs', 'source module'],
    ['AGENTS.md', 'document'],
    ['docs/assets/logo.png', 'unrecognised artifact'],
  ])('describes %s as a %s', (file, noun) => {
    expect(describeArtifact(file)).toBe(noun);
  });

  it('never returns an empty phrase, so a row always names something', () => {
    for (const file of ['', 'x', 'a/b/c']) {
      expect(describeArtifact(file).length).toBeGreaterThan(0);
    }
  });
});
