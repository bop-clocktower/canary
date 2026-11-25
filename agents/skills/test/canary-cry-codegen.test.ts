/**
 * canary-cry codegen and run dir (#608 P3, spec "Codegen and runtime"): what
 * a confirmed run writes before the browser starts, and how the target's
 * Playwright is found and launched.
 *
 * The specs carry only what the confirmed manifest holds -- the sha binds
 * what runs -- and never an account value (SC10): accounts travel as env var
 * NAMES, resolved by the runtime at run time.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  fileStem,
  runFiles,
  scenarioPayload,
} from '../claude-code/canary-cry/scripts/codegen.mjs';
import { planRun } from '../claude-code/canary-cry/scripts/manifest.mjs';
import {
  preflight,
  resolvePlaywright,
  runPlaywright,
} from '../claude-code/canary-cry/scripts/playwright.mjs';
import {
  readOutcome,
  writeHarness,
} from '../claude-code/canary-cry/scripts/rundir.mjs';

const tmps: string[] = [];
afterEach(() => {
  while (tmps.length) fs.rmSync(tmps.pop()!, { recursive: true, force: true });
});
const tmp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-cry-gen-'));
  tmps.push(dir);
  return dir;
};

function flow(id: string, steps: any[], extra: object = {}): any {
  return { id, risk: 3, steps, ...extra };
}

function flowsDoc(): any {
  const pay = { id: 'pay', action: 'click', selector: '#p', writes: true };
  const probe = { http: { method: 'GET', path: '/api/n?u={{account.A.id}}' } };
  return {
    version: 1,
    fixtures: { card: '4242' },
    flows: [
      flow('login', [{ id: 'go', action: 'goto', url: '/login' }]),
      flow('logout', [{ id: 'go', action: 'goto', url: '/logout' }]),
      flow('checkout', [{ id: 'open', action: 'goto', url: '/c' }, pay], {
        invariants: [{ id: 'one', probe, expect: { delta: 1 } }],
        symptoms: { selectors: ['.err'] },
      }),
    ],
  };
}

function target(auth = true): any {
  const spec: any = {
    baseURL: 'http://127.0.0.1:8080',
    environment: 'local',
    hosts: ['127.0.0.1'],
    accounts: { A: { env: 'CRY_A' } },
  };
  if (auth) {
    spec.auth = {
      signIn: 'login',
      signOut: 'logout',
      sessionKeys: ['cookie:s'],
    };
  }
  return { name: 'local', spec };
}

/** A non-empty plan: its manifest and sha are never null here. */
const plan = (auth = true): { manifest: any; sha: string } =>
  planRun({
    flowsDoc: flowsDoc(),
    target: target(auth),
    amplitude: 'whisper',
    seed: 7,
  }) as any;

describe('scenarioPayload', () => {
  it('carries the flow, auth flows, hosts and env var NAMES from the manifest', () => {
    const { manifest } = plan();
    const s = scenarioPayload(manifest, manifest.scenarios[0]);
    expect(s).toEqual(
      expect.objectContaining({
        id: 'checkout:multi-submit:i1:spay',
        file: 'checkout.multi-submit.i1.spay',
        pattern: 'multi-submit',
        intensity: 1,
        step: 'pay',
        seed: 7,
        baseURL: 'http://127.0.0.1:8080',
        hosts: ['127.0.0.1'],
        symptoms: ['.err'],
        accounts: [{ account: 'A', env: 'CRY_A' }],
        fixtures: { card: '4242' },
      }),
    );
    expect(s.auth!.signIn).toEqual({
      id: 'login',
      steps: [{ id: 'go', action: 'goto', url: '/login' }],
    });
    expect(s.auth!.sessionKeys).toEqual(['cookie:s']);
    expect(s.invariants[0].id).toBe('one');
  });

  it('a target without auth gives a null auth, and a flow without probes an empty list', () => {
    const { manifest } = plan(false);
    const bare = {
      ...manifest,
      flows: manifest.flows.map((f: any) => ({
        ...f,
        invariants: undefined,
        symptoms: undefined,
      })),
    };
    const s = scenarioPayload(bare, manifest.scenarios[0]);
    expect(s.auth).toBeNull();
    expect(s.invariants).toEqual([]);
    expect(s.symptoms).toEqual([]);
  });
});

describe('runFiles', () => {
  it('writes one config (one worker, no retries, JSON reporter) and a spec per scenario', () => {
    const { manifest, sha } = plan();
    const files = runFiles(manifest, sha);
    expect(files.map((f: any) => f.path)).toEqual([
      'playwright.config.mjs',
      'specs/checkout.multi-submit.i1.spay.spec.mjs',
    ]);
    const config = files[0].text;
    expect(config).toContain('workers: 1');
    expect(config).toContain('retries: 0');
    expect(config).toContain("['json', { outputFile: 'results.json' }]");
    expect(config).toContain("trace: 'off'");
    const spec = files[1].text;
    expect(spec).toContain(`manifest-sha ${sha}`);
    expect(spec).toContain("import { test } from '@playwright/test';");
    expect(spec).toContain("from '../runtime/cry-runtime.mjs'");
    expect(spec).toContain('runScenario(browser, scenario, info)');
  });

  it('a generated spec is valid JS carrying its scenario verbatim', () => {
    const { manifest, sha } = plan();
    const spec = runFiles(manifest, sha)[1].text;
    const json = /const scenario = ([\s\S]*?);\n\ntest\(/.exec(spec)![1];
    expect(JSON.parse(json)).toEqual(
      scenarioPayload(manifest, manifest.scenarios[0]),
    );
    const dir = tmp();
    const file = path.join(dir, 'spec.mjs');
    fs.writeFileSync(file, spec);
    expect(spawnSync(process.execPath, ['--check', file]).status).toBe(0);
  });

  it('fileStem keeps ids filesystem-safe', () => {
    expect(fileStem('a:b:i1:sc')).toBe('a.b.i1.sc');
  });
});

describe('the run dir', () => {
  it('copies the runtime and verdict.mjs in the layout the specs import', () => {
    const dir = tmp();
    const { manifest, sha } = plan();
    expect(writeHarness(dir, manifest, sha)).toBe(
      path.join(dir, 'playwright.config.mjs'),
    );
    for (const f of [
      'verdict.mjs',
      'runtime/cry-runtime.mjs',
      'runtime/session.mjs',
      'runtime/abuse.mjs',
      'runtime/steps.mjs',
      'runtime/guard.mjs',
      'runtime/probes.mjs',
    ]) {
      expect(fs.existsSync(path.join(dir, f)), f).toBe(true);
    }
  });

  it('reads back results.json presence and observations, null when missing', () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, 'observations'));
    fs.writeFileSync(path.join(dir, 'observations', 'a.b.json'), '{"x":1}');
    fs.writeFileSync(path.join(dir, 'observations', 'c.d.json'), '{bad');
    const out = readOutcome(dir, [{ id: 'a:b' }, { id: 'c:d' }, { id: 'e:f' }]);
    expect(out.results).toBe(false);
    expect([...out.observations]).toEqual([
      ['a.b', { x: 1 }],
      ['c.d', null],
      ['e.f', null],
    ]);
  });
});

describe("the target's Playwright", () => {
  it('resolves @playwright/test/cli from the run dir, or null', () => {
    const project = tmp();
    expect(resolvePlaywright(project)).toBeNull();
    const pkg = path.join(project, 'node_modules', '@playwright', 'test');
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(
      path.join(pkg, 'package.json'),
      JSON.stringify({
        name: '@playwright/test',
        exports: { './cli': './cli.js' },
      }),
    );
    fs.writeFileSync(path.join(pkg, 'cli.js'), '');
    const run = path.join(project, '.canary', 'cry', 'runs', 'r');
    fs.mkdirSync(run, { recursive: true });
    expect(resolvePlaywright(run)).toBe(
      fs.realpathSync(path.join(pkg, 'cli.js')),
    );
  });

  it('launches it with this node, passing env, and keeps the last 20 stderr lines', async () => {
    const dir = tmp();
    const cli = path.join(dir, 'cli.js');
    fs.writeFileSync(
      cli,
      'for (let i = 0; i < 30; i++) console.error("line " + i);\n' +
        'console.error(process.argv.slice(2).join(" "), process.env.CRY_X);\n' +
        'process.exit(3);\n',
    );
    const r = await runPlaywright({
      cli,
      config: '/c.mjs',
      cwd: dir,
      env: { ...process.env, CRY_X: 'seen' },
    });
    expect(r.code).toBe(3);
    expect(r.stderr).toHaveLength(20);
    expect(r.stderr.at(-1)).toBe('test -c /c.mjs seen');
  });

  it('reports a launch failure instead of hanging', async () => {
    const r = await runPlaywright({
      cli: '/x.js',
      config: '/c.mjs',
      cwd: '/definitely/not/here',
      env: {},
    });
    expect(r.code).toBeNull();
    expect(r.stderr.join('\n')).toMatch(/ENOENT/);
  });

  it.each<[string, () => Promise<any>, any]>([
    ['a 200', async () => ({ status: 200 }), { ok: true, detail: 'HTTP 200' }],
    [
      'a 404 (something answered)',
      async () => ({ status: 404 }),
      { ok: true, detail: 'HTTP 404' },
    ],
    ['a 503', async () => ({ status: 503 }), { ok: false, detail: 'HTTP 503' }],
    [
      'a refused connection',
      async () => {
        throw Object.assign(new TypeError('fetch failed'), {
          cause: { code: 'ECONNREFUSED' },
        });
      },
      { ok: false, detail: 'ECONNREFUSED' },
    ],
    [
      'a timeout',
      async () => {
        throw new Error('The operation was aborted due to timeout');
      },
      { ok: false, detail: 'The operation was aborted due to timeout' },
    ],
  ])('preflight over %s', async (_, fetchImpl, want) => {
    expect(await preflight('http://t', fetchImpl)).toEqual(want);
  });
});
