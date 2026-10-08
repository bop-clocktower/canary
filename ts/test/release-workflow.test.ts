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
 * a re-run after a later step failed must skip the publish rather than fail.
 *
 * Offline: reads workflow YAML. Executes nothing.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
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

  it('skips the publish on a re-run when npm already has the version', () => {
    const run = runOf(isNpmPublish, 'npm publish');
    expect(run).toMatch(/npm view\b/);
    // The skip must be explicit in the log, never a silent exit 0.
    expect(run).toMatch(/already (?:on|published)/i);
  });
});
