/**
 * `canary-cry run --live` end to end through main() (#608 P2): the two-step
 * gate of ADR 0046. What this proves is everything that must hold BEFORE
 * the executor loads (a matching sha executing is canary-cry-execute.test.ts):
 *
 * - SC7  refused targets exit 4 and write nothing
 * - SC8  without --confirm: manifest + sha printed, only the run dir written
 * - SC9  a stale or wrong --confirm exits 4 against a freshly rebuilt manifest
 * - SC10 an account's value never reaches stdout, stderr or the run dir
 * - SC23 an unset / non-object account env var exits 2 by NAME, pre-request
 *
 * "Zero target requests" is spied here (fetch) and proven structurally by the
 * import-closure test: nothing in the CLI's closure can open a socket.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { main } from '../claude-code/canary-cry/scripts/cli.mjs';

const NOW = () => new Date('2026-11-25T14:33:33.123Z');
const SECRET = 'pw-planted-5150';
const ACCOUNT = JSON.stringify({ email: 'a@x.test', password: SECRET, id: 7 });
const ENV = { CRY_A: ACCOUNT, CRY_B: ACCOUNT };

const tmps: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  while (tmps.length) fs.rmSync(tmps.pop()!, { recursive: true, force: true });
});

// Split so no factory nests past the arch nestingDepth threshold (4).
function checkoutFlow(): any {
  const probe = { shell: { argv: ['psql', '-tAc', 'select 1'] } };
  return {
    id: 'checkout',
    risk: 5,
    steps: [
      { id: 'open', action: 'goto', url: '/cart' },
      { id: 'pay', action: 'click', selector: '#p', writes: true },
    ],
    invariants: [{ id: 'one-order', probe, expect: { equals: 1 } }],
  };
}

function flowsDoc(): any {
  return { version: 1, flows: [checkoutFlow()] };
}

function stagingTarget(): any {
  return {
    baseURL: 'https://staging.example.test',
    environment: 'staging',
    hosts: ['staging.example.test'],
    accounts: { A: { env: 'CRY_A' }, B: { env: 'CRY_B' } },
  };
}

function targetsDoc(): any {
  return {
    version: 1,
    prodHosts: ['*.prod.example'],
    targets: { staging: stagingTarget() },
  };
}

/** A project dir laid out like an adopter's: .canary/cry/{flows,targets}.json. */
function project(flows = flowsDoc(), targets = targetsDoc()) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-cry-run-'));
  tmps.push(dir);
  const cry = path.join(dir, '.canary', 'cry');
  fs.mkdirSync(cry, { recursive: true });
  const f = path.join(cry, 'flows.json');
  const t = path.join(cry, 'targets.json');
  fs.writeFileSync(f, JSON.stringify(flows));
  fs.writeFileSync(t, JSON.stringify(targets));
  return {
    dir,
    cry,
    runs: path.join(cry, 'runs'),
    args: ['--flows', f, '--targets', t],
  };
}

function run(argv: string[], env: Record<string, string> = ENV) {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    out.push(a.join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
    err.push(a.join(' '));
  });
  const fetchSpy = vi.fn();
  vi.stubGlobal('fetch', fetchSpy);
  const code = main(argv, { env, now: NOW });
  vi.restoreAllMocks();
  return {
    code,
    stdout: out.join('\n'),
    stderr: err.join('\n'),
    fetches: fetchSpy.mock.calls.length,
  };
}

const shaOf = (stdout: string) =>
  /manifest-sha: ([0-9a-f]{64})/.exec(stdout)?.[1];

/** The manifest.json path the manifest text names. */
const manifestFile = (stdout: string) => /^manifest: (.+)$/m.exec(stdout)![1]!;

/** Every byte under dir, so an artifact grep cannot miss a file. */
function allText(dir: string): string {
  if (!fs.existsSync(dir)) return '';
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => fs.readFileSync(path.join(e.parentPath, e.name), 'utf8'))
    .join('\n');
}

describe('run --live without --confirm (SC8)', () => {
  it('prints the manifest and its sha, writes only the run dir, sends nothing', () => {
    const p = project();
    const r = run(['run', '--live', 'staging', ...p.args]);
    expect(r.code).toBe(0);
    expect(r.fetches).toBe(0);
    const sha = shaOf(r.stdout);
    expect(sha).toBeDefined();

    const runId = `20261125T143333Z-${sha!.slice(0, 8)}`;
    expect(fs.readdirSync(p.runs)).toEqual([runId]);
    expect(fs.readdirSync(path.join(p.runs, runId))).toEqual(['manifest.json']);
    // Nothing else appeared beside the inputs.
    expect(fs.readdirSync(p.cry).sort()).toEqual([
      'flows.json',
      'runs',
      'targets.json',
    ]);

    const manifest = JSON.parse(
      fs.readFileSync(path.join(p.runs, runId, 'manifest.json'), 'utf8'),
    );
    expect(manifest.format).toBe('canary.cry-manifest/1');
    expect(r.stdout).toContain(`--confirm ${sha}`);
  });

  it('shows the operator the blast radius in the text, not only the file', () => {
    const r = run(['run', '--live', 'staging', ...project().args]);
    expect(r.stdout).toContain(
      'target: staging (staging) https://staging.example.test',
    );
    expect(r.stdout).toContain('egress hosts: staging.example.test');
    expect(r.stdout).toContain('accounts (env var names): A=CRY_A, B=CRY_B');
    expect(r.stdout).toContain('write: checkout/pay click #p');
    expect(r.stdout).toContain(
      'probe: checkout/one-order shell ["psql","-tAc","select 1"]',
    );
    expect(r.stdout).toContain(
      'server-side side effects (email, webhooks, payments) are NOT intercepted by canary-cry.',
    );
    expect(r.stdout).toMatch(/scenario\(s\): \d+/);
  });

  it('gives the same sha for the same inputs at a different time', () => {
    const p = project();
    const a = shaOf(run(['run', '--live', 'staging', ...p.args]).stdout);
    const b = shaOf(
      (() => {
        const out: string[] = [];
        vi.spyOn(console, 'log').mockImplementation((...x: unknown[]) =>
          out.push(x.join(' ')),
        );
        main(['run', '--live', 'staging', ...p.args], {
          env: ENV,
          now: () => new Date('2027-01-01T00:00:00Z'),
        });
        vi.restoreAllMocks();
        return out.join('\n');
      })(),
    );
    expect(b).toBe(a);
  });
});

describe('refused targets exit 4 and write nothing (SC7)', () => {
  it.each<[string, (t: any) => void, RegExp]>([
    ['unlisted', () => {}, /no target named 'nope'/],
    [
      'a disallowed environment',
      (t) => {
        t.targets.staging.environment = 'production';
      },
      /declares environment 'production'/,
    ],
    [
      'a prod baseURL',
      (t) => {
        t.targets.staging.baseURL = 'https://shop.prod.example';
      },
      /baseURL host 'shop.prod.example' matches prodHosts/,
    ],
    [
      'a prod egress host',
      (t) => {
        t.targets.staging.hosts.push('api.prod.example');
      },
      /hosts\[1\] 'api.prod.example' matches prodHosts/,
    ],
  ])('%s', (label, mutate, message) => {
    const t = targetsDoc();
    mutate(t);
    const p = project(flowsDoc(), t);
    const name = label === 'unlisted' ? 'nope' : 'staging';
    const r = run(['run', '--live', name, ...p.args]);
    expect(r.code).toBe(4);
    expect(r.stderr).toMatch(/^canary-cry: refused: /);
    expect(r.stderr).toMatch(message);
    expect(r.stdout).toBe('');
    expect(r.fetches).toBe(0);
    expect(fs.existsSync(p.runs)).toBe(false);
  });

  it('refuses before reading credentials: no env needed to be told no', () => {
    const t = targetsDoc();
    t.targets.staging.environment = 'production';
    const r = run(
      ['run', '--live', 'staging', ...project(flowsDoc(), t).args],
      {},
    );
    expect(r.code).toBe(4);
  });
});

describe('--confirm (SC9)', () => {
  it('refuses a sha that does not match the rebuilt manifest', () => {
    const p = project();
    const r = run([
      'run',
      '--live',
      'staging',
      ...p.args,
      '--confirm',
      'a'.repeat(64),
    ]);
    expect(r.code).toBe(4);
    expect(r.stderr).toMatch(/^canary-cry: refused: manifest-sha mismatch/);
    expect(r.stderr).toContain(`confirmed ${'a'.repeat(64)}`);
    expect(r.fetches).toBe(0);
    expect(fs.existsSync(p.runs)).toBe(false);
  });

  it('refuses a once-good sha after the flows file changes (rebuilt, never read back)', () => {
    const p = project();
    const sha = shaOf(run(['run', '--live', 'staging', ...p.args]).stdout)!;
    const flows = flowsDoc();
    flows.flows[0].invariants[0].probe.shell.argv = ['rm', '-rf', '/tmp/x'];
    fs.writeFileSync(path.join(p.cry, 'flows.json'), JSON.stringify(flows));
    const r = run(['run', '--live', 'staging', ...p.args, '--confirm', sha]);
    expect(r.code).toBe(4);
    expect(r.stderr).toMatch(/manifest-sha mismatch/);
  });
});

describe('account env vars (SC23, SC10)', () => {
  it('exits 2 naming an unset variable, before any request or write', () => {
    const p = project();
    const r = run(['run', '--live', 'staging', ...p.args], { CRY_A: ACCOUNT });
    expect(r.code).toBe(2);
    expect(r.stderr).toBe(
      'canary-cry: error: account B: environment variable CRY_B is not set',
    );
    expect(r.fetches).toBe(0);
    expect(fs.existsSync(p.runs)).toBe(false);
  });

  it('exits 2 for a value that is not a JSON object, without echoing it', () => {
    const r = run(['run', '--live', 'staging', ...project().args], {
      CRY_A: SECRET,
      CRY_B: ACCOUNT,
    });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('CRY_A does not hold a JSON object');
    expect(r.stderr).not.toContain(SECRET);
  });

  it('never writes or prints an account value (planted secret)', () => {
    const p = project();
    const r = run(['run', '--live', 'staging', ...p.args]);
    expect(r.code).toBe(0);
    expect(r.stdout + r.stderr).not.toContain(SECRET);
    expect(r.stdout + r.stderr).not.toContain('a@x.test');
    const artifacts = allText(p.runs);
    expect(artifacts.length).toBeGreaterThan(0);
    expect(artifacts).not.toContain(SECRET);
    expect(artifacts).not.toContain('a@x.test');
  });
});

describe('run usage', () => {
  it.each<[string[], RegExp]>([
    [['run'], /run: --live TARGET is required/],
    [['run', '--confirm', 'abc'], /run: --live TARGET is required/],
  ])('%j exits 2', (argv, message) => {
    const r = run(argv);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(message);
  });

  // #608 P4: shout and scream run. Their manifest is the WORST case -- every
  // scenario of every round, though scream may converge before its last --
  // so the confirmed sha covers everything that can run.
  it.each<[string, number[]]>([
    ['shout', [1, 2]],
    ['scream', [1, 2, 3]],
  ])('--amplitude %s lists every round in the manifest', (a, rounds) => {
    const p = project();
    const r = run(['run', '--live', 'staging', ...p.args, '--amplitude', a]);
    expect(r.code, r.stderr).toBe(0);
    const doc = JSON.parse(fs.readFileSync(manifestFile(r.stdout), 'utf8'));
    const seen = [...new Set(doc.scenarios.map((s: any) => s.intensity))];
    expect(seen).toEqual(rounds);
    for (const n of rounds) {
      expect(r.stdout).toContain(`checkout:multi-submit:i${n}:spay`);
    }
  });

  it('an unknown --amplitude is exit 2 on run too', () => {
    const p = project();
    const r = run(['run', '--live', 'staging', ...p.args, '--amplitude', 'x']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("argument --amplitude: invalid choice: 'x'");
  });

  it('schema errors in the inputs exit 2 before the gate', () => {
    const t = targetsDoc();
    t.targets.staging.password = 'x';
    const r = run(['run', '--live', 'staging', ...project(flowsDoc(), t).args]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/\$\.targets\.staging\.password: unknown key/);
  });
});

describe('zero scenarios (SC24 on the run path)', () => {
  it('abstains instead of writing a manifest that would run nothing', () => {
    const flows = flowsDoc();
    flows.flows[0].steps = [{ id: 'open', action: 'goto', url: '/cart' }];
    const p = project(flows);
    const r = run(['run', '--live', 'staging', ...p.args]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('ABSTAINED: zero scenarios');
    expect(r.stdout).not.toContain('manifest-sha');
    expect(fs.existsSync(p.runs)).toBe(false);
    expect(run(['run', '--live', 'staging', ...p.args, '--strict']).code).toBe(
      3,
    );
  });
});
