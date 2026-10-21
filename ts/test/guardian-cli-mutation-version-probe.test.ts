/**
 * `canary guardian mutation` without `--report` (#486): the installed-version
 * probe behind the abstain guard.
 *
 * Without `--runner-version` / `--vitest-version` the guard reads the installed
 * versions from `<repo-root>/ts/node_modules/<pkg>/package.json`. Every
 * manifest it cannot read as `{ version: string }` must count as "not
 * installed" -- never as a compatible runner, which would drop the #6210
 * warning. The existing mutation suite always passes both flags, so this file
 * is the only coverage of the omitted-flag default (AGENTS.md test-design
 * rule 1). Fixture roots live under `os.tmpdir()` and are removed after each
 * test (rule 2).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { RUNNER_ISSUE } from '../src/guardian/mutation.js';

import { invokeGuardianJson } from './guardian-cli-testkit.js';

const RUNNER = '@stryker-mutator/vitest-runner';
const NOT_INSTALLED = `${RUNNER} is not installed, so no mutant was run`;

const roots: string[] = [];

afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

/** A repo root whose ts/node_modules holds the given raw manifests. */
function rootWith(manifests: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'canary-mutation-probe-'));
  roots.push(root);
  for (const [pkg, raw] of Object.entries(manifests)) {
    const dir = join(root, 'ts', 'node_modules', pkg);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), raw);
  }
  return root;
}

/** Run `mutation --json` at `root` (plus `extra` flags); return its abstain reason. */
async function abstainReason(
  root: string,
  extra: string[] = [],
): Promise<unknown> {
  const res = await invokeGuardianJson([
    'mutation',
    '--json',
    '--repo-root',
    root,
    ...extra,
  ]);
  expect(res.verdict, 'no --report must always abstain').toBe('abstained');
  return res.abstainReason;
}

describe('guardian mutation abstain guard: installed-version probe', () => {
  it.each([
    ['no manifest at all', {}],
    ['a manifest that is not JSON', { [RUNNER]: '{ not json' }],
    ['a manifest that is a JSON array', { [RUNNER]: '["10.0.0"]' }],
    [
      'a manifest whose version is not a string',
      { [RUNNER]: '{"version":10}' },
    ],
  ])('treats %s as a runner that is not installed', async (_label, files) => {
    expect(await abstainReason(rootWith(files))).toBe(NOT_INSTALLED);
  });

  it('reads both installed versions and names the upstream issue', async () => {
    const root = rootWith({
      [RUNNER]: '{"version":"10.0.0"}',
      vitest: '{"version":"5.0.4"}',
    });
    expect(await abstainReason(root)).toContain(RUNNER_ISSUE);
  });

  it('reports an unreadable vitest version rather than assuming compatible', async () => {
    const root = rootWith({ [RUNNER]: '{"version":"10.0.0"}' });
    expect(await abstainReason(root)).toBe(
      'cannot read the runner/vitest versions (runner 10.0.0, vitest unknown)',
    );
  });

  it('lets --runner-version override the probe while vitest is still read', async () => {
    // No runner manifest on disk: only the flag can make this compatible, and
    // only the probed vitest 5.0.4 can make the verdict reach "not wired".
    const root = rootWith({ vitest: '{"version":"5.0.4"}' });
    expect(await abstainReason(root, ['--runner-version', '11.0.0'])).toBe(
      'no --report given and the mutation run is not wired yet (#486)',
    );
  });
});
