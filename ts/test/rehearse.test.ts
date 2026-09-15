/**
 * Rehearsal gate (#834, ADR 0018): every detector and ratchet is run against a
 * planted defect and must FIRE on it.
 *
 * The failure this guards against is a detector that goes quiet. Quiet is
 * reported as a pass, so a gate that reads "0 findings" as green cannot tell a
 * clean tree from a dead instrument. These cases hold `scripts/rehearse.mjs` to
 * the ADR's three clauses: the denominator is printed (`n fired of n
 * expected`), a probe that examined zero items fails, and a required target
 * with no fixture fails rather than shrinking the denominator.
 *
 * The full end-to-end run (including canary-cassandra, which needs a built
 * engine) is wired in the `skills-validate` job; the last case here asserts
 * that wiring so the gate cannot be dropped from CI silently.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

interface Manifest {
  id: string;
  target: string;
  dir: string;
  expect: Record<string, unknown>;
}

interface ProbeResult {
  target: string;
  id?: string;
  examined: number;
  fired: boolean;
  detail: string;
}

interface Tally {
  exitCode: number;
  summary: string;
  lines: string[];
}

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'rehearse.mjs');
const FIXTURES = join(REPO_ROOT, 'rehearsal');

const { REQUIRED_TARGETS, loadManifests, runProbe, tally } = (await import(
  pathToFileURL(SCRIPT).href
)) as {
  REQUIRED_TARGETS: readonly string[];
  loadManifests: (root: string) => Manifest[];
  runProbe: (manifest: Manifest) => ProbeResult;
  tally: (results: ProbeResult[]) => Tally;
};

/** Targets whose probe runs without a built engine. */
const OFFLINE_TARGETS: string[] = REQUIRED_TARGETS.filter(
  (t) => t !== 'canary-cassandra',
);

describe('rehearsal fixtures', () => {
  const manifests = loadManifests(FIXTURES);

  it('covers all seven targets named by ADR 0018 and #834 F6', () => {
    expect([...REQUIRED_TARGETS].sort()).toEqual([
      'canary-blackhawk',
      'canary-cassandra',
      'canary-katana',
      'canary-savant',
      'duration-ratchet',
      'entropy-ratchet',
      'perf-ratchet',
    ]);
  });

  it('has exactly one fixture per required target', () => {
    const targets = manifests.map((m: { target: string }) => m.target).sort();
    expect(targets).toEqual([...REQUIRED_TARGETS].sort());
  });

  it.each(OFFLINE_TARGETS.map((t) => [t]))(
    '%s fires on its planted defect',
    (target: string) => {
      const m = manifests.find((x) => x.target === target);
      expect(m, `no fixture for ${target}`).toBeDefined();
      const result = runProbe(m as Manifest);
      expect(result.examined).toBeGreaterThan(0);
      expect(result.fired, result.detail).toBe(true);
    },
  );
});

describe('tally', () => {
  const fired = (target: string) => ({
    target,
    examined: 1,
    fired: true,
    detail: '',
  });

  it('passes only when every required target fired, and says n of n', () => {
    const out = tally(REQUIRED_TARGETS.map(fired));
    expect(out.exitCode).toBe(0);
    expect(out.summary).toBe('7 fired of 7 expected');
  });

  it('fails when one detector goes silent', () => {
    const results = REQUIRED_TARGETS.map(fired);
    results[0] = { ...results[0]!, fired: false };
    const out = tally(results);
    expect(out.exitCode).toBe(1);
    expect(out.summary).toBe('6 fired of 7 expected');
  });

  it('fails a probe that examined zero items even if it claims to fire', () => {
    const results = REQUIRED_TARGETS.map(fired);
    results[1] = { ...results[1]!, examined: 0 };
    const out = tally(results);
    expect(out.exitCode).toBe(1);
    expect(out.lines.join('\n')).toMatch(/examined zero items/);
  });

  it('fails when a required target has no fixture, never shrinking n', () => {
    const out = tally(REQUIRED_TARGETS.slice(1).map(fired));
    expect(out.exitCode).toBe(1);
    expect(out.summary).toBe('6 fired of 7 expected');
    expect(out.lines.join('\n')).toMatch(/no fixture/);
  });

  it('abstains (exit 3) when there are no results at all', () => {
    const out = tally([]);
    expect(out.exitCode).toBe(3);
  });
});

describe('probes do not mistake an error for a firing', () => {
  it('a detector pointed at an empty tree examines zero and does not fire', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rehearse-empty-'));
    mkdirSync(join(dir, 'tests'));
    const result = runProbe({
      id: 'empty',
      target: 'canary-blackhawk',
      dir,
      expect: { ruleId: 'BH001-wall-clock' },
    });
    expect(result.examined).toBe(0);
    expect(result.fired).toBe(false);
  });

  it('a ratchet with no report does not count its exit as a firing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rehearse-noreport-'));
    writeFileSync(join(dir, 'baseline.json'), '{"maxFindings":5}');
    const result = runProbe({
      id: 'noreport',
      target: 'entropy-ratchet',
      dir,
      expect: { exitCode: 1 },
    });
    expect(result.fired).toBe(false);
  });

  it('an unknown target is a failure, not a skip', () => {
    const result = runProbe({
      id: 'x',
      target: 'canary-nobody',
      dir: FIXTURES,
      expect: {},
    });
    expect(result.fired).toBe(false);
  });
});

describe('CLI', () => {
  it('prints the denominator and fails on an empty fixture root', () => {
    const empty = mkdtempSync(join(tmpdir(), 'rehearse-root-'));
    const r = spawnSync(process.execPath, [SCRIPT, '--root', empty], {
      encoding: 'utf8',
    });
    expect(r.status).toBe(3);
    expect(r.stdout + r.stderr).toMatch(/0 fired of 7 expected/);
  });
});

describe('CI wiring', () => {
  it('runs the rehearsal in the skills-validate job, after the engine build', () => {
    const yml = readFileSync(
      join(REPO_ROOT, '.github', 'workflows', 'harness-quality.yml'),
      'utf8',
    );
    const job = yml.slice(yml.indexOf('skills-validate:'));
    const build = job.indexOf('npm run build --prefix ts');
    const step = job.indexOf('node scripts/rehearse.mjs');
    expect(build).toBeGreaterThan(-1);
    expect(step).toBeGreaterThan(build);
    // Blocking: no continue-on-error and no `|| true` on the rehearsal line.
    const line = job.slice(step, job.indexOf('\n', step));
    expect(line).not.toMatch(/\|\|\s*true/);
  });
});
