/**
 * Tests for the framework capability-tier API added to the framework-registry
 * port (`agent/core/framework_registry.py`,
 * `tests/unit/test_framework_capability_tiers.py`). Every Python case is
 * preserved. The broad summaries/getByCategory/... parity is asserted separately
 * in core-parity.test.ts against the Python golden.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  FrameworkRegistry,
  defaultRegistryPath,
} from '../src/core/framework-registry.js';
import { scaffoldableFrameworks } from '../src/core/scaffolder.js';

describe('capability derivation', () => {
  const reg = new FrameworkRegistry();

  it('full tier has scaffold and execute', () => {
    const caps = reg.capabilities('pytest');
    expect(caps).not.toBeNull();
    expect(caps!.scaffold).toBe(true);
    expect(caps!.execute).toBe(true);
    expect(caps!.tier).toBe('full');
  });

  it('executable tier: execute without scaffold', () => {
    const caps = reg.capabilities('schemathesis');
    expect(caps).not.toBeNull();
    expect(caps!.execute).toBe(true);
    expect(caps!.scaffold).toBe(false);
    expect(caps!.tier).toBe('executable');
  });

  it('catalog tier: no execution', () => {
    const caps = reg.capabilities('tosca');
    expect(caps).not.toBeNull();
    expect(caps!.execute).toBe(false);
    expect(caps!.scaffold).toBe(false);
    expect(caps!.tier).toBe('catalog');
  });

  it('unrunnable placeholder is not executable', () => {
    // zap/semgrep carry a {target} placeholder the executor never substitutes.
    for (const name of ['zap', 'semgrep']) {
      const caps = reg.capabilities(name);
      expect(caps, name).not.toBeNull();
      expect(caps!.execute, name).toBe(false);
      expect(caps!.tier, name).toBe('catalog');
    }
  });

  it('whole-suite runner is executable', () => {
    const caps = reg.capabilities('stryker');
    expect(caps).not.toBeNull();
    expect(caps!.execute).toBe(true);
  });

  it('capabilities is case-insensitive', () => {
    expect(reg.capabilities('Pytest')).toEqual(reg.capabilities('pytest'));
  });

  it('unknown framework returns null', () => {
    expect(reg.capabilities('nonexistent')).toBeNull();
    expect(reg.capabilities('')).toBeNull();
  });
});

describe('summaries expose tier', () => {
  it('every summary carries a valid tier and full capability keys', () => {
    const summaries = new FrameworkRegistry().summaries();
    expect(summaries.length).toBeGreaterThan(0);
    for (const s of summaries) {
      expect(['full', 'executable', 'catalog']).toContain(s.tier);
      expect(Object.keys(s.capabilities!).sort()).toEqual([
        'execute',
        'scaffold',
        'tier',
      ]);
    }
  });

  it('a nameless framework yields null capabilities and tier', () => {
    // Exercises the `caps === null` branch of summaries() that the real
    // registry (every entry named) never hits.
    const dir = mkdtempSync(join(tmpdir(), 'canary-reg-'));
    try {
      const path = join(dir, 'registry.json');
      writeFileSync(
        path,
        JSON.stringify({ frameworks: [{ category: 'api' }] }),
        'utf-8',
      );
      const summary = new FrameworkRegistry(path).summaries()[0]!;
      expect(summary.capabilities).toBeNull();
      expect(summary.tier).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('capability drift guards', () => {
  const reg = new FrameworkRegistry();
  const names = reg.getAllFrameworks().map((f) => f.name);

  it('every scaffold template is a real framework', () => {
    const nameSet = new Set(names);
    const orphans = [...scaffoldableFrameworks()].filter(
      (n) => !nameSet.has(n),
    );
    expect(orphans).toEqual([]);
  });

  it('capabilities resolves for every registered framework', () => {
    for (const name of names) {
      const caps = reg.capabilities(name);
      expect(caps, name).not.toBeNull();
      expect(['full', 'executable', 'catalog'], name).toContain(caps!.tier);
    }
  });

  it('scaffoldable implies executable', () => {
    for (const name of names) {
      const caps = reg.capabilities(name)!;
      if (caps.scaffold) {
        expect(caps.execute, name).toBe(true);
      }
    }
  });

  it('the default registry path is used when none is given', () => {
    // Guards the drift-reconciliation: both constructors read the same file.
    expect(new FrameworkRegistry(defaultRegistryPath()).summaries()).toEqual(
      reg.summaries(),
    );
  });
});
