/**
 * Shared harness for canary-cry's offline run suites (#608 P3, P4): an
 * adopter-shaped project, `main()` with console captured, the two-step gate,
 * and Playwright stubbed one scenario at a time -- what a real run leaves
 * behind (its own report where the executor's env var says, and the
 * runtime's observation), with nothing launched.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { main } from '../../../claude-code/canary-cry/scripts/cli.mjs';
import { RESULTS_ENV } from '../../../claude-code/canary-cry/scripts/codegen.mjs';

const NOW = () => new Date('2026-11-25T14:33:33.123Z');
export const SECRET = 'pw-planted-5150';
export const ACCOUNT = JSON.stringify({
  email: 'a@x.test',
  password: SECRET,
  id: 7,
});
const ENV = { CRY_A: ACCOUNT };
export const PAY = 'checkout:multi-submit:i1:spay';
export const STEM = 'checkout.multi-submit.i1.spay';

const tmps: string[] = [];

/** Remove every project made since the last call (an afterEach). */
export function cleanup() {
  while (tmps.length) fs.rmSync(tmps.pop()!, { recursive: true, force: true });
}

/**
 * One writes step, so whisper schedules 1 scenario (multi-submit) and shout
 * and scream 2 per round (multi-submit, duplicate-tab).
 */
function checkoutFlow(invariants: any[]): any {
  return {
    id: 'checkout',
    risk: 5,
    steps: [
      { id: 'open', action: 'goto', url: '/cart' },
      { id: 'pay', action: 'click', selector: '#p', writes: true },
    ],
    invariants,
  };
}

const ONE_ORDER = {
  id: 'one-order',
  probe: { http: { method: 'GET', path: '/api/orders' } },
  expect: { jsonPath: '$.length', delta: 1 },
};

function targetsDoc(baseURL: string): any {
  const local = {
    baseURL,
    environment: 'local',
    hosts: ['127.0.0.1'],
    accounts: { A: { env: 'CRY_A' } },
  };
  return { version: 1, prodHosts: [], targets: { local } };
}

export interface Project {
  runs: string;
  flows: string;
  args: string[];
}

export function project(
  baseURL = 'http://127.0.0.1:9',
  invariants = [ONE_ORDER],
): Project {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-cry-exec-'));
  tmps.push(dir);
  const cry = path.join(dir, '.canary', 'cry');
  fs.mkdirSync(cry, { recursive: true });
  const f = path.join(cry, 'flows.json');
  const t = path.join(cry, 'targets.json');
  const flows = { version: 1, flows: [checkoutFlow(invariants)] };
  fs.writeFileSync(f, JSON.stringify(flows));
  fs.writeFileSync(t, JSON.stringify(targetsDoc(baseURL)));
  return {
    runs: path.join(cry, 'runs'),
    flows: f,
    args: ['--flows', f, '--targets', t],
  };
}

/** An observation the runtime would write for one scenario. */
export function observation(
  verdict: string,
  over: Record<string, unknown> = {},
) {
  return {
    id: PAY,
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

/** A clean observation with one checked invariant. */
export const CLEAN = observation('clean', {
  invariants: [{ id: 'one-order', before: 0, after: 1, breached: false }],
});

export interface Seen {
  calls: any[];
}

type Obs = object | null | ((stem: string) => object | null);

/** How many results checkpoint.json held when a scenario started. */
function checkpointed(dir: string): number | null {
  const file = path.join(dir, 'checkpoint.json');
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8')).results.length;
}

/** A one-spec Playwright JSON report. */
const pwReport = (title: string) => ({
  config: {},
  suites: [{ title }],
  errors: [],
  stats: { startTime: 't', duration: 1, expected: 1, skipped: 0 },
});

/**
 * Playwright stubbed: one `run` per scenario (#608 P4). `obs` may vary by
 * scenario file stem; `results: false` leaves no report (a crash); `tick`
 * runs on every launch (a test clock advancing).
 */
export function fakePw(seen: Seen, obs: Obs, results = true, tick = () => {}) {
  return {
    resolve: () => '/fake/@playwright/test/cli.js',
    preflight: async () => ({ ok: true, detail: 'HTTP 200' }),
    run: async (args: any) => {
      const dir = path.dirname(args.config);
      const report = args.env[RESULTS_ENV];
      const stem = path.basename(report, '.json');
      seen.calls.push({ ...args, stem, checkpointed: checkpointed(dir) });
      tick();
      if (results) {
        fs.mkdirSync(path.dirname(report), { recursive: true });
        fs.writeFileSync(report, JSON.stringify(pwReport(stem)));
      }
      const o = typeof obs === 'function' ? obs(stem) : obs;
      if (o !== null) {
        fs.mkdirSync(path.join(dir, 'observations'), { recursive: true });
        const file = path.join(dir, 'observations', `${stem}.json`);
        fs.writeFileSync(file, JSON.stringify({ ...o, id: stem }));
      }
      // runPlaywright already keeps only the last 20 (canary-cry-codegen).
      const stderr = Array.from({ length: 20 }, (_, i) => `err ${i}`);
      return { code: results ? 0 : 1, stderr };
    },
  };
}

/** A clock a test moves: `now` for main(), `advance` from a fake launch. */
export function testClock(start = NOW().getTime()) {
  let t = start;
  return {
    now: () => new Date(t),
    advance: (ms: number) => {
      t += ms;
    },
  };
}

/**
 * main() with console.log / console.error captured. Restored by hand, not by
 * vi.spyOn, so this helper imports no test framework of its own.
 */
export async function cry(argv: string[], pw?: object, now = NOW) {
  const out: string[] = [];
  const err: string[] = [];
  const { log, error } = console;
  console.log = (...a: unknown[]) => void out.push(a.join(' '));
  console.error = (...a: unknown[]) => void err.push(a.join(' '));
  try {
    const code = await main(argv, { env: ENV, now, pw });
    return { code, stdout: out.join('\n'), stderr: err.join('\n') };
  } finally {
    console.log = log;
    console.error = error;
  }
}

/** The manifest-sha a `run --live` (no --confirm) prints. */
export async function readSha(p: Project, extra: string[] = []) {
  const first = await cry(['run', '--live', 'local', ...p.args, ...extra]);
  return /manifest-sha: ([0-9a-f]{64})/.exec(first.stdout)![1]!;
}

/** The two-step gate: read the sha, then confirm it. */
export async function confirmed(
  p: Project,
  pw?: object,
  extra: string[] = [],
  now = NOW,
) {
  const sha = await readSha(p, extra);
  return cry(
    ['run', '--live', 'local', ...p.args, '--confirm', sha, ...extra],
    pw,
    now,
  );
}

export function confirmedDir(runs: string): string {
  return fs
    .readdirSync(runs)
    .map((id) => path.join(runs, id))
    .find((d) => fs.existsSync(path.join(d, 'findings.json')))!;
}

export const findings = (runs: string) =>
  JSON.parse(
    fs.readFileSync(path.join(confirmedDir(runs), 'findings.json'), 'utf8'),
  );
