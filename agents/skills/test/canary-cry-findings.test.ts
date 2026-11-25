/**
 * canary-cry findings.json and its text (#608 P3, spec "Outputs"). The
 * document is `canary.cry-findings/1`; the denominator is the confirmed
 * manifest's scenario list, so a scenario the browser never reported is an
 * abstention in the document, not a gap in it.
 */
import { describe, expect, it } from 'vitest';

import {
  buildFindings,
  renderFindings,
} from '../claude-code/canary-cry/scripts/findings.mjs';

const RUN = { id: 'r1', target: 'local', amplitude: 'whisper', seed: 0 };

const scenario = (id: string, score: number) => {
  const [flow, pattern, , step] = id.split(':');
  return { id, flow, pattern, intensity: 1, step: step!.slice(1), score };
};

const MANIFEST = {
  scenarios: [
    scenario('f:multi-submit:i1:sa', 25),
    scenario('f:multi-submit:i1:sb', 25),
    scenario('f:abandon-midflow:i1:sa', 20),
    scenario('g:multi-submit:i1:sx', 30),
  ],
};

function obs(verdict: string, over: Record<string, unknown> = {}) {
  return {
    verdict,
    reason: null,
    fidelity: verdict === 'symptom' ? 'observed' : 'state-verified',
    fingerprints: [],
    invariants: [],
    signals: [],
    blockedEgress: [],
    error: null,
    ...over,
  };
}

const observations = new Map<string, any>([
  [
    'f.multi-submit.i1.sa',
    obs('corrupted', {
      fingerprints: ['f:multi-submit:one'],
      invariants: [
        {
          id: 'one',
          before: 1,
          after: 3,
          breached: true,
          expect: { delta: 1 },
        },
        {
          id: 'two',
          before: 0,
          after: 0,
          breached: false,
          expect: { delta: 0 },
        },
      ],
      blockedEgress: ['b.test', 'a.test'],
    }),
  ],
  [
    'f.multi-submit.i1.sb',
    obs('abstain', {
      reason: 'probe-failed@one',
      fidelity: null,
      invariants: [{ id: 'one', error: 'HTTP 500', expect: { delta: 1 } }],
      blockedEgress: ['a.test'],
    }),
  ],
  [
    'g.multi-submit.i1.sx',
    obs('symptom', { fingerprints: ['g:multi-submit:pageerror'] }),
  ],
]);

describe('buildFindings', () => {
  const doc = buildFindings({ run: RUN, manifest: MANIFEST, observations });

  it('is canary.cry-findings/1 with the run, counts and every scenario', () => {
    expect(doc.format).toBe('canary.cry-findings/1');
    expect(doc.run).toEqual(RUN);
    expect(doc.status).toBe('ok');
    expect(doc.counts).toEqual({
      corrupted: 1,
      symptom: 1,
      clean: 0,
      abstain: 2,
    });
    expect(doc.scenarios.map((s: any) => s.id)).toEqual(
      MANIFEST.scenarios.map((s) => s.id),
    );
  });

  it('an unreported scenario abstains as no-observation', () => {
    const s = doc.scenarios.find(
      (x: any) => x.id === 'f:abandon-midflow:i1:sa',
    );
    expect(s).toEqual(
      expect.objectContaining({ verdict: 'abstain', reason: 'no-observation' }),
    );
  });

  it('collects fingerprints and blocked egress, unique and sorted', () => {
    expect(doc.fingerprints).toEqual([
      'f:multi-submit:one',
      'g:multi-submit:pageerror',
    ]);
    expect(doc.blockedEgress).toEqual(['a.test', 'b.test']);
  });

  it('gives each scenario its repro paths', () => {
    expect(doc.scenarios[0].repro).toEqual({
      spec: 'specs/f.multi-submit.i1.sa.spec.mjs',
      observation: 'observations/f.multi-submit.i1.sa.json',
    });
  });

  it('a run-level abstention overrides the status and keeps no scenario', () => {
    const d = buildFindings({
      run: RUN,
      manifest: MANIFEST,
      observations: null,
      abstainedReason: 'target unreachable (ECONNREFUSED)',
    });
    expect(d.status).toBe('abstained');
    expect(d.reason).toBe('target unreachable (ECONNREFUSED)');
    expect(d.scenarios).toEqual([]);
  });
});

describe('renderFindings', () => {
  const doc = buildFindings({ run: RUN, manifest: MANIFEST, observations });
  const text = renderFindings(doc, { dir: '/r', findings: '/r/findings.json' });
  const lines = text.split('\n');

  it('ranks by verdict (corrupted, symptom, abstain, clean), then score', () => {
    const heads = lines.filter((l) => /^ {2}\S/.test(l));
    expect(heads).toEqual([
      '  corrupted (state-verified)  f:multi-submit:i1:sa',
      '  symptom (observed)  g:multi-submit:i1:sx',
      '  abstain: probe-failed@one  f:multi-submit:i1:sb',
      '  abstain: no-observation  f:abandon-midflow:i1:sa',
    ]);
  });

  it('shows the breached invariant and the failed probe, not the quiet one', () => {
    expect(text).toContain(
      '      one: before 1 -> after 3 (expect {"delta":1})',
    );
    expect(text).toContain('      one: probe failed: HTTP 500');
    expect(text).not.toContain('two:');
  });

  it('names blocked egress, the counts, the findings file and the replay', () => {
    expect(text).toContain('blocked egress (aborted): a.test, b.test');
    expect(text).toContain('corrupted 1, symptom 1, clean 0, abstain 2');
    expect(text).toContain('findings: /r/findings.json');
    expect(text).toContain(
      'replay a scenario: cd /r && npx playwright test -c playwright.config.mjs',
    );
    expect(text).not.toContain('ABSTAINED');
  });
});

describe('how a run stopped (#608 P4)', () => {
  const rounds = [{ intensity: 1, fresh: [], abstained: false, barren: true }];

  it('records the stop and the rounds, and prints the convergence line', () => {
    const doc = buildFindings({
      run: RUN,
      manifest: MANIFEST,
      observations,
      stop: { reason: 'converged', line: 'converged after round 2', rounds },
    });
    expect(doc.status).toBe('ok');
    expect(doc.stop).toEqual({
      reason: 'converged',
      line: 'converged after round 2',
    });
    expect(doc.rounds).toEqual(rounds);
    const text = renderFindings(doc, { dir: '/r', findings: '/r/f.json' });
    expect(text.split('\n')).toContain('converged after round 2');
  });

  it('a wall stop is PARTIAL, never ok, and says how to resume', () => {
    const line = 'PARTIAL: 4/9 — resume with --resume r1';
    const doc = buildFindings({
      run: RUN,
      manifest: MANIFEST,
      observations,
      stop: { reason: 'partial', line, rounds },
    });
    expect(doc.status).toBe('partial');
    expect(doc.reason).toBe(line);
    const text = renderFindings(doc, { dir: '/r', findings: '/r/f.json' });
    expect(text.split('\n')).toContain(line);
    expect(text).not.toContain('ABSTAINED');
  });

  it('a run that never reached its rounds has no stop', () => {
    const doc = buildFindings({ run: RUN, manifest: MANIFEST, observations });
    expect(doc.stop).toBeNull();
    expect(doc.rounds).toEqual([]);
  });
});
