/**
 * Faithful TypeScript port of `tests/unit/test_guardian_hard_gate.py`.
 *
 * The core is pure and network-free: {@link planHardGate} decides what would
 * change, {@link applyHardGate} drives a {@link BranchProtection} (faked here),
 * and any permission/plan barrier surfaces as {@link HardGateBlocked} carrying a
 * playbook — never a silent no-op.
 */

import { describe, expect, it } from 'vitest';

import {
  FakeBranchProtectionClient,
  HardGateAbstained,
  HardGateBlocked,
  applyHardGate,
  planHardGate,
  renderPlaybook,
} from '../src/guardian/hard-gate.js';

describe('plan', () => {
  it('adds check to existing protection', () => {
    const plan = planHardGate(['build'], 'guardian', 'main');
    expect(plan.already_required).toBe(false);
    expect(plan.creates_protection).toBe(false);
    expect(plan.resulting_contexts).toContain('guardian');
    expect(plan.resulting_contexts).toContain('build'); // never clobber existing
  });

  it('already required is a noop', () => {
    const plan = planHardGate(['guardian', 'build'], 'guardian', 'main');
    expect(plan.already_required).toBe(true);
    expect(new Set(plan.resulting_contexts)).toEqual(
      new Set(['guardian', 'build']),
    );
  });

  it('no protection flags creation', () => {
    const plan = planHardGate(null, 'guardian', 'main');
    expect(plan.creates_protection).toBe(true);
    expect(plan.resulting_contexts).toEqual(['guardian']);
  });
});

describe('playbook', () => {
  it('names repo, branch and context', () => {
    const text = renderPlaybook('owner/repo', 'main', 'guardian');
    expect(text).toContain('owner/repo');
    expect(text).toContain('main');
    expect(text).toContain('guardian');
    // actionable: points at the settings surface and/or a gh command
    expect(text.toLowerCase()).toContain('branch');
  });
});

// observed seeded so the phantom-context verification passes.
function client(
  init: ConstructorParameters<typeof FakeBranchProtectionClient>[0] = {},
): FakeBranchProtectionClient {
  return new FakeBranchProtectionClient({ observed: ['guardian'], ...init });
}

describe('apply', () => {
  it('adds check when admin', async () => {
    const c = client({ contexts: ['build'], admin: true });
    const plan = await applyHardGate(c, 'owner/repo', 'main', 'guardian');
    expect(plan.already_required).toBe(false);
    expect(c.contextsFor('main')).toContain('guardian');
    expect(c.contextsFor('main')).toContain('build'); // merged, not clobbered
  });

  it('creates protection only when unprotected', async () => {
    const c = client({ contexts: null, protected: false, admin: true });
    const plan = await applyHardGate(c, 'owner/repo', 'main', 'guardian');
    expect(plan.creates_protection).toBe(true);
    expect(c.last_create).toBe(true);
    expect(c.contextsFor('main')).toEqual(['guardian']);
  });

  it('protected without checks does not clobber', async () => {
    // The dangerous state: branch protected (reviews etc.) but no checks
    // section. Must PATCH (create=false), never PUT-create.
    const c = client({ contexts: null, protected: true, admin: true });
    const plan = await applyHardGate(c, 'owner/repo', 'main', 'guardian');
    expect(plan.creates_protection).toBe(false);
    expect(c.last_create).toBe(false); // would-clobber PUT never used
    expect(c.contextsFor('main')).toEqual(['guardian']);
  });

  it('is idempotent when already required', async () => {
    const c = client({ contexts: ['guardian'], admin: true });
    const plan = await applyHardGate(c, 'owner/repo', 'main', 'guardian');
    expect(plan.already_required).toBe(true);
    expect(c.write_count).toBe(0);
  });

  it('no admin raises blocked with playbook', async () => {
    const c = client({ contexts: ['build'], admin: false });
    await expect(
      applyHardGate(c, 'owner/repo', 'main', 'guardian'),
    ).rejects.toBeInstanceOf(HardGateBlocked);
    try {
      await applyHardGate(c, 'owner/repo', 'main', 'guardian');
    } catch (err) {
      expect((err as HardGateBlocked).playbook).toBeTruthy();
      expect((err as HardGateBlocked).playbook).toContain('guardian');
    }
    expect(c.write_count).toBe(0);
  });

  it('plan unsupported raises blocked', async () => {
    const c = client({
      contexts: ['build'],
      admin: true,
      plan_supported: false,
    });
    await expect(
      applyHardGate(c, 'owner/repo', 'main', 'guardian'),
    ).rejects.toBeInstanceOf(HardGateBlocked);
  });
});

describe('phantom context verification', () => {
  it('unobserved context is refused', async () => {
    // 'guardian' never reported → requiring it would block every merge.
    const c = new FakeBranchProtectionClient({
      contexts: ['build'],
      observed: ['build'],
    });
    let caught: HardGateBlocked | null = null;
    try {
      await applyHardGate(c, 'owner/repo', 'main', 'guardian');
    } catch (err) {
      caught = err as HardGateBlocked;
    }
    expect(caught).not.toBeNull();
    expect(caught!.reason).toContain('build'); // lists the real contexts
    expect(c.write_count).toBe(0);
  });

  it('no observed checks is an ABSTENTION, not a generic blocker (#508)', async () => {
    const c = new FakeBranchProtectionClient({
      contexts: ['build'],
      observed: [],
    });
    await expect(
      applyHardGate(c, 'owner/repo', 'main', 'guardian'),
    ).rejects.toBeInstanceOf(HardGateAbstained);
    expect(c.write_count).toBe(0);
  });

  it('no observed checks is refused', async () => {
    const c = new FakeBranchProtectionClient({
      contexts: ['build'],
      observed: [],
    });
    await expect(
      applyHardGate(c, 'owner/repo', 'main', 'guardian'),
    ).rejects.toBeInstanceOf(HardGateBlocked);
    expect(c.write_count).toBe(0);
  });

  it('force bypasses verification', async () => {
    const c = new FakeBranchProtectionClient({
      contexts: ['build'],
      observed: [],
    });
    const plan = await applyHardGate(c, 'owner/repo', 'main', 'guardian', true);
    expect(plan.already_required).toBe(false);
    expect(c.contextsFor('main')).toContain('guardian');
  });
});

describe('error handling', () => {
  it('network error on read becomes blocked', async () => {
    const c = new FakeBranchProtectionClient({
      contexts: ['build'],
      observed: ['guardian'],
      read_error: new Error('connection reset'),
    });
    let caught: HardGateBlocked | null = null;
    try {
      await applyHardGate(c, 'owner/repo', 'main', 'guardian');
    } catch (err) {
      caught = err as HardGateBlocked;
    }
    expect(caught).not.toBeNull();
    expect(caught!.playbook).toBeTruthy();
    expect(c.write_count).toBe(0);
  });
});
