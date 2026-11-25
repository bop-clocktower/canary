/**
 * canary-cry against a real Chromium (#608 P3; the cry-e2e workflow). Runs
 * only under `CANARY_CRY_E2E=1` (see vitest.config.ts) with
 * `CRY_E2E_PROJECT` naming a directory whose node_modules holds
 * `@playwright/test` and its Chromium -- the "target project" of spec D2.
 * canary-cry itself adds no Playwright dependency; the run dirs this suite
 * creates live under that directory so the generated specs resolve it.
 *
 * - SC11 the planted double-submit bug -> multi-submit `corrupted` with
 *        before/after values; the fixed variant -> `clean`
 * - SC12 the corrupted spec re-run standalone reproduces its fingerprint
 * - SC13 a request to an undeclared host is aborted and in findings.json
 * - SC14 a stale selector before the abuse point -> `abstain: flow-broken@`
 * - SC25 shared-machine names `account.A.email` as a cross-account leak, and
 *        no run artifact contains an account value
 * - #1720 token-expiry: the fixed shop refusing the unauthenticated write is
 *        `clean`; the buggy one half-completing the checkout is `corrupted`
 * plus every one of the six patterns runs to a verdict at intensity 1.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { executeRun } from '../../claude-code/canary-cry/scripts/execute.mjs';
import {
  buildManifest,
  manifestSha,
} from '../../claude-code/canary-cry/scripts/manifest.mjs';
import { buildMatrix } from '../../claude-code/canary-cry/scripts/matrix.mjs';
import { startApp } from '../fixtures/cry-app/server.mjs';

const run = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(
  HERE,
  '..',
  '..',
  'claude-code',
  'canary-cry',
  'scripts',
  'cli.mjs',
);
const PROJECT = process.env.CRY_E2E_PROJECT ?? '';

const USERS = {
  A: { email: 'alice.cry@example.test', password: 'pw-alice-5150', id: '101' },
  B: { email: 'bob.cry@example.test', password: 'pw-bob-8086', id: '202' },
};
const ENV = {
  ...process.env,
  CRY_E2E_A: JSON.stringify(USERS.A),
  CRY_E2E_B: JSON.stringify(USERS.B),
};
const SECRETS = [USERS.A.email, USERS.A.password, USERS.B.password];

// Split so no factory nests past the arch nestingDepth threshold (4).
function loginFlow(): any {
  return {
    id: 'login',
    risk: 1,
    steps: [
      { id: 'open', action: 'goto', url: '/login' },
      {
        id: 'email',
        action: 'fill',
        selector: '[name=email]',
        value: '{{account.A.email}}',
      },
      {
        id: 'password',
        action: 'fill',
        selector: '[name=password]',
        value: '{{account.A.password}}',
      },
      {
        id: 'submit',
        action: 'click',
        selector: 'button[type=submit]',
        awaitResponse: 'POST /api/session',
      },
    ],
  };
}

function logoutFlow(): any {
  return {
    id: 'logout',
    risk: 1,
    steps: [
      { id: 'open', action: 'goto', url: '/logout' },
      {
        id: 'sign-out',
        action: 'click',
        selector: '#sign-out',
        awaitResponse: 'POST /api/logout',
      },
    ],
  };
}

const countProbe = (id: string, table: string, delta = 1): any => ({
  id,
  probe: {
    http: { method: 'GET', path: `/api/${table}?user={{account.A.id}}` },
  },
  expect: { jsonPath: '$.length', delta },
});

function checkoutSteps(cardSelector: string): any[] {
  return [
    { id: 'open', action: 'goto', url: '/cart' },
    {
      id: 'address',
      action: 'click',
      selector: '#save-address',
      writes: true,
      awaitResponse: 'POST /api/addresses',
    },
    {
      id: 'card',
      action: 'fill',
      selector: cardSelector,
      value: '{{fixture.card}}',
    },
    {
      id: 'pay',
      action: 'click',
      selector: '#pay',
      writes: true,
      awaitResponse: 'POST /api/orders',
    },
  ];
}

function flowsDoc(cardSelector = '[name=card]'): any {
  return {
    version: 1,
    fixtures: { card: '4242424242424242' },
    flows: [
      loginFlow(),
      logoutFlow(),
      {
        id: 'checkout',
        risk: 5,
        steps: checkoutSteps(cardSelector),
        invariants: [
          countProbe('one-order', 'orders'),
          countProbe('one-address', 'addresses'),
          // Address + order: 2 per checkout, so half a checkout is visible.
          countProbe('one-checkout', 'checkout', 2),
        ],
        symptoms: { selectors: ['.error-banner'] },
      },
    ],
  };
}

function fixtureTarget(url: string): any {
  return {
    baseURL: url,
    environment: 'local',
    hosts: ['127.0.0.1'],
    accounts: { A: { env: 'CRY_E2E_A' }, B: { env: 'CRY_E2E_B' } },
    auth: {
      signIn: 'login',
      signOut: 'logout',
      sessionKeys: ['cookie:session'],
    },
  };
}

const targetsDoc = (url: string): any => ({
  version: 1,
  prodHosts: ['*.example.com'],
  targets: { fixture: fixtureTarget(url) },
});

const apps: { close: () => Promise<void> }[] = [];
let cases = '';

async function app(variant: 'buggy' | 'fixed') {
  const started = await startApp({ variant, users: [USERS.A, USERS.B] });
  apps.push(started);
  return started;
}

/** An adopter project under PROJECT, so specs resolve its Playwright. */
function project(name: string, url: string, flows = flowsDoc()) {
  const dir = fs.mkdtempSync(path.join(cases, `${name}-`));
  const cry = path.join(dir, '.canary', 'cry');
  fs.mkdirSync(cry, { recursive: true });
  fs.writeFileSync(path.join(cry, 'flows.json'), JSON.stringify(flows));
  fs.writeFileSync(
    path.join(cry, 'targets.json'),
    JSON.stringify(targetsDoc(url)),
  );
  return { dir, runs: path.join(cry, 'runs') };
}

async function cry(dir: string, args: string[]) {
  try {
    const r = await run(process.execPath, [CLI, ...args], {
      cwd: dir,
      env: ENV,
    });
    return { code: 0, stdout: r.stdout, stderr: r.stderr };
  } catch (exc: any) {
    return { code: exc.code, stdout: exc.stdout, stderr: exc.stderr };
  }
}

/** The two-step gate, as an operator runs it: read the sha, confirm it. */
async function confirmedRun(dir: string, extra: string[] = []) {
  const first = await cry(dir, ['run', '--live', 'fixture']);
  const sha = /manifest-sha: ([0-9a-f]{64})/.exec(first.stdout)?.[1];
  expect(sha, first.stdout + first.stderr).toBeDefined();
  return cry(dir, ['run', '--live', 'fixture', '--confirm', sha!, ...extra]);
}

/** The run dir holding findings.json (the confirmed one). */
function confirmedDir(runs: string): string {
  const dir = fs
    .readdirSync(runs)
    .map((id) => path.join(runs, id))
    .find((d) => fs.existsSync(path.join(d, 'findings.json')));
  expect(dir, `no findings.json under ${runs}`).toBeDefined();
  return dir!;
}

const findingsIn = (dir: string) =>
  JSON.parse(fs.readFileSync(path.join(dir, 'findings.json'), 'utf8'));

const byId = (doc: any, id: string) =>
  doc.scenarios.find((s: any) => s.id === id);

/** Every byte under dir, so an artifact grep cannot miss a file. */
function allText(dir: string): string {
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => fs.readFileSync(path.join(e.parentPath, e.name), 'utf8'))
    .join('\n');
}

function expectNoSecret(dir: string) {
  const text = allText(dir);
  for (const secret of SECRETS) expect(text).not.toContain(secret);
}

beforeAll(() => {
  const require = createRequire(path.join(PROJECT, 'noop.js'));
  expect(
    () => require.resolve('@playwright/test/cli'),
    'CRY_E2E_PROJECT must name a directory with @playwright/test installed',
  ).not.toThrow();
  cases = fs.mkdtempSync(path.join(PROJECT, 'cry-e2e-'));
});

afterAll(async () => {
  await Promise.all(apps.map((a) => a.close()));
  // CRY_E2E_KEEP=1 keeps the run dirs for a look after a failure.
  if (cases && process.env.CRY_E2E_KEEP !== '1') {
    fs.rmSync(cases, { recursive: true, force: true });
  }
});

const PAY = 'checkout:multi-submit:i1:spay';

describe('the planted double-submit bug (SC11, SC12, SC13)', () => {
  let dir = '';
  let doc: any;

  it('reports multi-submit corrupted with before/after values, and --strict exits 1', async () => {
    const p = project('buggy', (await app('buggy')).url);
    const r = await confirmedRun(p.dir, ['--strict']);
    expect(r.code, r.stdout + r.stderr).toBe(1);
    dir = confirmedDir(p.runs);
    doc = findingsIn(dir);
    expect(doc.format).toBe('canary.cry-findings/1');
    const pay = byId(doc, PAY);
    expect(pay.verdict).toBe('corrupted');
    expect(pay.fidelity).toBe('state-verified');
    const order = pay.invariants.find((i: any) => i.id === 'one-order');
    expect(order).toEqual(expect.objectContaining({ breached: true }));
    expect(order.after - order.before).toBe(2);
    expect(pay.fingerprints).toContain('checkout:multi-submit:one-order');
    expect(r.stdout).toContain('corrupted (state-verified)  ' + PAY);
    expectNoSecret(dir);
  });

  it('aborts and records the request to an undeclared host (SC13)', () => {
    expect(doc.blockedEgress).toContain('egress.cry-e2e.invalid');
    expect(byId(doc, PAY).blockedEgress).toContain('egress.cry-e2e.invalid');
  });

  it('re-running the emitted spec standalone reproduces the fingerprint (SC12)', async () => {
    const require = createRequire(path.join(PROJECT, 'noop.js'));
    const pw = require.resolve('@playwright/test/cli');
    const spec = byId(doc, PAY).repro.spec;
    const rerun = await run(
      process.execPath,
      [pw, 'test', '-c', 'playwright.config.mjs', spec],
      { cwd: dir, env: ENV },
    ).catch((exc: any) => exc);
    // A corrupted scenario fails its own Playwright test: it is a regression
    // test as well as a repro.
    expect(rerun.code).toBe(1);
    const obs = JSON.parse(
      fs.readFileSync(path.join(dir, byId(doc, PAY).repro.observation), 'utf8'),
    );
    expect(obs.verdict).toBe('corrupted');
    expect(obs.fingerprints).toEqual(byId(doc, PAY).fingerprints);
  });
});

describe('the fixed variant (SC11)', () => {
  it('reports every whisper scenario clean, and --strict exits 0', async () => {
    const p = project('fixed', (await app('fixed')).url);
    const r = await confirmedRun(p.dir, ['--strict']);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    const doc = findingsIn(confirmedDir(p.runs));
    expect(doc.scenarios.length).toBeGreaterThan(0);
    for (const s of doc.scenarios)
      expect([s.id, s.verdict]).toEqual([s.id, 'clean']);
  });
});

describe('a stale flows file (SC14)', () => {
  it('reports flow-broken at the step before the abuse point, never a finding', async () => {
    const flows = flowsDoc('[name=card-number-renamed]');
    const p = project('stale', (await app('buggy')).url, flows);
    await confirmedRun(p.dir);
    const pay = byId(findingsIn(confirmedDir(p.runs)), PAY);
    expect(pay.verdict).toBe('abstain');
    expect(pay.reason).toBe('flow-broken@card');
    expect(pay.fingerprints).toEqual([]);
  });
});

/**
 * The non-core patterns are scheduled only by `shout` and `scream`, whose
 * live rounds arrive with #608 P4. Their intensity-1 round is driven here
 * through the same executor a confirmed run uses.
 */
async function roundOne(variant: 'buggy' | 'fixed') {
  const url = (await app(variant)).url;
  const p = project(`round-${variant}`, url);
  const flows = flowsDoc();
  const target = { name: 'fixture', spec: fixtureTarget(url) };
  const all = buildMatrix({
    flows: flows.flows,
    amplitude: 'shout',
    seed: 0,
    target,
  });
  const matrix = {
    ...all,
    intensities: [1],
    scenarios: all.scenarios.filter((s: any) => s.intensity === 1),
  };
  const manifest = buildManifest({ flowsDoc: flows, target, matrix });
  const dir = path.join(p.runs, 'round-one');
  fs.mkdirSync(dir, { recursive: true });
  const plan = { manifest, matrix, sha: manifestSha(manifest) };
  await executeRun({ opts: { strict: false }, plan, dir, env: ENV });
  return { dir, doc: findingsIn(dir) };
}

const TOKEN_EXPIRY = 'checkout:token-expiry:i1:saddress';

describe('all six patterns at intensity 1, and the shared machine (SC25)', () => {
  let buggy: any;

  it('runs every pattern to a verdict', async () => {
    buggy = await roundOne('buggy');
    const patterns = new Set(buggy.doc.scenarios.map((s: any) => s.pattern));
    expect([...patterns].sort()).toEqual(
      [
        'abandon-midflow',
        'duplicate-tab',
        'multi-submit',
        'shared-machine',
        'stale-optimistic',
        'token-expiry',
      ].sort(),
    );
    for (const s of buggy.doc.scenarios) {
      expect([s.id, s.reason]).not.toEqual([s.id, 'runtime-error']);
      expect([s.id, s.reason]).not.toEqual([s.id, 'no-observation']);
    }
  });

  it.each([
    'checkout:duplicate-tab:i1:spay',
    'checkout:stale-optimistic:i1:spay',
    'checkout:abandon-midflow:i1:saddress',
    'checkout:duplicate-tab:i1:saddress',
    'checkout:multi-submit:i1:saddress',
  ])('catches the planted bug with %s', (id) => {
    expect(byId(buggy.doc, id).verdict).toBe('corrupted');
  });

  it('catches the half-completed checkout an expired session leaves (#1720)', () => {
    const expiry = byId(buggy.doc, TOKEN_EXPIRY);
    expect(expiry.verdict).toBe('corrupted');
    expect(expiry.fingerprints).toEqual(['checkout:token-expiry:one-checkout']);
    const whole = expiry.invariants.find((i: any) => i.id === 'one-checkout');
    expect(whole.after - whole.before).toBe(1);
  });

  it('names account.A.email as a cross-account leak, never its value', () => {
    const shared = byId(buggy.doc, 'checkout:shared-machine:i1:spay');
    expect(shared.verdict).toBe('symptom');
    expect(shared.signals).toContainEqual({
      kind: 'cross-account-leak',
      field: 'account.A.email',
    });
    expect(shared.fingerprints).toContain(
      'checkout:shared-machine:cross-account-leak',
    );
    expectNoSecret(buggy.dir);
  });

  it('the fixed variant leaks nothing and corrupts nothing it can guard', async () => {
    const fixed = await roundOne('fixed');
    const shared = byId(fixed.doc, 'checkout:shared-machine:i1:spay');
    expect(shared.verdict).toBe('clean');
    // #1720: a refused unauthenticated write is clean, not corrupted.
    const expiry = byId(fixed.doc, TOKEN_EXPIRY);
    expect(expiry.verdict).toBe('clean');
    const whole = expiry.invariants.find((i: any) => i.id === 'one-checkout');
    expect(whole.after - whole.before).toBe(0);
    for (const id of [
      'checkout:duplicate-tab:i1:spay',
      'checkout:duplicate-tab:i1:saddress',
      'checkout:stale-optimistic:i1:spay',
      'checkout:abandon-midflow:i1:saddress',
    ]) {
      expect([id, byId(fixed.doc, id).verdict]).toEqual([id, 'clean']);
    }
    expectNoSecret(fixed.dir);
  });
});
