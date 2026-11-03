/**
 * The security ledger's supply-chain line must not be a false zero (#1436).
 *
 * The harness CLI calls `timelineManager.capture(result, commitHash)` with no
 * supply-chain argument, so every snapshot records `supplyChain.total: 0`
 * whether or not a vulnerable package is pinned. The ledger printed that zero.
 *
 * The audit is now a separate step (`scripts/supply_chain_audit.mjs`) that
 * writes a committed sidecar. The renderer only reads the sidecar, because the
 * freshness guard reruns the renderer with no audit and fails on any diff.
 *
 * Offline and free of live counts: every audit below runs the real `npm` against
 * a local fake registry (or an unreachable one), over fixture repos with nested
 * lockfiles and no root lockfile. The stub `npm` only proves "was not called".
 */

import { execFile, execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type RequestListener, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as loadYaml } from 'js-yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const AUDIT_SCRIPT = 'scripts/supply_chain_audit.mjs';
const LEDGER_SCRIPT = 'scripts/security_ledger.mjs';
const SIDECAR = '.harness/security/supply-chain.json';
const TIMELINE = '.harness/security/timeline.json';
const LEDGER = 'docs/SECURITY_LEDGER.md';
const DEAD_REGISTRY = 'http://127.0.0.1:9/';
const NPM_TIMEOUT = 60_000;

interface SidecarLockfile {
  path: string;
  status: string;
  reason?: string;
  vulnerabilities?: Record<string, number>;
}
interface Sidecar {
  lockfiles: SidecarLockfile[];
  reason?: string;
}

const dirs: string[] = [];
let registry: Server;
let registryUrl: string;

/**
 * The two npm registry routes `npm audit` uses for one package. `minimist` below
 * 0.2.1 is the "known vulnerable" pin; the advisory is this fixture's own text.
 */
const serveRegistry: RequestListener = (req, res) => {
  req.resume();
  res.setHeader('content-type', 'application/json');
  if (req.method === 'POST' && req.url?.includes('/advisories/bulk')) {
    res.end(
      JSON.stringify({
        minimist: [
          {
            id: 1,
            url: 'https://example.invalid/advisory',
            title: 'fixture advisory',
            severity: 'high',
            vulnerable_versions: '<0.2.1',
            cwe: [],
            cvss: { score: 0, vectorString: null },
          },
        ],
      }),
    );
    return;
  }
  res.end(
    JSON.stringify({
      name: 'minimist',
      'dist-tags': { latest: '1.2.8' },
      versions: {
        '0.0.8': { name: 'minimist', version: '0.0.8' },
        '1.2.8': { name: 'minimist', version: '1.2.8' },
      },
    }),
  );
};

beforeAll(async () => {
  registry = createServer(serveRegistry);
  await new Promise<void>((done) => registry.listen(0, '127.0.0.1', done));
  registryUrl = `http://127.0.0.1:${(registry.address() as AddressInfo).port}/`;
});

afterAll(async () => {
  await new Promise((done) => registry.close(done));
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
}

function write(dir: string, rel: string, content: string): void {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), content);
}

/** A git repo holding the two scripts and the given files, all committed. */
function makeRepo(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'supply-chain-ledger-'));
  dirs.push(dir);
  git(dir, 'init', '--quiet');
  git(dir, 'config', 'user.email', 'test@example.invalid');
  git(dir, 'config', 'user.name', 'Test');
  for (const rel of [AUDIT_SCRIPT, LEDGER_SCRIPT]) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    cpSync(join(REPO_ROOT, rel), join(dir, rel));
  }
  write(dir, 'README.txt', 'fixture\n');
  for (const [rel, content] of Object.entries(files)) write(dir, rel, content);
  git(dir, 'add', '-A');
  git(dir, 'commit', '--quiet', '--no-verify', '-m', 'seed');
  return dir;
}

/** A nested npm project pinning `minimist` at `version`. */
function npmProject(
  prefix: string,
  version: string | null,
  registryForDir?: string,
): Record<string, string> {
  const deps = version ? { minimist: version } : {};
  const packages: Record<string, unknown> = {
    '': { name: 'fixture', version: '1.0.0', dependencies: deps },
  };
  if (version) {
    packages['node_modules/minimist'] = {
      version,
      resolved: `https://registry.example.invalid/minimist-${version}.tgz`,
    };
  }
  const files: Record<string, string> = {
    [`${prefix}/package.json`]: JSON.stringify({
      name: 'fixture',
      version: '1.0.0',
      dependencies: deps,
    }),
    [`${prefix}/package-lock.json`]: JSON.stringify({
      name: 'fixture',
      version: '1.0.0',
      lockfileVersion: 3,
      requires: true,
      packages,
    }),
  };
  if (registryForDir)
    files[`${prefix}/.npmrc`] = `registry=${registryForDir}\n`;
  return files;
}

/** Async on purpose: the fake registry shares this process's event loop. */
function runAudit(
  dir: string,
  env: Record<string, string | undefined> = {},
): Promise<{ code: number; log: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [AUDIT_SCRIPT],
      {
        cwd: dir,
        encoding: 'utf8',
        env: {
          ...process.env,
          npm_config_fetch_retries: '0',
          npm_config_cache: join(dir, '.npm-cache'),
          ...env,
        },
      },
      (err, stdout, stderr) => {
        const code = err ? ((err as { code?: number }).code ?? 1) : 0;
        resolve({ code: Number(code), log: `${stdout}${stderr}` });
      },
    );
  });
}

function render(dir: string): string {
  execFileSync(process.execPath, [LEDGER_SCRIPT], { cwd: dir });
  return readFileSync(join(dir, LEDGER), 'utf8');
}

function supplyLine(ledger: string): string {
  const line = ledger.split('\n').find((l) => l.includes('Supply chain:**'));
  expect(line, ledger).toBeDefined();
  return line!;
}

function sidecar(dir: string): Sidecar {
  return JSON.parse(readFileSync(join(dir, SIDECAR), 'utf8')) as Sidecar;
}

function counts(total: number): Record<string, number> {
  return { critical: 0, high: total, moderate: 0, low: 0, info: 0, total };
}

function measuredSidecar(total: number): string {
  return JSON.stringify({
    schemaVersion: 1,
    commit: 'abcdef1234567890',
    capturedAt: '2026-11-03T00:00:00.000Z',
    lockfiles: [
      {
        path: 'ts/package-lock.json',
        status: 'measured',
        dependencies: 10,
        vulnerabilities: counts(total),
      },
    ],
  });
}

function timeline(total: number): string {
  return `${JSON.stringify(
    {
      snapshots: [
        {
          capturedAt: '2026-10-01T00:00:00.000Z',
          commitHash: 'aaaaaaa',
          securityScore: 100,
          totalFindings: 0,
          bySeverity: { error: 0, warning: 0, info: 0 },
          supplyChain: { total, critical: 0, high: 0, moderate: 0, low: 0 },
          suppressionCount: 0,
        },
      ],
      findingLifecycles: [],
    },
    null,
    2,
  )}\n`;
}

describe('supply-chain audit: real npm over nested lockfiles (#1436)', () => {
  it(
    'a nested lockfile pinning a vulnerable version reads non-zero',
    async () => {
      const dir = makeRepo(npmProject('nested/pkg', '0.0.8'));
      expect(existsSync(join(dir, 'package-lock.json'))).toBe(false);

      const r = await runAudit(dir, { npm_config_registry: registryUrl });

      // A non-zero count is information, not a failure of the required check.
      expect(r.code, r.log).toBe(0);
      const [entry] = sidecar(dir).lockfiles;
      expect(entry).toMatchObject({
        path: 'nested/pkg/package-lock.json',
        status: 'measured',
      });
      expect(entry!.vulnerabilities!.total).toBeGreaterThan(0);
      expect(supplyLine(render(dir))).toMatch(
        /Supply chain:\*\* 1 \(.*high: 1/,
      );
    },
    NPM_TIMEOUT,
  );

  it('zero tracked lockfiles reads "not measured", never 0', async () => {
    const dir = makeRepo();
    const r = await runAudit(dir, { npm_config_registry: DEAD_REGISTRY });
    expect(r.code, r.log).toBe(0);
    expect(sidecar(dir).lockfiles).toEqual([]);
    const line = supplyLine(render(dir));
    expect(line).toContain('not measured');
    expect(line).not.toMatch(/Supply chain:\*\* 0/);
  });

  it('an untracked lockfile does not count as audited', async () => {
    const dir = makeRepo();
    for (const [rel, content] of Object.entries(npmProject('loose', '0.0.8')))
      write(dir, rel, content);
    await runAudit(dir, { npm_config_registry: registryUrl });
    expect(sidecar(dir).lockfiles).toEqual([]);
    expect(supplyLine(render(dir))).toContain('not measured');
  });

  it(
    'a registry failure is "not measured", not a clean audit',
    async () => {
      const dir = makeRepo(npmProject('ts', '0.0.8'));
      // npm exits 1 for this AND for "found vulnerabilities", so the exit code
      // cannot tell them apart. Only the report's shape can.
      const r = await runAudit(dir, { npm_config_registry: DEAD_REGISTRY });
      expect(r.code, r.log).toBe(0);
      expect(r.log).toContain('::warning');
      const [entry] = sidecar(dir).lockfiles;
      expect(entry).toMatchObject({ status: 'failed' });
      expect(entry!.vulnerabilities).toBeUndefined();
      const line = supplyLine(render(dir));
      expect(line).toContain('not measured');
      expect(line).toContain('ts/package-lock.json');
      expect(line).not.toMatch(/Supply chain:\*\* \d/);
    },
    NPM_TIMEOUT,
  );

  it(
    'a clean audit prints a measured 0, distinct from "not measured"',
    async () => {
      const dir = makeRepo(npmProject('ts', '1.2.8'));
      const r = await runAudit(dir, { npm_config_registry: registryUrl });
      expect(r.code, r.log).toBe(0);
      const line = supplyLine(render(dir));
      expect(line).toMatch(/Supply chain:\*\* 0 \(/);
      expect(line).toContain('1 lockfile');
      expect(line).not.toContain('not measured');
    },
    NPM_TIMEOUT,
  );

  it(
    'a lockfile with no dependencies is an abstention, not a clean audit',
    async () => {
      const dir = makeRepo(npmProject('empty', null));
      await runAudit(dir, { npm_config_registry: registryUrl });
      expect(sidecar(dir).lockfiles[0]).toMatchObject({ status: 'failed' });
      expect(supplyLine(render(dir))).toContain('not measured');
    },
    NPM_TIMEOUT,
  );

  it(
    'sums every tracked lockfile',
    async () => {
      const dir = makeRepo({
        ...npmProject('a', '0.0.8'),
        ...npmProject('deep/b', '0.0.8'),
      });
      await runAudit(dir, { npm_config_registry: registryUrl });
      expect(sidecar(dir).lockfiles.map((l) => l.path)).toEqual([
        'a/package-lock.json',
        'deep/b/package-lock.json',
      ]);
      expect(supplyLine(render(dir))).toMatch(/Supply chain:\*\* 2 \(/);
    },
    NPM_TIMEOUT,
  );

  it(
    'one failed lockfile makes the whole line "not measured"',
    async () => {
      const dir = makeRepo({
        ...npmProject('good', '0.0.8', registryUrl),
        ...npmProject('bad', '0.0.8', DEAD_REGISTRY),
      });
      const r = await runAudit(dir);
      expect(r.code, r.log).toBe(0);
      const line = supplyLine(render(dir));
      // A partial sum would read as the whole repo's count.
      expect(line).toContain('not measured');
      expect(line).toContain('1 of 2');
      expect(line).toContain('bad/package-lock.json');
    },
    NPM_TIMEOUT,
  );

  it(
    'a tracked lockfile npm cannot audit is named, not skipped',
    async () => {
      const dir = makeRepo({
        ...npmProject('ts', '0.0.8'),
        'site/yarn.lock': '# yarn lockfile v1\n',
      });
      await runAudit(dir, { npm_config_registry: registryUrl });
      const line = supplyLine(render(dir));
      expect(line).toContain('not measured');
      expect(line).toContain('site/yarn.lock');
    },
    NPM_TIMEOUT,
  );

  it('an npm that cannot be spawned is "not measured", not a crash', async () => {
    const dir = makeRepo(npmProject('ts', '0.0.8'));
    const bin = join(dir, 'git-only-bin');
    mkdirSync(bin);
    const gitPath = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    symlinkSync(gitPath, join(bin, 'git'));
    const r = await runAudit(dir, { PATH: bin });
    expect(r.code, r.log).toBe(0);
    expect(sidecar(dir).lockfiles[0]).toMatchObject({ status: 'failed' });
    expect(supplyLine(render(dir))).toContain('not measured');
  });

  it('a git that cannot be spawned is "not measured", not a crash', async () => {
    const dir = makeRepo(npmProject('ts', '0.0.8'));
    const empty = join(dir, 'empty-bin');
    mkdirSync(empty);
    const r = await runAudit(dir, { PATH: empty, GITHUB_SHA: undefined });
    expect(r.code, r.log).toBe(0);
    expect(sidecar(dir).reason).toBe('git ls-files failed');
    const line = supplyLine(render(dir));
    expect(line).toContain('not measured (git ls-files failed)');
  });

  it(
    'writes to the repo root from any working directory',
    async () => {
      const dir = makeRepo(npmProject('ts', '1.2.8'));
      await new Promise<void>((done) => {
        execFile(
          process.execPath,
          [join(dir, AUDIT_SCRIPT)],
          {
            cwd: join(dir, 'ts'),
            env: { ...process.env, npm_config_registry: registryUrl },
          },
          () => done(),
        );
      });
      expect(sidecar(dir).lockfiles[0]?.path).toBe('ts/package-lock.json');
      expect(existsSync(join(dir, 'ts', SIDECAR))).toBe(false);
    },
    NPM_TIMEOUT,
  );

  it('the sidecar is trackable in this repo', () => {
    // `.harness/.gitignore` ignores `security/*` except named files. Ignored
    // here, the ledger job's `git add` would refuse the sidecar and go red, and
    // no fixture repo above would notice: they have no such ignore file.
    const r = spawnSync('git', ['check-ignore', '-q', SIDECAR], {
      cwd: REPO_ROOT,
    });
    expect(r.status).toBe(1);
  });
});

describe('the renderer reads only the sidecar (#1436)', () => {
  it('ignores the harness snapshot field, which is never populated', () => {
    const dir = makeRepo({ [TIMELINE]: timeline(0) });
    const ledger = render(dir);
    expect(supplyLine(ledger)).toContain('not measured');
    // The per-snapshot column printed that same zero for every row.
    expect(ledger).not.toContain('| Supply |');
  });

  it('prints the line even before the first scan', () => {
    const dir = makeRepo({ [SIDECAR]: measuredSidecar(4) });
    expect(supplyLine(render(dir))).toMatch(/Supply chain:\*\* 4 \(/);
  });

  it.each([
    ['unparseable', '{nope'],
    ['not an object', 'null'],
    ['no lockfiles key', JSON.stringify({ schemaVersion: 1 })],
    [
      'a fractional count',
      JSON.stringify({
        lockfiles: [
          {
            path: 'x/package-lock.json',
            status: 'measured',
            vulnerabilities: { ...counts(1), total: 1.5 },
          },
        ],
      }),
    ],
    [
      'a missing count',
      JSON.stringify({
        lockfiles: [{ path: 'x/package-lock.json', status: 'measured' }],
      }),
    ],
  ])('reads "not measured" from a sidecar with %s', (_name, content) => {
    const dir = makeRepo({ [SIDECAR]: content });
    const line = supplyLine(render(dir));
    expect(line).toContain('not measured');
    expect(line).not.toMatch(/Supply chain:\*\* \d/);
  });

  it('never writes audit results into the harness timeline', () => {
    const before = timeline(0);
    const dir = makeRepo({ [TIMELINE]: before, [SIDECAR]: measuredSidecar(4) });
    render(dir);
    expect(readFileSync(join(dir, TIMELINE), 'utf8')).toBe(before);
  });

  it('never runs npm, and renders the same bytes twice', () => {
    const dir = makeRepo({
      [TIMELINE]: timeline(0),
      [SIDECAR]: measuredSidecar(4),
    });
    const bin = join(dir, 'stub-bin');
    const marker = join(dir, 'npm-was-called');
    mkdirSync(bin);
    writeFileSync(join(bin, 'npm'), `#!/bin/sh\ntouch "${marker}"\nexit 99\n`);
    chmodSync(join(bin, 'npm'), 0o755);
    const env = {
      ...process.env,
      PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
    };
    execFileSync(process.execPath, [LEDGER_SCRIPT], { cwd: dir, env });
    const first = readFileSync(join(dir, LEDGER), 'utf8');
    execFileSync(process.execPath, [LEDGER_SCRIPT], { cwd: dir, env });
    expect(readFileSync(join(dir, LEDGER), 'utf8')).toBe(first);
    expect(existsSync(marker)).toBe(false);
  });
});

interface Step {
  name?: string;
  run?: string;
  if?: string;
  'continue-on-error'?: boolean;
}
type Workflow = { jobs: Record<string, { steps?: Step[] }> };

function workflowSteps(file: string): Step[] {
  const parsed = loadYaml(
    readFileSync(join(REPO_ROOT, '.github', 'workflows', file), 'utf8'),
  ) as Workflow;
  return Object.values(parsed.jobs).flatMap((j) => j.steps ?? []);
}

describe('the freshness guard stays deterministic (#1436)', () => {
  const guard = (): string => {
    const found = workflowSteps('harness-quality.yml').find(
      (s) => s.name === 'Security Ledger Freshness',
    );
    expect(found?.run).toBeDefined();
    return found!.run!;
  };

  /** Commit a fresh ledger pair, then run the guard's own script. */
  function runGuard(files: Record<string, string>) {
    const dir = makeRepo({ [TIMELINE]: timeline(0), ...files });
    render(dir);
    git(dir, 'add', '-A');
    git(dir, 'commit', '--quiet', '--no-verify', '-m', 'fresh ledger');
    return {
      dir,
      run: () =>
        spawnSync('bash', ['-e', '-c', guard()], {
          cwd: dir,
          encoding: 'utf8',
        }),
    };
  }

  it('passes with no sidecar at all, as on a PR before the first audit', () => {
    const r = runGuard({}).run();
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
  });

  it('passes with a non-zero sidecar: the count gates nothing', () => {
    const r = runGuard({ [SIDECAR]: measuredSidecar(4) }).run();
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
  });

  it('still fails a ledger that disagrees with its committed sidecar', () => {
    const { dir, run } = runGuard({ [SIDECAR]: measuredSidecar(4) });
    write(dir, SIDECAR, measuredSidecar(5));
    git(dir, 'add', '-A');
    git(dir, 'commit', '--quiet', '--no-verify', '-m', 'new audit, old ledger');
    expect(run().status).not.toBe(0);
  });
});

describe('harness-security.yml runs the audit as its own step (#1436)', () => {
  const steps = () => workflowSteps('harness-security.yml');
  const index = (re: RegExp) => steps().findIndex((s) => re.test(s.run ?? ''));

  it('audits before the renderer reads, on every run', () => {
    const audit = index(/node scripts\/supply_chain_audit\.mjs/);
    const refresh = index(/node scripts\/security_ledger\.mjs/);
    expect(audit).toBeGreaterThanOrEqual(0);
    expect(audit).toBeLessThan(refresh);
    // Not main-only: a broken step has to show on the PR that broke it.
    expect(steps()[audit]!.if).toBeUndefined();
    // Its exit code stays meaningful: only a crash of the script can fail it.
    expect(steps()[audit]!['continue-on-error']).toBeUndefined();
  });

  it('keeps the audit out of the renderer step', () => {
    expect(steps()[index(/security_ledger\.mjs/)]!.run).not.toMatch(/audit/);
  });
});
