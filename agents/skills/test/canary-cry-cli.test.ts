/**
 * canary-cry CLI (#608 P1): `validate` and `matrix`, their exit codes, and
 * the SC1 / SC4 / SC5 / SC24 behaviour end to end. The shared contract
 * (--help, unknown flags, empty values, the exec bit) is
 * skill-cli-conformance.test.ts's job and is not repeated here.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { main } from '../claude-code/canary-cry/scripts/cli.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS = path.join(HERE, '..', 'claude-code', 'canary-cry', 'scripts');
const CLI = path.join(SCRIPTS, 'cli.mjs');
const FLOWS_EXAMPLE = path.join(SCRIPTS, 'flows.example.json');
const TARGETS_EXAMPLE = path.join(SCRIPTS, 'targets.example.json');

const tmps: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  while (tmps.length) fs.rmSync(tmps.pop()!, { recursive: true, force: true });
});
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-cry-cli-'));
  tmps.push(dir);
  return dir;
}
function write(dir: string, name: string, doc: unknown): string {
  const file = path.join(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof doc === 'string' ? doc : JSON.stringify(doc));
  return file;
}

function run(argv: string[]): {
  code: number;
  stdout: string;
  stderr: string;
} {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    out.push(a.join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
    err.push(a.join(' '));
  });
  const code = main(argv);
  vi.restoreAllMocks();
  return { code, stdout: out.join('\n'), stderr: err.join('\n') };
}

/** One flow with two writes, so whisper has something to schedule. */
function flowsDoc(): any {
  return {
    version: 1,
    flows: [
      {
        id: 'checkout',
        risk: 5,
        criticalArea: 'src/checkout',
        steps: [
          { id: 'open', action: 'goto', url: '/cart' },
          { id: 'address', action: 'click', selector: '#a', writes: true },
          { id: 'pay', action: 'click', selector: '#p', writes: true },
        ],
      },
      {
        id: 'login',
        risk: 1,
        steps: [{ id: 'open', action: 'goto', url: '/login' }],
      },
    ],
  };
}

function targetsDoc(): any {
  return {
    version: 1,
    prodHosts: [],
    targets: {
      staging: {
        baseURL: 'https://staging.example.test',
        environment: 'staging',
        hosts: ['staging.example.test'],
        accounts: { A: { env: 'CRY_A' }, B: { env: 'CRY_B' } },
        auth: {
          signIn: 'login',
          signOut: 'login',
          sessionKeys: ['cookie:session'],
        },
      },
    },
  };
}

function inputs(): { dir: string; flows: string; targets: string } {
  const dir = tmp();
  return {
    dir,
    flows: write(dir, 'flows.json', flowsDoc()),
    targets: write(dir, 'targets.json', targetsDoc()),
  };
}

describe('command dispatch', () => {
  it.each<[string[], RegExp]>([
    [[], /the following arguments are required: command/],
    [['run'], /'run' is not yet supported \(a later phase of #608\)/],
    [['report'], /'report' is not yet supported/],
    [['frobnicate'], /invalid choice: 'frobnicate'/],
    [['validate', 'extra'], /unrecognized arguments: extra/],
  ])('rejects %j with exit 2', (argv, message) => {
    const r = run(argv);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/^canary-cry: error: /);
    expect(r.stderr).toMatch(message);
    expect(r.stdout).toBe('');
  });
});

describe('validate', () => {
  it('passes valid files and says how many flows and targets it read', () => {
    const { flows, targets } = inputs();
    const r = run(['validate', '--flows', flows, '--targets', targets]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(
      `canary-cry: valid -- 2 flow(s) in ${flows}, 1 target(s) in ${targets}`,
    );
  });

  it('validates the shipped example files', () => {
    const r = run([
      'validate',
      '--flows',
      FLOWS_EXAMPLE,
      '--targets',
      TARGETS_EXAMPLE,
    ]);
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
  });

  it('exits 2 naming the file and JSON path of a schema error (SC5)', () => {
    const { dir, targets } = inputs();
    const doc = flowsDoc();
    doc.flows[0].risk = 0;
    const flows = write(dir, 'bad.json', doc);
    const r = run(['validate', '--flows', flows, '--targets', targets]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain(
      `canary-cry: error: ${flows}: $.flows[0].risk: must be an integer 1-5`,
    );
  });

  it('exits 2 when either file is missing', () => {
    const { dir, flows } = inputs();
    const missing = path.join(dir, 'nope.json');
    expect(run(['validate', '--flows', missing]).stderr).toContain(
      `flows file not found: ${missing}`,
    );
    const r = run(['validate', '--flows', flows, '--targets', missing]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain(`targets file not found: ${missing}`);
  });

  it('cross-checks auth flow names against the flows file', () => {
    const { dir, flows } = inputs();
    const doc = targetsDoc();
    doc.targets.staging.auth.signIn = 'sign-in';
    const targets = write(dir, 't.json', doc);
    const r = run(['validate', '--flows', flows, '--targets', targets]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain(
      "$.targets.staging.auth.signIn: names no flow in flows.json ('sign-in')",
    );
  });
});

describe('matrix', () => {
  it('prints the ranked matrix with its ranking source', () => {
    const { flows } = inputs();
    const r = run(['matrix', '--flows', flows]);
    expect(r.code).toBe(0);
    expect(r.stdout.split('\n').slice(0, 2)).toEqual([
      'canary-cry matrix -- amplitude whisper, seed 0, ranking: declared',
      '3 scenario(s) over 1 flow(s); patterns: multi-submit, abandon-midflow; intensity: i1',
    ]);
    expect(r.stdout).toContain('checkout:abandon-midflow:i1:saddress');
  });

  it('prints byte-identical --json for the same input (SC1)', () => {
    const { flows } = inputs();
    const argv = ['matrix', '--flows', flows, '--seed', '42', '--json'];
    const first = run(argv);
    expect(first.code).toBe(0);
    expect(run(argv).stdout).toBe(first.stdout);
    expect(JSON.parse(first.stdout)).toMatchObject({
      format: 'canary.cry-matrix/1',
      seed: 42,
    });
  });

  it('is byte-identical across separate processes too (SC1)', () => {
    const { flows } = inputs();
    const once = () =>
      spawnSync(CLI, ['matrix', '--flows', flows, '--json'], {
        encoding: 'utf8',
        timeout: 20_000,
      });
    const [a, b] = [once(), once()];
    expect(a.status, a.stderr).toBe(0);
    expect(b.stdout).toBe(a.stdout);
  });

  it('emits no matrix when the flows file fails validation (SC5)', () => {
    const { dir } = inputs();
    const flows = write(dir, 'bad.json', {
      version: 1,
      flows: [{ id: 'x' }],
    });
    const r = run(['matrix', '--flows', flows, '--json']);
    expect(r.code).toBe(2);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain(`${flows}: $.flows[0].risk:`);
  });

  it.each<[string[], RegExp]>([
    [
      ['--amplitude', 'loud'],
      /argument --amplitude: invalid choice: 'loud' \(choose from 'whisper', 'shout', 'scream'\)/,
    ],
    [['--seed', '1.5'], /argument --seed: invalid int value: '1.5'/],
    [['--target', 'prod'], /no target named 'prod' \(declared: staging\)/],
  ])('rejects %j with exit 2', (extra, message) => {
    const { flows, targets } = inputs();
    const r = run(['matrix', '--flows', flows, '--targets', targets, ...extra]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(message);
    expect(r.stdout).toBe('');
  });

  it('runs shout and scream (the P4 "not yet supported" guard is for run only)', () => {
    const { flows } = inputs();
    for (const amplitude of ['shout', 'scream']) {
      const r = run(['matrix', '--flows', flows, '--amplitude', amplitude]);
      expect(r.code, amplitude).toBe(0);
      expect(r.stdout).toContain(`amplitude ${amplitude}`);
    }
  });

  it('says which target-scoped patterns it skipped without --target', () => {
    const { flows } = inputs();
    const r = run(['matrix', '--flows', flows, '--amplitude', 'shout']);
    expect(r.stdout).toContain(
      'target-scoped patterns not scheduled (no --target): token-expiry, shared-machine',
    );
  });

  it('schedules them for a named target', () => {
    const { flows, targets } = inputs();
    const r = run([
      'matrix',
      '--flows',
      flows,
      '--targets',
      targets,
      '--target',
      'staging',
      '--amplitude',
      'shout',
    ]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(', target staging');
    expect(r.stdout).toContain('checkout:token-expiry:i1:saddress');
    expect(r.stdout).not.toContain('not scheduled');
  });

  it('names what a target lacks instead of dropping its pattern silently', () => {
    const { dir, flows } = inputs();
    const doc = targetsDoc();
    delete doc.targets.staging.accounts.B;
    const targets = write(dir, 'one-account.json', doc);
    const r = run([
      'matrix',
      '--flows',
      flows,
      '--targets',
      targets,
      '--target',
      'staging',
      '--amplitude',
      'shout',
      '--strict',
    ]);
    // Not an abstention: the other patterns still scheduled, so --strict stays 0.
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('checkout:token-expiry:i1:saddress');
    expect(r.stdout).toContain(
      'target-scoped patterns not scheduled (target does not declare accounts.B): shared-machine',
    );
  });

  describe('critical areas (SC4)', () => {
    const areas = {
      areas: [{ path: 'src/checkout/pay.ts', risk_score: 0.9 }],
    };

    it('ranks with an explicit file and prints declared+critical-areas', () => {
      const { dir, flows } = inputs();
      const file = write(dir, 'ca.json', areas);
      const r = run(['matrix', '--flows', flows, '--critical-areas', file]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('ranking: declared+critical-areas');
      expect(r.stdout).toContain(' 27  checkout:multi-submit:i1:saddress');
    });

    it('reads the default .canary/critical-areas.json from the working directory', () => {
      const { dir, flows } = inputs();
      const plain = spawnSync(CLI, ['matrix', '--flows', flows], {
        cwd: dir,
        encoding: 'utf8',
        timeout: 20_000,
      });
      expect(plain.stdout).toContain('ranking: declared\n');
      write(dir, '.canary/critical-areas.json', areas);
      const ranked = spawnSync(CLI, ['matrix', '--flows', flows], {
        cwd: dir,
        encoding: 'utf8',
        timeout: 20_000,
      });
      expect(ranked.status, ranked.stderr).toBe(0);
      expect(ranked.stdout).toContain('ranking: declared+critical-areas');
    });

    it('exits 2 for a named file that is missing or malformed', () => {
      const { dir, flows } = inputs();
      const missing = path.join(dir, 'none.json');
      const r = run(['matrix', '--flows', flows, '--critical-areas', missing]);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain(`critical-areas file not found: ${missing}`);
      const bad = write(dir, 'bad.json', { areas: 'x' });
      const r2 = run(['matrix', '--flows', flows, '--critical-areas', bad]);
      expect(r2.code).toBe(2);
      expect(r2.stderr).toContain(`${bad}: areas:`);
      expect(r2.stdout).toBe('');
    });
  });

  describe('zero scenarios (SC24)', () => {
    const readOnly = {
      version: 1,
      flows: [
        {
          id: 'browse',
          risk: 5,
          steps: [{ id: 'o', action: 'goto', url: '/' }],
        },
      ],
    };

    it('reports ABSTAINED, advisory exit 0', () => {
      const flows = write(tmp(), 'flows.json', readOnly);
      const r = run(['matrix', '--flows', flows]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('ABSTAINED: zero scenarios');
      expect(r.stdout).toContain('this is not a pass');
      expect(r.stdout).not.toContain('scenario(s) over');
    });

    it('exits 3 under --strict, in text and in --json', () => {
      const flows = write(tmp(), 'flows.json', readOnly);
      expect(run(['matrix', '--flows', flows, '--strict']).code).toBe(3);
      const r = run(['matrix', '--flows', flows, '--strict', '--json']);
      expect(r.code).toBe(3);
      expect(JSON.parse(r.stdout)).toMatchObject({
        status: 'abstained',
        reason: 'zero scenarios',
      });
    });

    it('keeps exit 0 under --strict when the matrix is not empty', () => {
      const { flows } = inputs();
      expect(run(['matrix', '--flows', flows, '--strict']).code).toBe(0);
    });
  });

  it('builds a target-scoped matrix from the shipped examples', () => {
    const r = run([
      'matrix',
      '--flows',
      FLOWS_EXAMPLE,
      '--targets',
      TARGETS_EXAMPLE,
      '--target',
      'staging',
      '--amplitude',
      'shout',
      '--json',
    ]);
    expect(r.code).toBe(0);
    const m = JSON.parse(r.stdout);
    expect(m.status).toBe('ok');
    expect(new Set(m.scenarios.map((s: any) => s.pattern))).toEqual(
      new Set([
        'multi-submit',
        'abandon-midflow',
        'stale-optimistic',
        'duplicate-tab',
        'token-expiry',
        'shared-machine',
      ]),
    );
  });
});
