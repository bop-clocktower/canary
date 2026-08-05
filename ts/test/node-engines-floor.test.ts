/**
 * Node-floor consistency contract for the published package (#559).
 *
 * `canary-test-cli` declared `engines.node: ">=18"` while the engine it bundles
 * was only ever compiled and executed on 22 — `ts/package.json` asks for `>=22`
 * and the release workflow builds on 22. npm enforces `engines` as a hard error
 * only for a version BELOW the floor, so a Node 18 user installed cleanly, saw
 * no warning, and would have met the first unsupported syntax at runtime inside
 * a command. The claim was unbacked in both directions: nothing proved 18 worked
 * and nothing prevented saying so.
 *
 * Why this is a separate file from `version-consistency.test.ts`: that file
 * guards the release VERSION and explicitly rules README badges out of scope as
 * "display artifacts". Correct there — `bump-version.mjs` stamps the version
 * badge mechanically, so it cannot drift. Nothing stamps the NODE badge, which
 * is precisely why it sat at `python-3.11+` for six releases and then at `18+`.
 * An unstamped badge is a declaration, not a display artifact.
 *
 * Scope: only `npm/package.json` makes a user-facing claim. `ts/package.json`
 * and `agents/skills/package.json` are both `private: true` and never published
 * (`@canary/skills` 404s on the registry), so their floors are development
 * constraints. `agents/skills` sitting at `>=20` is therefore NOT a violation
 * and is deliberately not asserted here — do not "align" it without a reason
 * that survives this paragraph.
 *
 * Offline: reads manifests, the README, and workflow YAML. Executes nothing.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as loadYaml } from 'js-yaml';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** `>=22` / `>= 22` / `>=22.0.0` -> 22. Throws on any other shape. */
function floorMajor(range: string, label: string): number {
  const m = /^>=\s*(\d+)(?:\.\d+)*$/.exec(range.trim());
  if (!m) {
    throw new Error(
      `${label} engines.node '${range}' is not a plain '>=N' floor. ` +
        `This contract only understands a simple floor — if the range grew ` +
        `real complexity, update this test deliberately rather than widening ` +
        `the regex until it matches.`,
    );
  }
  return Number(m[1]);
}

function enginesNode(rel: string): string {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, rel), 'utf-8')) as {
    engines?: { node?: string };
  };
  const node = pkg.engines?.node;
  if (!node) throw new Error(`${rel} declares no engines.node`);
  return node;
}

const PUBLISHED = 'npm/package.json';
const BUNDLED_SOURCE = 'ts/package.json';

/** The `node-NN+` shields.io badge in the README header. */
function readmeBadgeMajor(): number {
  const readme = readFileSync(join(REPO_ROOT, 'README.md'), 'utf-8');
  const m = /!\[node\]\(https:\/\/img\.shields\.io\/badge\/node-(\d+)\+-/.exec(
    readme,
  );
  if (!m) {
    throw new Error(
      'README.md has no ![node](…/badge/node-NN+-…) badge. It is the ' +
        'user-facing statement of the runtime requirement; a release that ' +
        'drops it silently removes the only thing a reader sees before they ' +
        'install.',
    );
  }
  return Number(m[1]);
}

/**
 * The prose requirement in the install section. Separate from the badge because
 * they drifted independently: at #558 the badge said `python-3.11+` while the
 * prose stated a per-OS binary matrix. A reader believes whichever they hit
 * first, so both have to agree with the manifest.
 */
function readmeProseMajor(): number {
  const readme = readFileSync(join(REPO_ROOT, 'README.md'), 'utf-8');
  const m = /\*\*Requires Node (\d+) or newer\.\*\*/.exec(readme);
  if (!m) {
    throw new Error(
      'README.md has no "**Requires Node N or newer.**" line in the install ' +
        'section. Keep the wording — this contract reads it.',
    );
  }
  return Number(m[1]);
}

interface Workflow {
  jobs?: Record<
    string,
    { name?: string; steps?: Array<{ with?: { 'node-version'?: unknown } }> }
  >;
}

function workflow(rel: string): Workflow {
  return loadYaml(readFileSync(join(REPO_ROOT, rel), 'utf-8')) as Workflow;
}

/** Every `setup-node` `node-version` in a workflow, as majors. */
function setupNodeMajors(wf: Workflow): number[] {
  const out: number[] = [];
  for (const job of Object.values(wf.jobs ?? {})) {
    for (const step of job.steps ?? []) {
      const v = step.with?.['node-version'];
      if (v !== undefined) out.push(Number(String(v).split('.')[0]));
    }
  }
  return out;
}

describe('node engines floor', () => {
  it('the published floor is not below what the bundled engine needs', () => {
    const published = floorMajor(enginesNode(PUBLISHED), PUBLISHED);
    const bundled = floorMajor(enginesNode(BUNDLED_SOURCE), BUNDLED_SOURCE);

    expect(
      published,
      `${PUBLISHED} promises node>=${published}, but its bundled engine is ` +
        `built from ${BUNDLED_SOURCE} which requires node>=${bundled}. npm ` +
        `only errors BELOW the declared floor, so a node ${published} user ` +
        `installs with no warning and fails at runtime instead. Raise the ` +
        `published floor to ${bundled}, or lower the source requirement and ` +
        `prove it.`,
    ).toBeGreaterThanOrEqual(bundled);
  });

  it('the README badge states the published floor', () => {
    const published = floorMajor(enginesNode(PUBLISHED), PUBLISHED);

    expect(
      readmeBadgeMajor(),
      `README node badge says node-${readmeBadgeMajor()}+ but ` +
        `${PUBLISHED} declares node>=${published}. Nothing stamps this badge ` +
        `automatically (unlike the version badge, which bump-version.mjs ` +
        `writes), so it drifts unless something asserts it.`,
    ).toBe(published);
  });

  it('the README install prose states the published floor', () => {
    const published = floorMajor(enginesNode(PUBLISHED), PUBLISHED);

    expect(
      readmeProseMajor(),
      `README install prose says "Requires Node ${readmeProseMajor()} or ` +
        `newer" but ${PUBLISHED} declares node>=${published}. The badge and ` +
        `the prose drifted apart independently once already (#558).`,
    ).toBe(published);
  });

  it('the release build runs on a version satisfying the published floor', () => {
    const published = floorMajor(enginesNode(PUBLISHED), PUBLISHED);
    const majors = setupNodeMajors(workflow('.github/workflows/release.yml'));

    expect(
      majors.length,
      'release.yml declares no setup-node version — cannot confirm what the ' +
        'published artifact is built with, which is an abstention, not a pass.',
    ).toBeGreaterThan(0);

    for (const major of majors) {
      expect(
        major,
        `release.yml builds the published artifact on node ${major}, below ` +
          `the declared floor of ${published}. The tarball users install ` +
          `would be compiled by a runtime we tell them not to use.`,
      ).toBeGreaterThanOrEqual(published);
    }
  });

  it('the packed-install dogfood job runs on exactly the published floor', () => {
    const published = floorMajor(enginesNode(PUBLISHED), PUBLISHED);
    const wf = workflow('.github/workflows/dogfood.yml');

    const packed = Object.values(wf.jobs ?? {}).find((j) =>
      /packed install/i.test(j.name ?? ''),
    );
    expect(
      packed,
      'dogfood.yml has no job whose name mentions "packed install". That job ' +
        'is the only place the PUBLISHED artifact is exercised rather than ' +
        'the checkout; without it the floor is a claim nothing tests.',
    ).toBeDefined();

    const majors = setupNodeMajors({ jobs: { packed: packed! } });
    expect(
      majors,
      `the packed-install job must run on exactly node ${published}, the ` +
        `lowest version we tell users is supported. Running it only on a ` +
        `newer Node means the floor itself is never exercised — the same ` +
        `untested-claim shape as #559 itself.`,
    ).toContain(published);
  });
});
