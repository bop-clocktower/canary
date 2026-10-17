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
  name?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
}
interface Job {
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
    const isBinCheck = (s: Step) =>
      /\bnpm view\b/.test(s.run ?? '') && /\bbin\b/.test(s.run ?? '');
    const isCheckAfterPublish = (s: Step) => isBinCheck(s) && !isNpmPublish(s);

    it('sits between the npm publish step and the GitHub Release step', () => {
      const check = indexOf(isCheckAfterPublish, 'published-manifest bin');
      expect(check).toBeGreaterThan(indexOf(isNpmPublish, 'npm publish'));
      expect(check).toBeLessThan(indexOf(isGhRelease, 'GitHub Release'));
    });

    it('checks every bin the local manifest declares, not a hardcoded subset', () => {
      const run = runOf(isCheckAfterPublish, 'published-manifest bin');
      expect(run).toMatch(/require\(['"]\.\/package\.json['"]\)\.bin/);
      expect(run).toMatch(/exit 1|process\.exit\(1\)/);
    });

    it('abstains with exit 3 (not a pass) when the version is not visible yet', () => {
      const run = runOf(isCheckAfterPublish, 'published-manifest bin');
      expect(run).toMatch(/\bexit 3\b/);
      expect(run).toMatch(/::error::/);
    });

    // #1331: v9.3.0 published fine, but npm said "may take a few minutes to
    // become available" and the old 6 x 10 s poll gave up at ~60 s, skipping
    // the GitHub Release and the latest advance. These run the REAL step body
    // against a fake `npm` (visible from the Nth `npm view ... version`) and a
    // fake `sleep` that only records its argument, so a 10-minute window
    // costs milliseconds and nothing touches the registry.
    describe('registry-visibility poll window (#1331)', () => {
      function runPoll(visibleAt: number) {
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
        writeFileSync(
          join(bin, 'npm'),
          [
            '#!/usr/bin/env bash',
            'if [ "$3" = "bin" ]; then echo \'{"canary":"bin/canary.js"}\'; exit 0; fi',
            `echo x >> "${probes}"`,
            `n=$(wc -l < "${probes}")`,
            `[ "$n" -ge ${visibleAt} ] && echo 9.9.9`,
            'exit 0',
            '',
          ].join('\n'),
        );
        writeFileSync(
          join(bin, 'sleep'),
          `#!/usr/bin/env bash\necho "$1" >> "${sleeps}"\n`,
        );
        chmodSync(join(bin, 'npm'), 0o755);
        chmodSync(join(bin, 'sleep'), 0o755);
        const r = spawnSync(
          'bash',
          // GitHub's default `run:` shell flags, so errexit/pipefail apply.
          [
            '--noprofile',
            '--norc',
            '-eo',
            'pipefail',
            '-c',
            runOf(isCheckAfterPublish, 'published-manifest bin'),
          ],
          {
            cwd: dir,
            encoding: 'utf-8',
            env: {
              ...process.env,
              PATH: `${bin}${delimiter}${process.env.PATH}`,
            },
          },
        );
        const lines = (f: string) =>
          existsSync(f)
            ? readFileSync(f, 'utf8').split('\n').filter(Boolean)
            : [];
        return {
          status: r.status,
          out: `${r.stdout}${r.stderr}`,
          probes: lines(probes).length,
          sleeps: lines(sleeps).map(Number),
        };
      }

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
