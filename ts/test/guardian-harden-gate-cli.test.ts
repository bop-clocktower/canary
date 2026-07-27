/**
 * Faithful TypeScript port of `tests/unit/test_guardian_harden_gate_cli.py`.
 *
 * Dry-run by default (never writes); `--apply` registers the required check via
 * an injected client (faked here -- no network). Exit contract: 0 success/no-op,
 * 1 blocked (no admin / unsupported plan), 2 misuse (no repo, or --apply w/o
 * token). The Python `monkeypatch.setattr(guardian_cli, "_branch_protection_
 * client", ...)` becomes `deps.buildBranchProtectionClient`.
 */

import { describe, expect, it, vi } from 'vitest';

import { FakeBranchProtectionClient } from '../src/guardian/hard-gate.js';
import { invokeGuardian } from './guardian-cli-testkit.js';

it('dry run describes change and does not build a client', async () => {
  const build = vi.fn(() => new FakeBranchProtectionClient());
  const res = await invokeGuardian(['harden-gate', '--repo', 'o/r'], {
    deps: { buildBranchProtectionClient: build },
  });
  expect(res.code).toBe(0);
  expect(res.stdout).toContain('guardian');
  expect(build).not.toHaveBeenCalled(); // dry-run never builds a client / writes
});

it('apply without token exits two', async () => {
  const res = await invokeGuardian(['harden-gate', '--repo', 'o/r', '--apply']);
  expect(res.code).toBe(2);
  expect(res.stdout.toLowerCase()).toContain('token');
});

it('missing repo exits two', async () => {
  const res = await invokeGuardian(['harden-gate']);
  expect(res.code).toBe(2);
});

it('apply success registers check (merged, not clobbered)', async () => {
  const fake = new FakeBranchProtectionClient({
    contexts: ['build'],
    admin: true,
    observed: ['guardian'],
  });
  const res = await invokeGuardian(
    ['harden-gate', '--repo', 'o/r', '--apply', '--token', 'x'],
    { deps: { buildBranchProtectionClient: () => fake } },
  );
  expect(res.code).toBe(0);
  expect(fake.contextsFor('main')).toContain('guardian');
  expect(fake.contextsFor('main')).toContain('build');
});

it('apply blocked exits one with playbook', async () => {
  const fake = new FakeBranchProtectionClient({
    contexts: ['build'],
    admin: false,
    observed: ['guardian'],
  });
  const res = await invokeGuardian(
    ['harden-gate', '--repo', 'o/r', '--apply', '--token', 'x'],
    { deps: { buildBranchProtectionClient: () => fake } },
  );
  expect(res.code).toBe(1);
  expect(res.stdout).toContain('settings/branches');
  expect(fake.write_count).toBe(0);
});

it('apply unverified context exits one', async () => {
  const fake = new FakeBranchProtectionClient({
    contexts: ['build'],
    observed: ['build'],
  });
  const res = await invokeGuardian(
    ['harden-gate', '--repo', 'o/r', '--apply', '--token', 'x'],
    { deps: { buildBranchProtectionClient: () => fake } },
  );
  expect(res.code).toBe(1);
  expect(fake.write_count).toBe(0);
});

it('force bypasses verification', async () => {
  const fake = new FakeBranchProtectionClient({
    contexts: ['build'],
    observed: [],
  });
  const res = await invokeGuardian(
    ['harden-gate', '--repo', 'o/r', '--apply', '--token', 'x', '--force'],
    { deps: { buildBranchProtectionClient: () => fake } },
  );
  expect(res.code).toBe(0);
  expect(fake.contextsFor('main')).toContain('guardian');
});

it('apply already required is a noop', async () => {
  const fake = new FakeBranchProtectionClient({
    contexts: ['guardian'],
    admin: true,
    observed: ['guardian'],
  });
  const res = await invokeGuardian(
    ['harden-gate', '--repo', 'o/r', '--apply', '--token', 'x'],
    { deps: { buildBranchProtectionClient: () => fake } },
  );
  expect(res.code).toBe(0);
  expect(fake.write_count).toBe(0);
});

describe('env + branch coverage', () => {
  it('resolves repo from GITHUB_REPOSITORY env', async () => {
    const build = vi.fn(() => new FakeBranchProtectionClient());
    const res = await invokeGuardian(['harden-gate'], {
      env: { GITHUB_REPOSITORY: 'o/r' },
      deps: { buildBranchProtectionClient: build },
    });
    expect(res.code).toBe(0); // dry-run with env-derived repo
    expect(res.stdout).toContain('o/r');
  });

  it('created-protection verb when the branch is unprotected', async () => {
    // contexts:null + protected:false -> genuinely unprotected -> create path.
    const fake = new FakeBranchProtectionClient({
      contexts: null,
      protected: false,
      observed: ['guardian'],
    });
    const res = await invokeGuardian(
      ['harden-gate', '--repo', 'o/r', '--apply', '--token', 'x', '--force'],
      { deps: { buildBranchProtectionClient: () => fake } },
    );
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('created protection and required');
  });
});
