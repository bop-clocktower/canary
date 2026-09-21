// Unit suite for canary-misfit (#592) — E2E resilience injection at the
// Playwright route layer.
//
// Three things are worth pinning here and nothing else is: that the seeded
// decision is genuinely reproducible (the issue's whole design note), that a
// flow nothing was injected into never counts as evidence of resilience, and
// that the CLI's advisory/strict exit contract matches the family's.

import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  validateProfile,
  networkEnvelope,
  matchesGlob,
  decide,
  decisionKey,
  NETWORK_ENVELOPES,
  FAULT_KINDS,
} from '../claude-code/canary-misfit/scripts/profiles.mjs';
import { readFlows } from '../claude-code/canary-misfit/scripts/flows.mjs';
import {
  readLedger,
  classifyFlow,
  budgetFor,
  assessRun,
} from '../claude-code/canary-misfit/scripts/verdict.mjs';
import {
  buildArtifact,
  renderMarkdown,
  annotations,
  reproduceCommand,
  ABSTAINED_LINE,
} from '../claude-code/canary-misfit/scripts/report.mjs';
import { main } from '../claude-code/canary-misfit/scripts/cli.mjs';
import {
  createRouteHandler,
  appendLedger,
  loadProfileFile,
} from '../claude-code/canary-misfit/scripts/route_fixture/playwright-fixture.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.join(HERE, '..', 'claude-code', 'canary-misfit');

const tmps: string[] = [];
const mkTmp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'misfit-'));
  tmps.push(dir);
  return dir;
};
afterEach(() => {
  vi.restoreAllMocks();
  while (tmps.length) fs.rmSync(tmps.pop()!, { recursive: true, force: true });
});

const PROFILE = {
  schema_version: 1,
  name: 'flaky-upstream',
  seed: 1337,
  budget_ms: 5000,
  faults: [
    {
      id: 'api-latency',
      kind: 'latency',
      match: '**/api/**',
      rate: 0.5,
      delay_ms: 800,
    },
    {
      id: 'orders-5xx',
      kind: 'error',
      match: '**/api/orders*',
      rate: 0.2,
      status: 503,
    },
    { id: 'flaky-socket', kind: 'abort', match: '**/api/**', rate: 0.05 },
    { id: 'edge', kind: 'network', profile: 'slow-3g', rate: 1 },
  ],
};

// The skill runtimes are JSDoc-typed .mjs, so their exports surface as `object`
// here; these helpers are the one place that cast, rather than every call site.
const ok = (raw: unknown): any => {
  const { profile, errors } = validateProfile(raw);
  expect(errors).toEqual([]);
  return profile as any;
};

function writeProfile(dir: string, raw: unknown = PROFILE): string {
  const file = path.join(dir, 'profile.json');
  fs.writeFileSync(file, JSON.stringify(raw), 'utf8');
  return file;
}

/** A Playwright JSON report with one spec per supplied flow. */
function writeResults(
  dir: string,
  specs: { title: string; status: string; durations?: number[] }[],
): string {
  const file = path.join(dir, 'results.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      suites: [
        {
          file: 'tests/checkout.spec.ts',
          specs: specs.map((spec, i) => ({
            id: `spec-${i}`,
            title: spec.title,
            tests: [
              {
                results: (spec.durations ?? [10]).map((duration, r, all) => ({
                  duration,
                  status: r === all.length - 1 ? spec.status : 'failed',
                })),
              },
            ],
          })),
        },
      ],
    }),
    'utf8',
  );
  return file;
}

function writeLedger(dir: string, rows: unknown[]): string {
  const file = path.join(dir, 'ledger.jsonl');
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n'), 'utf8');
  return file;
}

const ledgerRow = (over: Record<string, unknown> = {}) => ({
  test_id: 'spec-0',
  test_title: 'checkout completes',
  fault_id: 'api-latency',
  kind: 'latency',
  method: 'GET',
  url: 'https://app.test/api/cart',
  ordinal: 0,
  action: 'delay',
  delay_ms: 800,
  ...over,
});

/** Call `main`, capturing everything it writes. */
function callMain(argv: string[]) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  vi.spyOn(console, 'log').mockImplementation(
    (...a: unknown[]) => void stdout.push(a.join(' ')),
  );
  vi.spyOn(console, 'error').mockImplementation(
    (...a: unknown[]) => void stderr.push(a.join(' ')),
  );
  const code = main(argv);
  vi.restoreAllMocks();
  return { code, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
}

// --- profile vocabulary + validation ---------------------------------------

describe('degradation profile', () => {
  it('accepts the documented profile and fills defaults', () => {
    const profile = ok(PROFILE);
    expect(profile.faults[2].rate).toBe(0.05);
    expect(profile.faults[2].match).toBe('**/api/**');
    expect(profile.faults[2].reason).toBe('failed');
    expect(profile.faults[3].envelope).toEqual(NETWORK_ENVELOPES['slow-3g']);
  });

  it('defaults an unstated match and rate to "everything, always"', () => {
    const profile = ok({
      schema_version: 1,
      seed: 1,
      faults: [{ id: 'a', kind: 'abort' }],
    });
    expect(profile.name).toBe('unnamed');
    expect(profile.budget_ms).toBeNull();
    expect(profile.faults[0].match).toBe('**');
    expect(profile.faults[0].rate).toBe(1);
    expect(profile.faults[0].burst).toBe(1);
  });

  it.each([
    [
      { schema_version: 2, seed: 1, faults: [{ id: 'a', kind: 'abort' }] },
      /schema_version must be 1/,
    ],
    [
      { schema_version: 1, seed: 1.5, faults: [{ id: 'a', kind: 'abort' }] },
      /seed must be an integer/,
    ],
    [
      { schema_version: 1, seed: 1, faults: [] },
      /faults must be a non-empty array/,
    ],
    [
      { schema_version: 1, seed: 1, faults: [{ id: 'a', kind: 'wobble' }] },
      /unknown kind "wobble"/,
    ],
    [
      {
        schema_version: 1,
        seed: 1,
        faults: [{ id: 'a', kind: 'abort', rate: 1.5 }],
      },
      /rate must be a number in 0\.\.1/,
    ],
    [
      {
        schema_version: 1,
        seed: 1,
        faults: [{ id: 'a', kind: 'network', profile: 'dial-up' }],
      },
      /unknown network profile "dial-up"/,
    ],
    [
      { schema_version: 1, seed: 1, faults: [{ id: 'a', kind: 'latency' }] },
      /latency requires a non-negative delay_ms/,
    ],
    [
      {
        schema_version: 1,
        seed: 1,
        faults: [{ id: 'a', kind: 'error', status: 200 }],
      },
      /error requires an integer status in 400\.\.599/,
    ],
    [
      {
        schema_version: 1,
        seed: 1,
        faults: [
          { id: 'a', kind: 'abort' },
          { id: 'a', kind: 'abort' },
        ],
      },
      /duplicate fault id "a"/,
    ],
    [
      {
        schema_version: 1,
        seed: 1,
        budget_ms: 0,
        faults: [{ id: 'a', kind: 'abort' }],
      },
      /budget_ms must be a positive number/,
    ],
    [
      { schema_version: 1, seed: 1, faults: [42] },
      /faults\[0\]: must be an object/,
    ],
    [
      { schema_version: 1, seed: 1, faults: [{ kind: 'abort' }] },
      /id must be a non-empty string/,
    ],
  ])('rejects a malformed profile (%#)', (raw, expected) => {
    const { profile, errors } = validateProfile(raw);
    expect(profile).toBeNull();
    expect(errors.join('\n')).toMatch(expected);
  });

  it('rejects a non-object profile', () => {
    expect(validateProfile('nope').errors).toEqual([
      'profile must be a JSON object',
    ]);
  });

  it('exposes four fault kinds and four network envelopes as the shared vocabulary', () => {
    // #858's load composer reads THIS table. A fifth field or a silent rename
    // here is a cross-layer break, so the names are pinned.
    expect(FAULT_KINDS).toEqual(['latency', 'error', 'abort', 'network']);
    expect(Object.keys(NETWORK_ENVELOPES)).toEqual([
      'slow-3g',
      'fast-3g',
      'regional-edge',
      'satellite',
    ]);
    for (const envelope of Object.values(NETWORK_ENVELOPES)) {
      expect(Object.keys(envelope).sort()).toEqual([
        'bandwidth_kbps',
        'jitter_ms',
        'latency_ms',
        'loss_rate',
      ]);
    }
    expect(networkEnvelope('nope')).toBeNull();
    expect(networkEnvelope('hasOwnProperty')).toBeNull();
  });
});

describe('glob matching', () => {
  it.each([
    ['**/api/**', 'https://app.test/api/cart', true],
    ['**/api/orders*', 'https://app.test/api/orders?id=1', true],
    ['**/api/orders*', 'https://app.test/api/cart', false],
    ['**', 'anything', true],
    ['/a?c', '/abc', true],
    ['/a?c', '/ac', false],
    ['**/static/*.js', 'https://app.test/static/app.js', true],
    ['**/static/*.js', 'https://app.test/static/deep/app.js', false],
  ])('%s vs %s', (pattern, url, expected) => {
    expect(matchesGlob(pattern as string, url as string)).toBe(expected);
  });
});

// --- the seeded decision ----------------------------------------------------

describe('seeded injection decision', () => {
  const request = {
    method: 'GET',
    url: 'https://app.test/api/cart',
    ordinal: 0,
  };

  it('is identical across calls for the same seed, and differs for another seed', () => {
    const profile = ok({ ...PROFILE, faults: [PROFILE.faults[0]] });
    const other = ok({
      ...PROFILE,
      seed: 20260917,
      faults: [PROFILE.faults[0]],
    });

    const runs = Array.from({ length: 50 }, (_, i) => ({
      method: 'GET',
      url: `https://app.test/api/item/${i}`,
      ordinal: 0,
    }));
    const first = runs.map((r) => Boolean(decide(profile, r)));
    const second = runs.map((r) => Boolean(decide(profile, r)));
    const reseeded = runs.map((r) => Boolean(decide(other, r)));

    expect(second).toEqual(first);
    expect(reseeded).not.toEqual(first);
    // A rate of 0.5 that fires for all 50 or none of them is a broken draw,
    // not a lucky seed.
    expect(first.filter(Boolean).length).toBeGreaterThan(5);
    expect(first.filter(Boolean).length).toBeLessThan(45);
  });

  it('does not depend on arrival order, only on request identity', () => {
    const profile = ok({ ...PROFILE, faults: [PROFILE.faults[0]] });
    const requests = Array.from({ length: 20 }, (_, i) => ({
      method: 'GET',
      url: `https://app.test/api/item/${i}`,
      ordinal: 0,
    }));
    const forwards = new Map(
      requests.map((r) => [r.url, Boolean(decide(profile, r))]),
    );
    const backwards = new Map(
      [...requests].reverse().map((r) => [r.url, Boolean(decide(profile, r))]),
    );
    expect([...backwards.entries()].sort()).toEqual(
      [...forwards.entries()].sort(),
    );
  });

  it('distinguishes repeat calls to the same URL by ordinal', () => {
    expect(decisionKey(7, 'f', request)).not.toBe(
      decisionKey(7, 'f', { ...request, ordinal: 1 }),
    );
    expect(decisionKey(7, 'f', { method: 'GET', url: 'u' })).toContain('#0');
  });

  it('rate 0 never fires and rate 1 always fires', () => {
    const never = ok({
      schema_version: 1,
      seed: 3,
      faults: [{ id: 'n', kind: 'abort', rate: 0 }],
    });
    const always = ok({
      schema_version: 1,
      seed: 3,
      faults: [{ id: 'a', kind: 'abort', rate: 1 }],
    });
    expect(decide(never, request)).toBeNull();
    expect(decide(always, request)!.action).toEqual({
      type: 'abort',
      reason: 'failed',
    });
  });

  it('returns null when nothing matches the URL', () => {
    const profile = ok({
      schema_version: 1,
      seed: 3,
      faults: [{ id: 'a', kind: 'abort', match: '**/admin/**' }],
    });
    expect(decide(profile, request)).toBeNull();
  });

  it('maps each kind onto the action the injector performs', () => {
    const profile = ok({
      schema_version: 1,
      seed: 3,
      faults: [
        { id: 'l', kind: 'latency', match: '**/l', delay_ms: 120 },
        { id: 'e', kind: 'error', match: '**/e', status: 503, burst: 3 },
        { id: 'n', kind: 'network', match: '**/n', profile: 'satellite' },
      ],
    });
    const act = (url: string) =>
      decide(profile, { method: 'GET', url, ordinal: 0 })!.action;
    expect(act('/l')).toEqual({ type: 'delay', delay_ms: 120 });
    expect(act('/e')).toEqual({
      type: 'fulfill',
      status: 503,
      burst: 3,
      burst_index: 0,
    });
    expect(act('/n')).toEqual({
      type: 'delay',
      delay_ms:
        NETWORK_ENVELOPES.satellite.latency_ms +
        NETWORK_ENVELOPES.satellite.jitter_ms,
      envelope: NETWORK_ENVELOPES.satellite,
    });
  });

  it('takes the first matching fault in declaration order', () => {
    const profile = ok({
      schema_version: 1,
      seed: 3,
      faults: [
        { id: 'first', kind: 'abort', match: '**' },
        { id: 'second', kind: 'latency', match: '**', delay_ms: 1 },
      ],
    });
    expect((decide(profile, request) as any).fault.id).toBe('first');
  });

  // Seed 16 at rate 0.2 fires for ordinal 0 of this identity and for no
  // ordinal after it, which is what makes the burst the only thing that can
  // explain a second or third injection below.
  const BURSTY = {
    schema_version: 1,
    seed: 16,
    faults: [
      {
        id: 'orders-5xx',
        kind: 'error',
        match: '**',
        rate: 0.2,
        status: 503,
      },
    ],
  };
  const ordersAt = (profile: any, ordinal: number) =>
    decide(profile, {
      method: 'GET',
      url: 'https://app.test/api/orders',
      ordinal,
    });

  it('fires a declared burst for that many consecutive ordinals', () => {
    const single = ok(BURSTY);
    const bursty = ok({
      ...BURSTY,
      faults: [{ ...BURSTY.faults[0], burst: 3 }],
    });
    const fired = (profile: any) =>
      Array.from({ length: 6 }, (_, o) => Boolean(ordersAt(profile, o)));

    // Without a burst the roll that came up is the only injection.
    expect(fired(single)).toEqual([true, false, false, false, false, false]);
    // burst: 3 means THREE responses in total, the fired one plus two more.
    expect(fired(bursty)).toEqual([true, true, true, false, false, false]);
    expect(
      Array.from(
        { length: 3 },
        (_, o) => (ordersAt(bursty, o) as any).action.burst_index,
      ),
    ).toEqual([0, 1, 2]);
  });

  it('resolves a burst without depending on arrival order', () => {
    const bursty = ok({
      ...BURSTY,
      faults: [{ ...BURSTY.faults[0], burst: 3 }],
    });
    const ordinals = [0, 1, 2, 3, 4, 5];
    const forwards = ordinals.map((o) => Boolean(ordersAt(bursty, o)));
    const backwards = [...ordinals]
      .reverse()
      .map((o) => Boolean(ordersAt(bursty, o)))
      .reverse();
    expect(backwards).toEqual(forwards);
    // ...and the same seed reproduces it on a second pass.
    expect(ordinals.map((o) => Boolean(ordersAt(bursty, o)))).toEqual(forwards);
  });

  it('never fires a burst off a rate-0 fault', () => {
    const never = ok({
      schema_version: 1,
      seed: 16,
      faults: [{ id: 'n', kind: 'error', rate: 0, status: 503, burst: 5 }],
    });
    expect([0, 1, 2, 3].map((o) => ordersAt(never, o))).toEqual([
      null,
      null,
      null,
      null,
    ]);
  });
});

// --- verdicts ---------------------------------------------------------------

describe('verdict classification', () => {
  const flow = {
    id: 'spec-0',
    title: 't',
    file: 'f',
    status: 'passed',
    duration_ms: 100,
    retries: 0,
  };
  const profile = ok(PROFILE);

  it('calls an untouched flow unexercised, never graceful', () => {
    expect(classifyFlow(flow, [], profile).verdict).toBe('unexercised');
  });

  it('calls a failed flow shattered', () => {
    expect(
      classifyFlow({ ...flow, status: 'timedOut' }, [ledgerRow()], profile),
    ).toMatchObject({
      verdict: 'shattered',
    });
  });

  it('calls a retried pass degraded', () => {
    const result = classifyFlow(
      { ...flow, retries: 2 },
      [ledgerRow()],
      profile,
    );
    expect(result.verdict).toBe('degraded');
    expect(result.why).toMatch(/2 retry/);
  });

  it('calls an over-budget pass degraded', () => {
    const result = classifyFlow(
      { ...flow, duration_ms: 9000 },
      [ledgerRow()],
      profile,
    );
    expect(result.verdict).toBe('degraded');
    expect(result.why).toMatch(/over the 5000ms budget/);
  });

  it('calls a fast, single-attempt pass graceful', () => {
    expect(classifyFlow(flow, [ledgerRow()], profile).verdict).toBe('graceful');
  });

  it('falls back to twice the injected delay when the profile states no budget', () => {
    const budgetless = ok({ ...PROFILE, budget_ms: undefined });
    expect(budgetFor(budgetless, [ledgerRow({ delay_ms: 800 })])).toBe(1600);
    expect(budgetFor(budgetless, [ledgerRow({ delay_ms: 0 })])).toBeNull();
    // No budget at all: a pass is graceful rather than silently degraded.
    expect(
      classifyFlow(
        { ...flow, duration_ms: 1e6 },
        [ledgerRow({ delay_ms: 0 })],
        budgetless,
      ).verdict,
    ).toBe('graceful');
  });
});

describe('assessRun', () => {
  it('excludes unexercised flows from the denominator and abstains at zero', () => {
    const dir = mkTmp();
    const flows = readFlows(
      writeResults(dir, [
        { title: 'checkout completes', status: 'passed' },
        { title: 'search works', status: 'passed' },
      ]),
    );
    const clean = assessRun({ flows, ledger: [], profile: ok(PROFILE) });
    expect(clean.exercised).toBe(0);
    expect(clean.abstained).toBe(true);
    expect(clean.counts.graceful).toBe(0);
    expect(clean.counts.unexercised).toBe(2);

    const exercised = assessRun({
      flows,
      ledger: [ledgerRow()],
      profile: ok(PROFILE),
    });
    expect(exercised.exercised).toBe(1);
    expect(exercised.abstained).toBe(false);
    expect(exercised.counts.graceful).toBe(1);
  });

  it('matches ledger rows by test title when the id does not line up', () => {
    const dir = mkTmp();
    const flows = readFlows(
      writeResults(dir, [{ title: 'checkout completes', status: 'failed' }]),
    );
    const run = assessRun({
      flows,
      ledger: [ledgerRow({ test_id: 'a-different-id' })],
      profile: ok(PROFILE),
    });
    expect(run.counts.shattered).toBe(1);
    expect(run.flows[0].faults).toEqual(['api-latency']);
  });

  it('orders flows worst-first', () => {
    const dir = mkTmp();
    const flows = readFlows(
      writeResults(dir, [
        { title: 'a graceful flow', status: 'passed' },
        { title: 'b shattered flow', status: 'failed' },
      ]),
    );
    const run = assessRun({
      flows,
      ledger: [
        ledgerRow({ test_title: 'a graceful flow', test_id: 'spec-0' }),
        ledgerRow({ test_title: 'b shattered flow', test_id: 'spec-1' }),
      ],
      profile: ok(PROFILE),
    });
    expect(run.flows.map((f: any) => f.verdict)).toEqual([
      'shattered',
      'graceful',
    ]);
  });
});

describe('readFlows / readLedger', () => {
  it('reads nested suites, retries and durations', () => {
    const dir = mkTmp();
    const file = writeResults(dir, [
      { title: 'retried', status: 'passed', durations: [10, 20, 30] },
    ]);
    const [flow] = readFlows(file);
    expect(flow).toMatchObject({
      title: 'retried',
      status: 'passed',
      duration_ms: 60,
      retries: 2,
      file: 'tests/checkout.spec.ts',
    });
  });

  it('strips a leading banner and rejects junk loudly', () => {
    const dir = mkTmp();
    const banner = path.join(dir, 'banner.json');
    fs.writeFileSync(banner, 'Running 1 test\n{"suites":[]}', 'utf8');
    expect(readFlows(banner)).toEqual([]);

    const junk = path.join(dir, 'junk.json');
    fs.writeFileSync(junk, '{oops', 'utf8');
    expect(() => readFlows(junk)).toThrow(/not valid JSON/);

    const scalar = path.join(dir, 'scalar.json');
    fs.writeFileSync(scalar, '42', 'utf8');
    expect(() => readFlows(scalar)).toThrow(
      /top-level value must be an object/,
    );

    expect(() => readFlows(path.join(dir, 'nope.json'))).toThrow(
      /results file not found/,
    );
  });

  it('survives a spec with no results and a suite with no specs', () => {
    const dir = mkTmp();
    const file = path.join(dir, 'odd.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        suites: [
          {
            file: 'a.spec.ts',
            suites: [{ specs: [{ title: 'no runs', tests: [] }] }],
          },
          'not-a-suite',
        ],
      }),
      'utf8',
    );
    const [flow] = readFlows(file);
    expect(flow).toMatchObject({
      title: 'no runs',
      status: 'unknown',
      retries: 0,
    });
    expect(flow.id).toBe('a.spec.ts:no runs');
  });

  it('keeps the rows a truncated ledger did preserve', () => {
    const dir = mkTmp();
    const file = path.join(dir, 'l.jsonl');
    fs.writeFileSync(
      file,
      `${JSON.stringify(ledgerRow())}\n{"truncated"`,
      'utf8',
    );
    expect(readLedger(file)).toHaveLength(1);
    expect(readLedger(path.join(dir, 'absent.jsonl'))).toEqual([]);
    expect(readLedger(null)).toEqual([]);
  });

  it('drops ledger rows with no test id', () => {
    const dir = mkTmp();
    expect(
      readLedger(writeLedger(dir, [{ fault_id: 'x' }, ledgerRow()])),
    ).toHaveLength(1);
  });
});

// --- report -----------------------------------------------------------------

describe('report', () => {
  const dir0 = () => mkTmp();

  const artifactFor = (
    statuses: { title: string; status: string }[],
    ledger: unknown[],
  ) => {
    const dir = dir0();
    const flows = readFlows(writeResults(dir, statuses));
    const assessment = assessRun({ flows, ledger, profile: ok(PROFILE) });
    return buildArtifact({
      profile: ok(PROFILE),
      profilePath: 'misfit/p.json',
      assessment,
      producer: 'playwright',
    });
  };

  it('always carries the seed and a reproduce command', () => {
    const artifact = artifactFor(
      [{ title: 'a', status: 'passed' }],
      [ledgerRow()],
    );
    expect(artifact.profile.seed).toBe(1337);
    expect(artifact.reproduce).toContain('--seed 1337');
    expect(renderMarkdown(artifact)).toContain(artifact.reproduce);
    expect(reproduceCommand({ profilePath: 'p.json', seed: 9 })).toContain(
      '--profile p.json',
    );
  });

  it('prints the abstention instead of a reassuring table', () => {
    const artifact = artifactFor([{ title: 'a', status: 'passed' }], []);
    const markdown = renderMarkdown(artifact);
    expect(markdown).toContain(ABSTAINED_LINE);
    expect(markdown).not.toContain('| Flow | Verdict |');
    expect(annotations(artifact)).toEqual([`::warning::${ABSTAINED_LINE}`]);
  });

  it('annotates each shattered flow', () => {
    const artifact = artifactFor(
      [
        { title: 'a', status: 'failed' },
        { title: 'b', status: 'passed' },
      ],
      [
        ledgerRow({ test_id: 'spec-0' }),
        ledgerRow({ test_id: 'spec-1', test_title: 'b' }),
      ],
    );
    const notes = annotations(artifact);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('"a" shattered');
    expect(renderMarkdown(artifact)).toContain('| a | shattered |');
  });
});

// --- route fixture ----------------------------------------------------------

describe('route fixture', () => {
  const fakeRequest = (url: string, method = 'GET') => ({
    url: () => url,
    method: () => method,
  });

  const fakeRoute = () => {
    const calls: { kind: string; arg?: unknown }[] = [];
    return {
      calls,
      continue: async () => void calls.push({ kind: 'continue' }),
      abort: async (reason: string) =>
        void calls.push({ kind: 'abort', arg: reason }),
      fulfill: async (opts: unknown) =>
        void calls.push({ kind: 'fulfill', arg: opts }),
    };
  };

  it('continues an unmatched request and writes no ledger row', async () => {
    const dir = mkTmp();
    const ledgerPath = path.join(dir, 'ledger.jsonl');
    const handler = createRouteHandler({
      profile: ok({
        schema_version: 1,
        seed: 1,
        faults: [{ id: 'a', kind: 'abort', match: '**/admin/**' }],
      }),
      ledgerPath,
      flow: { id: 'f', title: 't', file: 'x.spec.ts' },
    });
    const route = fakeRoute();
    await handler(route, fakeRequest('https://app.test/api/cart'));
    expect(route.calls).toEqual([{ kind: 'continue' }]);
    expect(fs.existsSync(ledgerPath)).toBe(false);
  });

  it('aborts, fulfils and delays, recording each in the ledger', async () => {
    const dir = mkTmp();
    const ledgerPath = path.join(dir, 'nested', 'ledger.jsonl');
    const profile = ok({
      schema_version: 1,
      seed: 1,
      faults: [
        {
          id: 'abrt',
          kind: 'abort',
          match: '**/abort',
          reason: 'connectionreset',
        },
        { id: 'five', kind: 'error', match: '**/five', status: 503 },
        { id: 'slow', kind: 'latency', match: '**/slow', delay_ms: 0 },
      ],
    });
    const handler = createRouteHandler({
      profile,
      ledgerPath,
      flow: { id: 'f', title: 't', file: 'x.spec.ts' },
    });
    const route = fakeRoute();
    for (const url of ['/abort', '/five', '/slow']) {
      await handler(route, fakeRequest(`https://app.test${url}`));
    }
    expect(route.calls.map((c) => c.kind)).toEqual([
      'abort',
      'fulfill',
      'continue',
    ]);
    expect(route.calls[0].arg).toBe('connectionreset');

    const rows = readLedger(ledgerPath);
    expect(rows.map((r: any) => r.fault_id)).toEqual(['abrt', 'five', 'slow']);
    expect(rows[1].status).toBe(503);
    expect(rows[2].delay_ms).toBe(0);
  });

  it('increments the ordinal for repeat calls to the same URL', async () => {
    const dir = mkTmp();
    const ledgerPath = path.join(dir, 'ledger.jsonl');
    const handler = createRouteHandler({
      profile: ok({
        schema_version: 1,
        seed: 1,
        faults: [{ id: 'a', kind: 'abort' }],
      }),
      ledgerPath,
      flow: { id: 'f', title: 't', file: 'x.spec.ts' },
    });
    const route = fakeRoute();
    await handler(route, fakeRequest('https://app.test/a'));
    await handler(route, fakeRequest('https://app.test/a'));
    expect(readLedger(ledgerPath).map((r: any) => r.ordinal)).toEqual([0, 1]);
  });

  // The bug this guards (review of PR #1042): `burst` was validated,
  // normalized, carried into the action and documented in four places, and
  // nothing ever read it. A profile asking for three 5xx got one, the flow
  // survived, and the report printed `graceful` -- a resilience verdict earned
  // against a fault that was mostly never applied. So this asserts the
  // RESPONSES the caller observes, not that the field reached the action.
  const burstProfile = (over: Record<string, unknown> = {}) => ({
    schema_version: 1,
    seed: 16,
    faults: [
      {
        id: 'orders-5xx',
        kind: 'error',
        match: '**',
        rate: 0.2,
        status: 503,
        ...over,
      },
    ],
  });

  const replay = async (raw: unknown, times: number) => {
    const ledgerPath = path.join(mkTmp(), 'ledger.jsonl');
    const handler = createRouteHandler({
      profile: ok(raw),
      ledgerPath,
      flow: { id: 'f', title: 't', file: 'x.spec.ts' },
    });
    const route = fakeRoute();
    for (let i = 0; i < times; i += 1) {
      await handler(route, fakeRequest('https://app.test/api/orders'));
    }
    return { calls: route.calls, rows: readLedger(ledgerPath) as any[] };
  };

  it('serves a declared burst as that many consecutive fulfilled responses', async () => {
    const bursty = await replay(burstProfile({ burst: 3 }), 6);
    expect(bursty.calls.map((c) => c.kind)).toEqual([
      'fulfill',
      'fulfill',
      'fulfill',
      'continue',
      'continue',
      'continue',
    ]);
    for (const call of bursty.calls.slice(0, 3)) {
      expect((call.arg as any).status).toBe(503);
    }
    expect(bursty.rows.map((r) => r.burst_index)).toEqual([0, 1, 2]);
    expect(bursty.rows.map((r) => r.ordinal)).toEqual([0, 1, 2]);
  });

  it('serves exactly one response when no burst is declared', async () => {
    // Same seed, same rate, same identities: the ONLY difference from the case
    // above is the declared burst, so the burst is the only thing that can
    // explain the extra two fulfils there.
    const single = await replay(burstProfile(), 6);
    expect(single.calls.map((c) => c.kind)).toEqual([
      'fulfill',
      'continue',
      'continue',
      'continue',
      'continue',
      'continue',
    ]);
    expect(single.rows.map((r) => r.burst_index)).toEqual([0]);
    const explicitOne = await replay(burstProfile({ burst: 1 }), 6);
    expect(explicitOne.calls.map((c) => c.kind)).toEqual(
      single.calls.map((c) => c.kind),
    );
  });

  it('never fails the run because the ledger could not be written', () => {
    // A directory where the file should be: appendFileSync throws EISDIR.
    const dir = mkTmp();
    fs.mkdirSync(path.join(dir, 'ledger.jsonl'));
    expect(() =>
      appendLedger(path.join(dir, 'ledger.jsonl'), { a: 1 }),
    ).not.toThrow();
  });

  it('refuses an invalid profile file with every error at once', () => {
    const dir = mkTmp();
    const bad = writeProfile(dir, { schema_version: 9, seed: 'x', faults: [] });
    expect(() => loadProfileFile(bad)).toThrow(/invalid profile/);
    expect((loadProfileFile(writeProfile(dir)) as any).name).toBe(
      'flaky-upstream',
    );
  });
});

// --- CLI --------------------------------------------------------------------

describe('canary-misfit CLI', () => {
  it('resolves and prints the profile when no --results is given', () => {
    const dir = mkTmp();
    const res = callMain(['--profile', writeProfile(dir)]);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('profile "flaky-upstream", seed 1337');
    expect(res.stdout).toContain('edge: network slow-3g');
    expect(res.stdout).toContain('nothing was assessed');
  });

  it('reports a bad profile as an error, not as a clean run', () => {
    const dir = mkTmp();
    const res = callMain([
      '--profile',
      writeProfile(dir, { schema_version: 3, seed: 1, faults: [] }),
    ]);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('schema_version must be 1');
    expect(res.stdout).toBe('');
  });

  it('reports an unreadable profile path as an error', () => {
    const res = callMain(['--profile', path.join(mkTmp(), 'missing.json')]);
    expect(res.code).toBe(1);
    expect(res.stderr).toMatch(/cannot read profile/);
  });

  it('reports an unreadable results file as an error', () => {
    const dir = mkTmp();
    const res = callMain([
      '--profile',
      writeProfile(dir),
      '--results',
      path.join(dir, 'missing.json'),
    ]);
    expect(res.code).toBe(1);
    expect(res.stderr).toMatch(/results file not found/);
  });

  it('is advisory by default even when a flow shattered', () => {
    const dir = mkTmp();
    const res = callMain([
      '--profile',
      writeProfile(dir),
      '--results',
      writeResults(dir, [{ title: 'checkout completes', status: 'failed' }]),
      '--ledger',
      writeLedger(dir, [ledgerRow()]),
    ]);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('shattered');
  });

  it('exits 1 under --strict when a flow shattered, 0 when none did', () => {
    const dir = mkTmp();
    const argv = (status: string) => [
      '--profile',
      writeProfile(dir),
      '--results',
      writeResults(dir, [{ title: 'checkout completes', status }]),
      '--ledger',
      writeLedger(dir, [ledgerRow()]),
      '--strict',
    ];
    expect(callMain(argv('failed')).code).toBe(1);
    expect(callMain(argv('passed')).code).toBe(0);
  });

  it('honours --seed as an override of the profile seed', () => {
    const dir = mkTmp();
    const res = callMain([
      '--profile',
      writeProfile(dir),
      '--results',
      writeResults(dir, [{ title: 'a', status: 'passed' }]),
      '--ledger',
      writeLedger(dir, [ledgerRow()]),
      '--seed',
      '42',
      '--json',
    ]);
    expect(JSON.parse(res.stdout.split('\n::')[0]).profile.seed).toBe(42);
  });

  it('writes the markdown report to --out', () => {
    const dir = mkTmp();
    const out = path.join(dir, 'nested', 'misfit.md');
    const res = callMain([
      '--profile',
      writeProfile(dir),
      '--results',
      writeResults(dir, [{ title: 'a', status: 'passed' }]),
      '--ledger',
      writeLedger(dir, [ledgerRow()]),
      '--out',
      out,
    ]);
    expect(res.code).toBe(0);
    expect(fs.readFileSync(out, 'utf8')).toContain(
      'canary-misfit — resilience verdicts',
    );
  });

  it('reports an unwritable --out as an error', () => {
    const dir = mkTmp();
    const out = path.join(dir, 'report-dir');
    fs.mkdirSync(out);
    const res = callMain([
      '--profile',
      writeProfile(dir),
      '--results',
      writeResults(dir, [{ title: 'a', status: 'passed' }]),
      '--ledger',
      writeLedger(dir, [ledgerRow()]),
      '--out',
      out,
    ]);
    expect(res.code).toBe(1);
    expect(res.stderr).toMatch(/cannot write report/);
  });

  it('warns on stdout when a --json run abstained', () => {
    const dir = mkTmp();
    const res = callMain([
      '--profile',
      writeProfile(dir),
      '--results',
      writeResults(dir, [{ title: 'a', status: 'passed' }]),
      '--json',
    ]);
    expect(res.stdout).toContain('::warning::');
    expect(res.stdout).toContain(ABSTAINED_LINE);
  });

  it('runs end to end as a subprocess (the way the skill runner execs it)', () => {
    const dir = mkTmp();
    const proc = spawnSync(
      process.execPath,
      [
        path.join(SKILL_DIR, 'scripts', 'cli.mjs'),
        '--profile',
        writeProfile(dir),
        '--results',
        writeResults(dir, [{ title: 'checkout completes', status: 'failed' }]),
        '--ledger',
        writeLedger(dir, [ledgerRow()]),
        '--strict',
      ],
      { encoding: 'utf8' },
    );
    expect(proc.status).toBe(1);
    expect(proc.stdout).toContain('shattered');
  });
});

describe('SKILL.md', () => {
  it('declares the cli entry point and the node requirement', () => {
    const head = fs.readFileSync(path.join(SKILL_DIR, 'SKILL.md'), 'utf8');
    expect(head).toContain('name: canary-misfit');
    expect(head).toContain('cli: scripts/cli.mjs');
    expect(head).toContain('requires: [node>=20]');
  });

  it('carries the harness-chaos precondition, not just the invocation', () => {
    // The precondition is the whole reason this report can be trusted: run
    // against a system with no resilience behaviour and every flow shatters.
    const text = fs.readFileSync(path.join(SKILL_DIR, 'SKILL.md'), 'utf8');
    expect(text).toMatch(/no resilience mechanisms\s+implemented/);
    expect(text).toMatch(/harness-chaos/);
  });
});
