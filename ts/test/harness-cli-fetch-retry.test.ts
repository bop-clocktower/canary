/**
 * The harness CLI fetch retries a registry blip; the checks never retry (#1533).
 *
 * On 2026-11-23 PR #1649 at one SHA had four required checks fail on
 * attempt 1 and pass on attempt 2. All four were fetching the CLI, not
 * checking anything: `npm install -g` and the `npx` behind check-deps got
 * `E404` on a just-published transitive tarball
 * (`@typescript-eslint/visitor-keys-8.74.0.tgz`), and both `Resolve harness
 * CLI version` steps printed `got ''` because `2>/dev/null` threw the cause
 * away. `HARNESS_CLI` floats at a major on purpose, so a fresh upstream
 * release is always the first thing CI fetches.
 *
 * The decision (human, fork F1=A): wrap ONLY the fetch in
 * `scripts/retry-fetch.mjs` — 3 attempts in total, 10s then 30s apart, a
 * `::warning::` naming every failed attempt and its error, and still red after
 * the last one. A check, test or validate result is never retried, because a
 * retry there turns a real failure into a pass.
 *
 * Three layers, each with a planted positive so a green is never vacuous:
 *   1. the workflow SHAPE: every fetch goes through the helper, and nothing
 *      but a fetch does;
 *   2. the helper's BEHAVIOUR with a fake command, not the network;
 *   3. a resolve step's real `run:` script under bash with a stubbed `npx`.
 */

import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as loadYaml } from 'js-yaml';
import { afterEach, describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORKFLOW_DIR = join(REPO_ROOT, '.github', 'workflows');
const HELPER = join(REPO_ROOT, 'scripts', 'retry-fetch.mjs');

type Step = { name?: string; id?: string; run?: string };
type Workflow = { jobs: Record<string, { steps?: Step[] }> };

/** The workflows that fetch the harness CLI, and how many fetches each has. */
const FETCHES: Record<string, number> = {
  'harness.yml': 1,
  'harness-quality.yml': 1,
  'harness-security.yml': 1,
  // resolve the float, then warm the npx cache for the exact version.
  'harness-architecture.yml': 2,
  'refresh-arch-baseline.yml': 1,
};

const WRAPPED = /node scripts\/retry-fetch\.mjs\b/;
/** A fetch and nothing else: an install, or a `--version` probe. */
const FETCH_ONLY =
  /^(?:npm install -g "\$HARNESS_CLI(?:_EXACT)?"|npx --yes -p "\$HARNESS_CLI(?:_EXACT)?" harness --version)$/;
/** A harness subcommand whose exit status is a verdict. */
const CHECK =
  /\bharness\s+(?:ci|check-[\w-]+|validate|cleanup|generate-[\w-]+)\b/;

const load = (text: string): Workflow => loadYaml(text) as Workflow;
const read = (file: string): string =>
  readFileSync(join(WORKFLOW_DIR, file), 'utf8');

/** Each `run:` line with `\` continuations joined, tagged with where it is. */
function lines(wf: Workflow): Array<{ where: string; line: string }> {
  return Object.entries(wf.jobs).flatMap(([job, { steps = [] }]) =>
    steps.flatMap((s, i) =>
      (s.run ?? '')
        .replace(/\\\n\s*/g, ' ')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#'))
        .map((line) => ({ where: `${job} / ${s.name ?? `#${i}`}`, line })),
    ),
  );
}

/** What the helper wraps on this line: the command after its `--`. */
function wrappedCommand(line: string): string | undefined {
  const m =
    /node scripts\/retry-fetch\.mjs(?: --[\w-]+)* -- (.*?)\s*(?:>\s*\/dev\/null|\)?"?\s*\|.*)?$/.exec(
      line,
    );
  return m?.[1]?.trim();
}

/** Violations of the #1533 shape; empty means the workflow is correct. */
function violations(wf: Workflow): string[] {
  const out: string[] = [];
  for (const { where, line } of lines(wf)) {
    const wrapped = WRAPPED.test(line);
    if (wrapped) {
      const cmd = wrappedCommand(line);
      if (!cmd || !FETCH_ONLY.test(cmd)) {
        out.push(`${where}: retry wraps more than a fetch: ${line}`);
      }
      continue;
    }
    if (/npm install -g/.test(line) || /"\$HARNESS_CLI"/.test(line)) {
      out.push(`${where}: fetches the CLI with no bounded retry: ${line}`);
    }
  }
  return out;
}

function fetchCount(wf: Workflow): number {
  return lines(wf).filter(({ line }) => WRAPPED.test(line)).length;
}

describe('every harness CLI fetch goes through the bounded retry (#1533)', () => {
  it.each(Object.entries(FETCHES))(
    '%s wraps its %i fetch(es) and nothing else',
    (file, count) => {
      const wf = load(read(file));
      expect(fetchCount(wf)).toBe(count); // denominator, not a vacuous pass
      expect(violations(wf)).toEqual([]);
    },
  );

  it('no check, validate or test line is ever retried', () => {
    const checks = Object.keys(FETCHES).flatMap((file) =>
      lines(load(read(file))).filter(({ line }) => CHECK.test(line)),
    );
    // check-deps + validate (architecture), check-deps/check-security/
    // validate (security), ci/check-arch (harness), the quality scans...
    expect(checks.length).toBeGreaterThan(10);
    expect(checks.filter(({ line }) => WRAPPED.test(line))).toEqual([]);
  });

  it('runs check-deps and validate once each, on the exact resolved version', () => {
    const steps = load(read('harness-architecture.yml')).jobs[
      'deps-and-validate'
    ]!.steps!;
    const resolve = steps.findIndex((s) => s.id === 'harness-cli');
    const at = (sub: string) =>
      steps.findIndex((s) =>
        (s.run ?? '').includes(`-p "$HARNESS_CLI_EXACT" harness ${sub}`),
      );
    expect(resolve).toBeGreaterThan(-1);
    expect(at('check-deps')).toBeGreaterThan(resolve);
    expect(at('validate')).toBeGreaterThan(resolve);
  });

  describe('the checker catches a planted regression', () => {
    it('a bare npm install -g', () => {
      const planted = read('harness.yml').replace(
        'node scripts/retry-fetch.mjs -- npm install -g',
        'npm install -g',
      );
      expect(violations(load(planted))).toEqual([
        expect.stringMatching(/no bounded retry/),
      ]);
    });

    it('a check run on the float', () => {
      const planted = read('harness-architecture.yml').replace(
        '"$HARNESS_CLI_EXACT" harness check-deps',
        '"$HARNESS_CLI" harness check-deps',
      );
      expect(violations(load(planted))).toEqual([
        expect.stringMatching(/no bounded retry: .*check-deps/),
      ]);
    });

    it('a check wrapped in the retry', () => {
      const planted = read('harness-architecture.yml').replace(
        'run: npx --yes -p "$HARNESS_CLI_EXACT" harness check-deps',
        'run: node scripts/retry-fetch.mjs -- npx --yes -p "$HARNESS_CLI_EXACT" harness check-deps',
      );
      expect(planted).not.toBe(read('harness-architecture.yml'));
      expect(violations(load(planted))).toEqual([
        expect.stringMatching(/retry wraps more than a fetch/),
      ]);
    });
  });
});

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

/**
 * A fake fetch: fails (exit 1, an E404 on stderr) until attempt `okOn`, then
 * prints `out`. `okOn` 0 never succeeds. It counts its own attempts in a file.
 */
function fake(okOn: number, out = 'installed'): string[] {
  dir = mkdtempSync(join(tmpdir(), 'retry-fetch-'));
  const counter = join(dir, 'n');
  writeFileSync(counter, '0');
  const body = `const fs=require('fs');const n=+fs.readFileSync(${JSON.stringify(
    counter,
  )},'utf8')+1;fs.writeFileSync(${JSON.stringify(counter)},String(n));
if(${okOn}&&n>=${okOn}){process.stdout.write(${JSON.stringify(out)}+'\\n');process.exit(0)}
process.stderr.write('npm error code E404\\nnpm error 404 Not Found - GET visitor-keys-8.74.0.tgz\\n');process.exit(1)`;
  return [process.execPath, '-e', body];
}

const attempts = (): number => +readFileSync(join(dir!, 'n'), 'utf8');

function helper(args: string[]) {
  return spawnSync(process.execPath, [HELPER, ...args], {
    encoding: 'utf8',
    env: { ...process.env, RETRY_FETCH_BACKOFF_MS: '0,0' },
  });
}

const warnings = (stderr: string): string[] =>
  stderr.split('\n').filter((l) => l.startsWith('::warning'));

describe('scripts/retry-fetch.mjs (#1533)', () => {
  it('declares a small fixed attempt bound and a 10s/30s backoff', () => {
    const src = readFileSync(HELPER, 'utf8');
    expect(src).toMatch(/^const MAX_ATTEMPTS = 3;$/m);
    expect(src).toMatch(/^const BACKOFF_SECONDS = \[10, 30\];$/m);
  });

  it('succeeds on attempt 2 and warns about attempt 1', () => {
    const r = helper(['--', ...fake(2)]);
    expect(r.status).toBe(0);
    expect(attempts()).toBe(2);
    expect(r.stdout).toBe('installed\n');
    const w = warnings(r.stderr);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/attempt 1\/3/);
    expect(w[0]).toMatch(/E404/); // the cause, not just "failed"
    expect(w[0]).toMatch(/retrying in 10s/);
  });

  it('stays red after 3 attempts, warning on each, and stops there', () => {
    const r = helper(['--', ...fake(0)]);
    expect(r.status).toBe(1);
    expect(attempts()).toBe(3);
    const w = warnings(r.stderr);
    expect(w).toHaveLength(3);
    expect(w.map((l) => /attempt (\d)\/3/.exec(l)?.[1])).toEqual([
      '1',
      '2',
      '3',
    ]);
    expect(w[1]).toMatch(/retrying in 30s/);
    expect(w[2]).toMatch(/giving up/);
    expect(r.stderr).toMatch(/^::error[^\n]*after 3 attempts/m);
  });

  it('keeps every warning on one line (multi-line stderr is %0A-escaped)', () => {
    const r = helper(['--', ...fake(0)]);
    const w = warnings(r.stderr);
    expect(w).toHaveLength(3);
    for (const line of w) expect(line).toMatch(/E404%0Anpm error 404/);
  });

  describe('--expect-semver', () => {
    it("retries an exit-0 fetch that printed no version (the `got ''` case)", () => {
      const r = helper(['--expect-semver', '--', ...fake(1, '')]);
      expect(r.status).toBe(1);
      expect(attempts()).toBe(3);
      expect(warnings(r.stderr)[0]).toMatch(/no version/);
    });

    it('prints only the version on stdout', () => {
      const r = helper(['--expect-semver', '--', ...fake(2, 'noise\n14.1.1')]);
      expect(r.status).toBe(0);
      expect(r.stdout).toBe('14.1.1\n');
    });
  });

  it('refuses a call with no `--` command (usage error, exit 2)', () => {
    const r = helper(['npm', 'install']);
    expect(r.status).toBe(2);
  });
});

describe('the architecture resolve step, run for real with a stub npx', () => {
  function runResolve(failures: number) {
    dir = mkdtempSync(join(tmpdir(), 'arch-resolve-'));
    const counter = join(dir, 'n');
    writeFileSync(counter, '0');
    const stub = join(dir, 'npx');
    writeFileSync(
      stub,
      `#!/bin/bash\nn=$(( $(cat "${counter}") + 1 ))\necho $n > "${counter}"\n` +
        `if [ $n -le ${failures} ]; then echo "npm error code E404" >&2; exit 1; fi\n` +
        `echo 14.1.1\n`,
    );
    chmodSync(stub, 0o755);
    const env = join(dir, 'env');
    writeFileSync(env, '');
    const step = load(read('harness-architecture.yml')).jobs[
      'deps-and-validate'
    ]!.steps!.find((s) => s.id === 'harness-cli')!;
    const r = spawnSync('bash', ['-e', '-c', step.run!], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: {
        PATH: `${dir}:${process.env.PATH}`,
        HARNESS_CLI: '@harness-engineering/cli@14',
        GITHUB_ENV: env,
        RETRY_FETCH_BACKOFF_MS: '0,0',
      },
    });
    return { ...r, env: readFileSync(env, 'utf8'), attempts: attempts() };
  }

  it('rides out one registry failure and exports the exact version', () => {
    const r = runResolve(1);
    expect(r.status).toBe(0);
    expect(r.env).toBe('HARNESS_CLI_EXACT=@harness-engineering/cli@14.1.1\n');
    expect(warnings(r.stderr)).toHaveLength(1);
  });

  it('goes red when the registry never answers, and names the cause', () => {
    const r = runResolve(99);
    expect(r.status).not.toBe(0);
    expect(r.attempts).toBe(3);
    expect(r.env).toBe('');
    expect(warnings(r.stderr).every((w) => /E404/.test(w))).toBe(true);
  });
});
