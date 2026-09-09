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

import { readdirSync, readFileSync } from 'node:fs';
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

interface WorkflowStep {
  with?: { 'node-version'?: unknown; 'node-version-file'?: unknown };
}

interface Workflow {
  jobs?: Record<string, { name?: string; steps?: WorkflowStep[] }>;
}

function workflow(rel: string): Workflow {
  return loadYaml(readFileSync(join(REPO_ROOT, rel), 'utf-8')) as Workflow;
}

/**
 * The exact runtime this repo prescribes. `.nvmrc` is what a contributor's nvm
 * / mise / asdf picks up, and — since #785 — what `actions/setup-node` reads
 * too. Before that, CI said `node-version: '22'`, which setup-node resolves to
 * the *latest* 22.x, so CI had never once run the version the repo pinned.
 */
function nvmrcVersion(): string {
  return readFileSync(join(REPO_ROOT, '.nvmrc'), 'utf-8').trim();
}

/**
 * Every `setup-node` version in a workflow, as majors.
 *
 * Resolves `node-version-file` as well as a literal `node-version`. Without
 * that, converting the workflows to the `.nvmrc` pin would have turned every
 * assertion below into a zero-denominator "pass" — a version contract that
 * reads no versions is an abstention, not a green.
 */
function setupNodeMajors(wf: Workflow): number[] {
  return workflowSteps(wf)
    .map(stepNodeMajor)
    .filter((m): m is number => m !== undefined);
}

/** Every step of every job, flattened. */
function workflowSteps(wf: Workflow): WorkflowStep[] {
  return Object.values(wf.jobs ?? {}).flatMap((job) => job.steps ?? []);
}

/** The major a single step selects, or `undefined` if it selects none. */
function stepNodeMajor(step: WorkflowStep): number | undefined {
  const literal = step.with?.['node-version'];
  if (literal !== undefined) return majorOf(String(literal));

  const file = step.with?.['node-version-file'];
  if (file === undefined) return undefined;
  if (String(file) !== '.nvmrc') {
    throw new Error(
      `setup-node reads node-version-file '${String(file)}'. This contract ` +
        `only knows about '.nvmrc'; a second version file re-opens the very ` +
        `skew #785 closed.`,
    );
  }
  return majorOf(nvmrcVersion());
}

/** `v22.13.0` / `22.13.0` / `22` -> 22. */
function majorOf(version: string): number {
  return Number(version.replace(/^v/, '').split('.')[0]);
}

/** Every workflow file, as `[relative path, parsed]`. */
function allWorkflows(): Array<[string, Workflow]> {
  const dir = join(REPO_ROOT, '.github', 'workflows');
  return readdirSync(dir)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .map(
      (f) =>
        [`.github/workflows/${f}`, workflow(`.github/workflows/${f}`)] as [
          string,
          Workflow,
        ],
    );
}

describe('node version pin (#785)', () => {
  it('.nvmrc names one exact version, not a floating major', () => {
    const raw = nvmrcVersion();

    expect(
      raw,
      `.nvmrc reads '${raw}'. A bare major there is the same defect #785 ` +
        `fixed in CI: nvm and setup-node both resolve it to the latest ` +
        `matching release, so two machines following the pin can still run ` +
        `different runtimes. Pin major.minor.patch.`,
    ).toMatch(/^v?\d+\.\d+\.\d+$/);
  });

  it('the pinned version satisfies the published floor', () => {
    const published = floorMajor(enginesNode(PUBLISHED), PUBLISHED);
    const pinned = Number(nvmrcVersion().replace(/^v/, '').split('.')[0]);

    expect(
      pinned,
      `.nvmrc pins node ${pinned} but ${PUBLISHED} declares node>=` +
        `${published}. Contributors following the repo's own pin would be ` +
        `running a runtime we tell users not to use.`,
    ).toBeGreaterThanOrEqual(published);
  });

  it('no workflow re-introduces a floating major at or above the floor', () => {
    const published = floorMajor(enginesNode(PUBLISHED), PUBLISHED);
    const literals = allWorkflows().flatMap(([rel, wf]) =>
      workflowSteps(wf)
        .map((s) => s.with?.['node-version'])
        .filter((v) => v !== undefined)
        .map((v) => ({ rel, text: String(v) })),
    );
    const offenders = literals
      // A `${{ … }}` expression is computed at run time (the node-floor job
      // derives an intentionally-unsupported version); nothing to pin. And a
      // major below the floor is a deliberate old-runtime job, not the skew.
      .filter((l) => !l.text.includes('${{') && majorOf(l.text) >= published)
      .map((l) => `${l.rel}: node-version: '${l.text}'`);

    expect(
      literals.length,
      'no workflow declares a literal node-version at all — this guard read ' +
        'nothing, which is an abstention rather than a pass. Check that the ' +
        'workflow directory and YAML shape are still what this test assumes.',
    ).toBeGreaterThan(0);

    expect(
      offenders,
      `these setup-node steps pin a floating major instead of ` +
        `node-version-file: .nvmrc. actions/setup-node resolves a bare '22' ` +
        `to the latest 22.x, so CI would once again never run the version ` +
        `the repo prescribes (#785):\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });
});

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
