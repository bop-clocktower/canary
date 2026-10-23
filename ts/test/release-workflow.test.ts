/**
 * Release workflow contract (#1185).
 *
 * v9.0.0 shipped half a release: `Create GitHub Release` ran before `Publish
 * npm package`, the publish then failed on an expired `NPM_TOKEN`, and the tag
 * was left with a GitHub Release that npm could not install. Two defects, two
 * guards:
 *
 * 1. Order. npm is the distribution channel; the GitHub Release is the
 *    announcement. Publish first, so a failed publish announces nothing.
 * 2. Auth. A stored token expires (granular npm tokens live ≤90 days) and
 *    fails as an opaque E404. npm trusted publishing (OIDC) has no secret to
 *    expire; it needs `id-token: write` and npm ≥ 11.5.1, which Node 22's
 *    bundled npm 10 is not.
 *
 * Plus re-run safety: once npm has a version, publishing it again is E403, so
 * re-running the workflow must skip that publish rather than fail on it.
 *
 * And the job graph (#1439, ADR 0042): bin verification is its own job that
 * gates the git `latest` advance but never the GitHub Release.
 *
 * Offline: reads workflow YAML. The #1331 poll tests run the real step body
 * under bash against a fake `npm` and `sleep`; nothing touches the registry.
 */

import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as loadYaml } from 'js-yaml';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const RAW = readFileSync(
  join(REPO_ROOT, '.github/workflows/release.yml'),
  'utf8',
);

interface Step {
  id?: string;
  name?: string;
  'continue-on-error'?: unknown;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
}
interface Job {
  needs?: string | string[];
  if?: string;
  'continue-on-error'?: unknown;
  outputs?: Record<string, string>;
  permissions?: Record<string, string>;
  steps: Step[];
}
interface Workflow {
  permissions?: Record<string, string>;
  jobs: Record<string, Job>;
}

const wf = loadYaml(RAW) as Workflow;
const publish = wf.jobs.publish;
if (!publish) throw new Error('release.yml has no `publish` job');
const steps = publish.steps;

function indexOf(pred: (s: Step) => boolean, label: string): number {
  const i = steps.findIndex(pred);
  if (i < 0) throw new Error(`release.yml publish job has no ${label} step`);
  return i;
}

/** The `run` script of the first step matching `pred`. */
function runOf(pred: (s: Step) => boolean, label: string): string {
  return steps[indexOf(pred, label)]?.run ?? '';
}

const isNpmPublish = (s: Step) => /\bnpm publish\b/.test(s.run ?? '');
const isGhRelease = (s: Step) =>
  (s.uses ?? '').startsWith('softprops/action-gh-release');
const isBinCheck = (s: Step) =>
  /\bnpm view\b/.test(s.run ?? '') &&
  /\bbin\b/.test(s.run ?? '') &&
  !isNpmPublish(s);

/** The job named `name`, or a thrown error naming what is missing. */
function job(name: string): Job {
  const j = wf.jobs[name];
  if (!j) throw new Error(`release.yml has no \`${name}\` job`);
  return j;
}

/** A job's `needs:` as a list (GitHub accepts a string or a list). */
function needsOf(name: string): string[] {
  const n = job(name).needs;
  return n === undefined ? [] : Array.isArray(n) ? n : [n];
}

/** Every job `name` waits on, directly or through another job. */
function ancestorsOf(name: string, seen = new Set<string>()): Set<string> {
  for (const n of needsOf(name)) {
    if (!seen.has(n)) {
      seen.add(n);
      ancestorsOf(n, seen);
    }
  }
  return seen;
}

/** Names of the jobs that hold a step matching `pred`. */
function jobsWith(pred: (s: Step) => boolean): string[] {
  return Object.entries(wf.jobs)
    .filter(([, j]) => (j.steps ?? []).some(pred))
    .map(([n]) => n);
}

/** The bin-check step's `run` script, read from the `verify-bins` job. */
function binCheckRun(): string {
  const s = job('verify-bins').steps.find(isBinCheck);
  if (!s) throw new Error('release.yml verify-bins job has no bin-check step');
  return s.run ?? '';
}

describe('release.yml (#1185)', () => {
  it('publishes to npm before creating the GitHub Release', () => {
    const pub = indexOf(isNpmPublish, 'npm publish');
    const rel = indexOf(isGhRelease, 'GitHub Release');
    expect(pub).toBeLessThan(rel);
  });

  it('uses trusted publishing: no stored npm token anywhere', () => {
    expect(RAW).not.toMatch(/NPM_TOKEN/);
    expect(RAW).not.toMatch(/NODE_AUTH_TOKEN/);
  });

  it('grants id-token: write to the publish job', () => {
    const perm =
      publish.permissions?.['id-token'] ?? wf.permissions?.['id-token'];
    expect(perm).toBe('write');
  });

  it('upgrades npm to a trusted-publishing-capable version before publishing', () => {
    const isUpgrade = (s: Step) =>
      /\bnpm (?:i|install) (?:-g|--global) npm@/.test(s.run ?? '');
    expect(indexOf(isUpgrade, 'npm upgrade')).toBeLessThan(
      indexOf(isNpmPublish, 'npm publish'),
    );
    const spec = /npm@(\S+)/.exec(runOf(isUpgrade, 'npm upgrade'))?.[1] ?? '';
    // 11.5.1 is the first npm with OIDC trusted publishing. Accept a caret or
    // an exact pin at or above it; reject `latest` (an unannounced major could
    // change publish behaviour mid-release).
    const m = /^\^?(\d+)\.(\d+)\.(\d+)$/.exec(spec);
    if (!m) throw new Error(`npm@${spec} is not a pinned or caret version`);
    const [maj, min, pat] = [m[1], m[2], m[3]].map(Number) as [
      number,
      number,
      number,
    ];
    expect(maj * 1e6 + min * 1e3 + pat).toBeGreaterThanOrEqual(11_005_001);
  });

  it('still publishes with provenance', () => {
    expect(runOf(isNpmPublish, 'npm publish')).toMatch(/--provenance\b/);
  });

  // #1252: "the CLI shipped" was inferred from a green publish step while npm
  // printed "bin ... was invalid and removed" on every release. The registry's
  // manifest is the only proof the bins shipped, so read it back.
  describe('published-manifest bin check (#1252)', () => {
    // ADR 0042 / #1439: the check lives in its own `verify-bins` job. It gates
    // the git `latest` advance but not the GitHub Release, because the npm
    // publish the Release announces has already happened.
    describe('job graph (ADR 0042, #1439)', () => {
      it('runs in exactly one job, verify-bins, and never inside publish', () => {
        expect(jobsWith(isBinCheck)).toEqual(['verify-bins']);
      });

      it('verify-bins needs publish', () => {
        expect(needsOf('verify-bins')).toContain('publish');
      });

      it('the GitHub Release never waits on verify-bins', () => {
        const releaseJobs = jobsWith(isGhRelease);
        expect(releaseJobs).toHaveLength(1);
        const rel = releaseJobs[0] as string;
        expect(rel).not.toBe('verify-bins');
        expect([...ancestorsOf(rel)]).not.toContain('verify-bins');
        // ...but it still waits on the npm publish (#1185).
        expect(rel === 'publish' || ancestorsOf(rel).has('publish')).toBe(true);
      });

      it('advance-latest needs both publish and verify-bins', () => {
        expect(needsOf('advance-latest')).toEqual(
          expect.arrayContaining(['publish', 'verify-bins']),
        );
      });

      it('advance-latest does not override the implicit success() gate', () => {
        // An `if:` with always()/failure()/!cancelled() would run the job
        // after verify-bins failed or abstained, moving latest unverified.
        expect(job('advance-latest').if ?? '').not.toMatch(
          /always\(\)|failure\(\)|cancelled\(\)/,
        );
      });

      it('never lets the check fail soft (ADR 0009: exit 3 is not a pass)', () => {
        const vb = job('verify-bins');
        expect(vb['continue-on-error']).toBeUndefined();
        for (const s of vb.steps) {
          expect(s['continue-on-error'], s.name).toBeUndefined();
        }
      });

      it('verify-bins only reads the repo: no write, no OIDC token', () => {
        expect(job('verify-bins').permissions).toEqual({ contents: 'read' });
        expect(wf.permissions?.['id-token']).not.toBe('write');
        expect(wf.permissions?.contents).not.toBe('write');
      });

      it('verifies the version publish reports, passed as a job output', () => {
        const outputs = job('publish').outputs ?? {};
        expect(Object.keys(outputs)).toEqual(
          expect.arrayContaining(['name', 'version']),
        );
        const step = job('verify-bins').steps.find(isBinCheck);
        expect(step?.env?.NAME).toMatch(/needs\.publish\.outputs\.name/);
        expect(step?.env?.VERSION).toMatch(/needs\.publish\.outputs\.version/);
      });
    });

    it('checks every bin the local manifest declares, not a hardcoded subset', () => {
      const run = binCheckRun();
      expect(run).toMatch(/require\(['"]\.\/package\.json['"]\)\.bin/);
      expect(run).toMatch(/exit 1|process\.exit\(1\)/);
    });

    it('abstains with exit 3 (not a pass) when the version is not visible yet', () => {
      const run = binCheckRun();
      expect(run).toMatch(/\bexit 3\b/);
      expect(run).toMatch(/::error::/);
      // No `exit 0` path anywhere in the check: a pass is only the bin
      // comparison falling through.
      expect(run).not.toMatch(/\bexit 0\b/);
    });

    // #1331: v9.3.0 published fine, but npm said "may take a few minutes to
    // become available" and the old 6 x 10 s poll gave up at ~60 s, skipping
    // the GitHub Release and the latest advance. These run the REAL step body
    // against a fake `npm` (visible from the Nth `npm view ... version`) and a
    // fake `sleep` that only records its argument, so a 10-minute window
    // costs milliseconds and nothing touches the registry.
    describe('registry-visibility poll window (#1331)', () => {
      /** Writes an executable fake into `bin`. */
      function writeFake(bin: string, name: string, lines: string[]) {
        const path = join(bin, name);
        writeFileSync(path, ['#!/usr/bin/env bash', ...lines, ''].join('\n'));
        chmodSync(path, 0o755);
      }

      /**
       * A temp package dir plus fake `npm` (version visible from probe
       * `visibleAt`, bins always complete) and `sleep` (records, never waits).
       */
      function fakeRegistry(
        visibleAt: number,
        publishedBins = '{"canary":"bin/canary.js"}',
      ) {
        const dir = mkdtempSync(join(tmpdir(), 'release-poll-'));
        const bin = join(dir, 'fakebin');
        mkdirSync(bin);
        writeFileSync(
          join(dir, 'package.json'),
          JSON.stringify({
            name: 'canary-test-cli',
            version: '9.9.9',
            bin: { canary: 'bin/canary.js' },
          }),
        );
        const probes = join(dir, 'probes');
        const sleeps = join(dir, 'sleeps');
        writeFake(bin, 'npm', [
          `if [ "$3" = "bin" ]; then echo '${publishedBins}'; exit 0; fi`,
          `echo x >> "${probes}"`,
          `n=$(wc -l < "${probes}")`,
          `[ "$n" -ge ${visibleAt} ] && echo 9.9.9`,
          'exit 0',
        ]);
        writeFake(bin, 'sleep', [`echo "$1" >> "${sleeps}"`]);
        return { dir, bin, probes, sleeps };
      }

      const lines = (f: string) =>
        existsSync(f)
          ? readFileSync(f, 'utf8').split('\n').filter(Boolean)
          : [];

      /**
       * Runs the real step body. NAME/VERSION arrive through env, as the
       * workflow passes them from `needs.publish.outputs`; the step summary
       * goes to a temp file standing in for `$GITHUB_STEP_SUMMARY`.
       */
      function runPoll(
        visibleAt: number,
        opts: { bins?: string; name?: string; version?: string } = {},
      ) {
        const { dir, bin, probes, sleeps } = fakeRegistry(visibleAt, opts.bins);
        const summary = join(dir, 'step-summary.md');
        const r = spawnSync(
          'bash',
          // GitHub's default `run:` shell flags, so errexit/pipefail apply.
          ['--noprofile', '--norc', '-eo', 'pipefail', '-c', binCheckRun()],
          {
            cwd: dir,
            encoding: 'utf-8',
            env: {
              ...process.env,
              PATH: `${bin}${delimiter}${process.env.PATH}`,
              NAME: opts.name ?? 'canary-test-cli',
              VERSION: opts.version ?? '9.9.9',
              GITHUB_STEP_SUMMARY: summary,
            },
          },
        );
        return {
          status: r.status,
          out: `${r.stdout}${r.stderr}`,
          probes: lines(probes).length,
          sleeps: lines(sleeps).map(Number),
          summary: existsSync(summary) ? readFileSync(summary, 'utf8') : '',
        };
      }

      // #1439: the verdict has to be readable on the run page, not only in
      // the step log. An abstention must say the bins were NOT verified.
      it('writes "NOT verified" to the step summary when it abstains', () => {
        const r = runPoll(9999);
        expect(r.status).toBe(3);
        expect(r.summary).toMatch(/NOT verified/);
        expect(r.summary).toMatch(/latest.*not.*advance|not advance/i);
      });

      it('abstains (exit 3, no registry probe) when publish passed no version', () => {
        const r = runPoll(1, { version: '' });
        expect(r.status).toBe(3);
        expect(r.probes).toBe(0);
        expect(r.out).toMatch(/::error::.*NOT verified/);
        expect(r.summary).toMatch(/NOT verified/);
      });

      it('fails with exit 1 and names the bin when the manifest lost one', () => {
        const r = runPoll(1, { bins: '{}' });
        expect(r.status).toBe(1);
        expect(r.out).toMatch(/missing bin\(s\): canary/);
        expect(r.summary).toMatch(/missing/i);
        expect(r.summary).toMatch(/canary/);
      });

      it('records the verified bins in the step summary on a pass', () => {
        const r = runPoll(1);
        expect(r.status).toBe(0);
        expect(r.summary).toMatch(/verified/i);
        expect(r.summary).not.toMatch(/NOT verified/);
      });

      it('keeps polling past the old 60 s window and verifies a late version', () => {
        // Visible on the 8th probe: the old 6-attempt loop abstained here.
        const r = runPoll(8);
        expect(r.status).toBe(0);
        expect(r.out).toMatch(/published bins:/);
        expect(r.probes).toBe(8);
      });

      it('spans 20 probes 30 s apart (~10 min) before abstaining with exit 3', () => {
        const r = runPoll(9999);
        expect(r.status).toBe(3);
        expect(r.out).toMatch(/::error::.*NOT verified/);
        expect(r.probes).toBe(20);
        expect(r.sleeps.every((s) => s === 30)).toBe(true);
        // No pointless sleep after the final probe: 19 gaps between 20 probes.
        expect(r.sleeps.reduce((a, b) => a + b, 0)).toBe(19 * 30);
      });

      it('does not sleep at all when the version is visible on the first probe', () => {
        const r = runPoll(1);
        expect(r.status).toBe(0);
        expect(r.probes).toBe(1);
        expect(r.sleeps).toEqual([]);
      });
    });
  });

  it('skips the publish on a re-run when npm already has the version', () => {
    const run = runOf(isNpmPublish, 'npm publish');
    expect(run).toMatch(/npm view\b/);
    // The skip must be explicit in the log, never a silent exit 0.
    expect(run).toMatch(/already (?:on|published)/i);
  });
});
