/**
 * Tests for the `overlays` port (`agent/core/overlays.py`,
 * `tests/unit/test_overlays.py`). Every Python case is preserved. Python's
 * `Path.resolve()` maps to `fs.realpathSync`, and `exception.name` maps to
 * `OverlayNotFound.overlayName` (see the source's Python→TS notes).
 */

import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  OverlayNotFound,
  listOverlays,
  registryPrecedence,
  resolveOverlay,
} from '../src/core/overlays.js';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'canary-overlays-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function addOverlay(h: string, name: string): string {
  const clone = join(h, '.canary', 'overlays', name);
  mkdirSync(join(clone, '.canary', 'skills'), { recursive: true });
  return clone;
}

function writeRegistry(h: string, names: string[]): void {
  const reg = join(h, '.canary', 'overlays.json');
  mkdirSync(join(h, '.canary'), { recursive: true });
  writeFileSync(
    reg,
    JSON.stringify({
      schemaVersion: 1,
      overlays: names.map((n) => ({
        name: n,
        source: `github:example-org/${n}`,
        path: join(h, '.canary', 'overlays', n),
      })),
    }),
    'utf-8',
  );
}

describe('listOverlays', () => {
  it('empty when no overlays root', () => {
    expect(listOverlays(home)).toEqual([]);
  });

  it('directory scan sorted without registry', () => {
    addOverlay(home, 'beta-repo');
    addOverlay(home, 'alpha-repo');
    expect(listOverlays(home)).toEqual(['alpha-repo', 'beta-repo']);
  });

  it('registry order when readable', () => {
    addOverlay(home, 'alpha-repo');
    addOverlay(home, 'beta-repo');
    // Registry lists beta first — that order should win over alphabetical.
    writeRegistry(home, ['beta-repo', 'alpha-repo']);
    expect(listOverlays(home)).toEqual(['beta-repo', 'alpha-repo']);
  });

  it('malformed registry falls back to sorted scan', () => {
    addOverlay(home, 'beta-repo');
    addOverlay(home, 'alpha-repo');
    writeFileSync(
      join(home, '.canary', 'overlays.json'),
      '{ not json',
      'utf-8',
    );
    expect(listOverlays(home)).toEqual(['alpha-repo', 'beta-repo']);
  });

  it('on-disk overlay absent from registry still listed', () => {
    addOverlay(home, 'alpha-repo');
    addOverlay(home, 'gamma-repo'); // not in registry
    writeRegistry(home, ['alpha-repo']);
    // Registry-ordered names first, then unlisted extras sorted.
    expect(listOverlays(home)).toEqual(['alpha-repo', 'gamma-repo']);
  });
});

describe('registryPrecedence', () => {
  function write(h: string, entries: unknown[]): void {
    const reg = join(h, '.canary', 'overlays.json');
    mkdirSync(join(h, '.canary'), { recursive: true });
    writeFileSync(
      reg,
      JSON.stringify({ schemaVersion: 1, overlays: entries }),
      'utf-8',
    );
  }

  it('reads declared values', () => {
    write(home, [
      { name: 'a', precedence: 10 },
      { name: 'b', precedence: 2 },
    ]);
    expect(registryPrecedence(home)).toEqual({ a: 10, b: 2 });
  });

  it('absent or null precedence is zero', () => {
    write(home, [{ name: 'a' }, { name: 'b', precedence: null }]);
    expect(registryPrecedence(home)).toEqual({ a: 0, b: 0 });
  });

  it('bool precedence is not treated as numeric', () => {
    // JSON true would coerce to 1 under a naive isinstance(int) check.
    write(home, [{ name: 'a', precedence: true }]);
    expect(registryPrecedence(home)).toEqual({ a: 0 });
  });

  it('missing or malformed registry is empty map', () => {
    expect(registryPrecedence(home)).toEqual({}); // no file
    mkdirSync(join(home, '.canary'), { recursive: true });
    writeFileSync(
      join(home, '.canary', 'overlays.json'),
      '{ not json',
      'utf-8',
    );
    expect(registryPrecedence(home)).toEqual({});
  });
});

describe('resolveOverlay', () => {
  it('resolve by name', () => {
    const clone = addOverlay(home, 'example-org-example-overlay');
    const resolved = resolveOverlay('example-org-example-overlay', home);
    expect(resolved).toBe(realpathSync(clone));
  });

  it('bare name missing raises with available', () => {
    addOverlay(home, 'alpha-repo');
    let caught: OverlayNotFound | null = null;
    try {
      resolveOverlay('nope', home);
    } catch (e) {
      caught = e as OverlayNotFound;
    }
    expect(caught).toBeInstanceOf(OverlayNotFound);
    expect(caught!.overlayName).toBe('nope');
    expect(caught!.available).toEqual(['alpha-repo']);
  });

  it('bare name not shadowed by local dir', () => {
    // A bare token is ALWAYS a name — a same-named dir in cwd must not shadow a
    // tracked overlay, and a missing name must not silently become a path.
    addOverlay(home, 'alpha-repo');
    expect(() => resolveOverlay('some-local-name', home)).toThrow(
      OverlayNotFound,
    );
  });

  it('resolve by relative path', () => {
    const overlay = join(home, 'sibling-overlay');
    mkdirSync(join(overlay, '.canary'), { recursive: true });
    const resolved = resolveOverlay(overlay, home);
    expect(resolved).toBe(realpathSync(overlay));
    const rel = `./${'sibling-overlay'}`;
    // A separator-bearing value is treated as a path even if no registry.
    expect(rel.startsWith('./')).toBe(true);
  });

  it('missing path raises', () => {
    // A path-form --from that does not exist fails loudly (symmetry with a bad
    // name) rather than silently resolving to a non-existent overlay.
    addOverlay(home, 'real-overlay');
    const missing = join(home, 'does', 'not', 'exist');
    expect(() => resolveOverlay(missing, home)).toThrow(OverlayNotFound);
  });

  it('resolve by absolute path', () => {
    const overlay = join(home, 'abs-overlay');
    mkdirSync(overlay, { recursive: true });
    const resolved = resolveOverlay(overlay, join(home, 'unrelated-home'));
    expect(resolved).toBe(realpathSync(overlay));
  });
});
