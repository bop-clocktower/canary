/**
 * The registry's job is dispatch plus the two honest non-answers: a file no
 * probe claimed, and a probe that blew up.
 */
import { describe, expect, it } from 'vitest';

import {
  describeArtifact,
  matchProbe,
  probeAll,
  probeFile,
} from '../src/analysis/batwoman/registry.js';
import type {
  ExerciseContext,
  ExerciseProbe,
} from '../src/analysis/batwoman/verdict.js';

/** A context whose port throws if anything reaches for the network. */
const OFFLINE_CTX: ExerciseContext = {
  mergedAt: new Date('2026-08-22T17:34:00Z'),
  repo: 'canary',
  root: '/repo',
  runs: {
    runsForWorkflow: () => {
      throw new Error('no test may reach the network');
    },
  },
};

function fakeProbe(id: string, pattern: RegExp): ExerciseProbe {
  return {
    id,
    artifact: id,
    matches: (file) => pattern.test(file),
    probe: async (file) => ({
      file,
      status: 'exercised',
      explanation: `${file} ran after the merge, per the ${id} probe.`,
    }),
  };
}

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

describe('matchProbe', () => {
  const probes = [
    fakeProbe('workflow', /^\.github\/workflows\/.+\.ya?ml$/),
    fakeProbe('script', /^scripts\/.+\.mjs$/),
  ];

  it('returns the first probe that claims the file', () => {
    expect(matchProbe(probes, '.github/workflows/ci.yml')?.id).toBe('workflow');
    expect(matchProbe(probes, 'scripts/a.mjs')?.id).toBe('script');
  });

  it('returns null when nothing claims it', () => {
    expect(matchProbe(probes, 'ts/src/core/persona.ts')).toBeNull();
  });

  it('returns null for an empty registry rather than inventing a probe', () => {
    expect(matchProbe([], 'anything.yml')).toBeNull();
  });
});

describe('probeFile / probeAll dispatch', () => {
  const probes = [fakeProbe('workflow', /\.ya?ml$/)];

  it('returns the matched probe verdict verbatim', async () => {
    const verdict = await probeFile(probes, 'ci.yml', OFFLINE_CTX);
    expect(verdict.status).toBe('exercised');
    expect(verdict.file).toBe('ci.yml');
  });

  it('preserves input order across a whole changed-file set', async () => {
    const files = ['a.yml', 'b.ts', 'c.yml'];
    const verdicts = await probeAll(probes, files, OFFLINE_CTX);
    expect(verdicts.map((verdict) => verdict.file)).toEqual(files);
  });

  it('returns one verdict per file, so the denominator is the input', async () => {
    const files = ['a.yml', 'b.ts', 'c.yml', 'd.md'];
    expect(await probeAll(probes, files, OFFLINE_CTX)).toHaveLength(4);
  });
});

describe('the no-probe fallback', () => {
  const probes = [fakeProbe('workflow', /\.ya?ml$/)];

  it('returns no-probe, never exercised, for an unmatched file', async () => {
    const verdict = await probeFile(probes, 'ts/src/core/x.ts', OFFLINE_CTX);
    expect(verdict.status).toBe('no-probe');
    expect(verdict.status).not.toBe('exercised');
  });

  it('names the artifact type it could not classify', async () => {
    const verdict = await probeFile(probes, 'ts/test/a.test.ts', OFFLINE_CTX);
    expect(verdict.explanation).toContain('test file');
  });

  it('carries no evidence field, because nothing was read', async () => {
    const verdict = await probeFile(probes, 'AGENTS.md', OFFLINE_CTX);
    expect(verdict.evidence).toBeUndefined();
  });

  it('keeps no-probe distinct from abstain', async () => {
    const verdict = await probeFile(probes, 'AGENTS.md', OFFLINE_CTX);
    expect(verdict.status).not.toBe('abstain');
  });

  it('gives every file in an empty registry a named no-probe row', async () => {
    const verdicts = await probeAll([], ['a.ts', 'b.yml'], OFFLINE_CTX);
    expect(verdicts.map((verdict) => verdict.status)).toEqual([
      'no-probe',
      'no-probe',
    ]);
  });
});
