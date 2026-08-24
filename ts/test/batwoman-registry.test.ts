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
import {
  explain,
  tallyVerdicts,
  type ExerciseContext,
  type ExerciseProbe,
  type ExerciseVerdict,
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
      explanation: explain(`${file} ran after the merge, per the ${id} probe.`),
      evidence: `gh run list --workflow ${file}`,
    }),
  };
}

/**
 * A probe returning whatever it is handed, cast past the type boundary.
 *
 * The cast is the point: `ExerciseVerdict` makes these shapes unrepresentable
 * in TypeScript, but a probe can arrive from JavaScript, from a plugin, or
 * from a `JSON.parse`, and `probeFile` is the seam where an untrusted answer
 * enters batwoman's own tally.
 */
function misbehaving(answer: unknown): ExerciseProbe {
  return {
    id: 'workflow',
    artifact: 'workflow',
    matches: () => true,
    probe: async () => answer as ExerciseVerdict,
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

describe('a probe whose answer does not hold together', () => {
  /**
   * `probeFile` used to `return await probe.probe(file, ctx)` verbatim. Review
   * found that rewriting the `file` field inside it survived the whole suite,
   * and that a status outside the five would reach `tallyVerdicts`, where
   * `byStatus[status] += 1` yields `NaN` and silently breaks the sum-to-total
   * invariant the summary line rests on. Abstain is the honest answer for a
   * probe that misbehaved: something looked, and its answer cannot be trusted.
   */
  const GOOD = {
    file: 'ci.yml',
    status: 'exercised',
    explanation: 'It ran after the merge.',
    evidence: 'gh run list',
  };

  it('accepts a well-formed verdict, so the guard is not simply refusing all', async () => {
    // The planted positive: without it every assertion below would pass on a
    // `probeFile` that abstained unconditionally.
    const verdict = await probeFile([misbehaving(GOOD)], 'ci.yml', OFFLINE_CTX);
    expect(verdict.status).toBe('exercised');
    expect(verdict.explanation).toBe('It ran after the merge.');
  });

  it('abstains when the verdict names a different file', async () => {
    const probes = [misbehaving({ ...GOOD, file: 'other.yml' })];
    const verdict = await probeFile(probes, 'ci.yml', OFFLINE_CTX);
    expect(verdict.status).toBe('abstain');
    expect(verdict.file).toBe('ci.yml');
    expect(verdict.explanation).toContain('other.yml');
    expect(verdict.explanation).toContain('workflow');
  });

  it('abstains on a status outside the five, rather than tallying NaN', async () => {
    const probes = [misbehaving({ ...GOOD, status: 'probably-fine' })];
    const verdict = await probeFile(probes, 'ci.yml', OFFLINE_CTX);
    expect(verdict.status).toBe('abstain');
    expect(verdict.explanation).toContain('probably-fine');
  });

  it('keeps the tally finite for every misbehaving shape', async () => {
    const shapes = [
      { ...GOOD, status: 'probably-fine' },
      { ...GOOD, file: 'other.yml' },
      { ...GOOD, explanation: '' },
      { ...GOOD, evidence: undefined },
      null,
      'exercised',
    ];
    for (const shape of shapes) {
      const verdict = await probeFile(
        [misbehaving(shape)],
        'a.yml',
        OFFLINE_CTX,
      );
      const tally = tallyVerdicts([verdict]);
      expect(Number.isFinite(tally.byStatus[verdict.status])).toBe(true);
      expect(Object.values(tally.byStatus).reduce((a, b) => a + b, 0)).toBe(1);
    }
  });

  it('abstains on an empty explanation, the gap the type boundary forbids', async () => {
    const probes = [misbehaving({ ...GOOD, explanation: '   ' })];
    const verdict = await probeFile(probes, 'ci.yml', OFFLINE_CTX);
    expect(verdict.status).toBe('abstain');
    expect(verdict.explanation.trim().length).toBeGreaterThan(0);
  });

  it('abstains on a positive claim carrying no evidence', async () => {
    // BW-I4 one level down: the type forbids it, and the runtime seam agrees,
    // because a probe from outside TypeScript can still try.
    for (const status of ['exercised', 'not-exercised']) {
      const probes = [misbehaving({ ...GOOD, status, evidence: undefined })];
      const verdict = await probeFile(probes, 'ci.yml', OFFLINE_CTX);
      expect(verdict.status).toBe('abstain');
      expect(verdict.explanation).toContain('evidence');
    }
  });

  it('names the probe in every rejection, so the gap is attributable', async () => {
    for (const shape of [
      { ...GOOD, status: 'probably-fine' },
      { ...GOOD, file: 'other.yml' },
      { ...GOOD, explanation: '' },
      { ...GOOD, evidence: undefined },
    ]) {
      const verdict = await probeFile(
        [misbehaving(shape)],
        'ci.yml',
        OFFLINE_CTX,
      );
      expect(verdict.explanation).toContain('workflow');
      expect(verdict.evidence).toBe('workflow probe answer');
    }
  });

  it('abstains when a probe answers with nothing at all', async () => {
    for (const answer of [null, undefined, 'exercised', 42]) {
      const verdict = await probeFile(
        [misbehaving(answer)],
        'ci.yml',
        OFFLINE_CTX,
      );
      expect(verdict.status).toBe('abstain');
    }
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

describe('a probe that throws', () => {
  const exploding: ExerciseProbe = {
    id: 'workflow',
    artifact: 'workflow',
    matches: () => true,
    probe: async () => {
      throw new Error('gh: could not authenticate');
    },
  };

  it('abstains rather than reporting the file clean', async () => {
    const verdict = await probeFile([exploding], 'ci.yml', OFFLINE_CTX);
    expect(verdict.status).toBe('abstain');
    expect(verdict.status).not.toBe('exercised');
    expect(verdict.status).not.toBe('not-exercised');
  });

  it('keeps abstain distinct from no-probe: a probe did look', async () => {
    const verdict = await probeFile([exploding], 'ci.yml', OFFLINE_CTX);
    expect(verdict.status).not.toBe('no-probe');
  });

  it('names the probe and the failure in a full sentence', async () => {
    const verdict = await probeFile([exploding], 'ci.yml', OFFLINE_CTX);
    expect(verdict.explanation).toContain('workflow');
    expect(verdict.explanation).toContain('could not authenticate');
    expect(verdict.explanation.trimEnd().endsWith('.')).toBe(true);
  });

  it('does not abort the rest of the changed-file set', async () => {
    const files = ['a.yml', 'b.yml'];
    const verdicts = await probeAll([exploding], files, OFFLINE_CTX);
    expect(verdicts).toHaveLength(2);
    expect(verdicts.every((verdict) => verdict.status === 'abstain')).toBe(
      true,
    );
  });

  it('abstains when the probe rejects rather than throws', async () => {
    const rejecting: ExerciseProbe = {
      ...exploding,
      probe: () => Promise.reject(new Error('network unreachable')),
    };
    const verdict = await probeFile([rejecting], 'ci.yml', OFFLINE_CTX);
    expect(verdict.status).toBe('abstain');
  });
});
