/**
 * Branch coverage for the overlay resolver's degradation paths (#481).
 *
 * `overlays.test.ts` ports the Python cases, which cover the happy paths and a
 * syntactically broken registry. What they never reach is a registry that PARSES
 * but is the wrong SHAPE (a JSON array, a string, `overlays` not a list, entries
 * that are not objects) and the `home` defaulting every exported function does.
 * Both matter: the module's contract is that a malformed registry never blocks
 * resolution, and that promise is only true if each wrong shape degrades.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
let savedHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'canary-overlays-br-'));
  savedHome = process.env['HOME'];
});

afterEach(() => {
  if (savedHome === undefined) delete process.env['HOME'];
  else process.env['HOME'] = savedHome;
  rmSync(home, { recursive: true, force: true });
});

function addOverlay(h: string, name: string): void {
  mkdirSync(join(h, '.canary', 'overlays', name, '.canary', 'skills'), {
    recursive: true,
  });
}

function writeRaw(h: string, body: string): void {
  mkdirSync(join(h, '.canary'), { recursive: true });
  writeFileSync(join(h, '.canary', 'overlays.json'), body, 'utf-8');
}

describe('registry shapes that parse but are wrong', () => {
  const wrongShapes: [string, string][] = [
    ['a JSON array', '[{"name":"alpha-repo"}]'],
    ['a JSON string', '"alpha-repo"'],
    ['a JSON null', 'null'],
    ['an object with no overlays key', '{"schemaVersion":1}'],
    ['overlays as an object', '{"overlays":{"alpha-repo":1}}'],
    ['overlays as a string', '{"overlays":"alpha-repo"}'],
  ];

  for (const [label, body] of wrongShapes) {
    it(`falls back to a sorted directory scan when the registry is ${label}`, () => {
      addOverlay(home, 'beta-repo');
      addOverlay(home, 'alpha-repo');
      writeRaw(home, body);
      // The clone DIRECTORIES are the source of truth; a wrong-shaped registry
      // may only lose the ordering, never the overlays themselves.
      expect(listOverlays(home)).toEqual(['alpha-repo', 'beta-repo']);
    });

    it(`yields an empty precedence map when the registry is ${label}`, () => {
      writeRaw(home, body);
      expect(registryPrecedence(home)).toEqual({});
    });
  }

  it('skips non-object and unnamed entries rather than failing the whole file', () => {
    writeRaw(
      home,
      JSON.stringify({
        overlays: [
          'not-an-object',
          42,
          null,
          { source: 'no name key' },
          { name: 7 },
          { name: 'alpha-repo', precedence: 3 },
        ],
      }),
    );
    // One usable entry survives; the junk around it is dropped silently.
    expect(registryPrecedence(home)).toEqual({ 'alpha-repo': 3 });
  });

  it('ignores registry names with no clone on disk', () => {
    addOverlay(home, 'alpha-repo');
    writeRaw(
      home,
      JSON.stringify({
        overlays: [{ name: 'ghost-repo' }, { name: 'alpha-repo' }],
      }),
    );
    expect(listOverlays(home)).toEqual(['alpha-repo']);
  });

  it('accepts a fractional precedence as declared', () => {
    writeRaw(
      home,
      JSON.stringify({ overlays: [{ name: 'alpha-repo', precedence: 1.5 }] }),
    );
    expect(registryPrecedence(home)).toEqual({ 'alpha-repo': 1.5 });
  });
});

describe('OverlayNotFound messaging', () => {
  it('tells the user how to add one when nothing is tracked', () => {
    let caught: OverlayNotFound | null = null;
    try {
      resolveOverlay('missing-overlay', home);
    } catch (e) {
      caught = e as OverlayNotFound;
    }
    expect(caught).toBeInstanceOf(OverlayNotFound);
    expect(caught!.available).toEqual([]);
    expect(caught!.message).toContain('no overlays are tracked');
    expect(caught!.message).toContain('canary overlay add');
  });

  it('lists the tracked overlays when some exist', () => {
    addOverlay(home, 'alpha-repo');
    addOverlay(home, 'beta-repo');
    expect(() => resolveOverlay('missing-overlay', home)).toThrow(
      /tracked overlays: alpha-repo, beta-repo/,
    );
  });

  it('reports the same way for a path that does not exist', () => {
    addOverlay(home, 'alpha-repo');
    const bad = join(home, 'nope', 'overlay');
    expect(() => resolveOverlay(bad, home)).toThrow(OverlayNotFound);
    expect(() => resolveOverlay(bad, home)).toThrow(
      /tracked overlays: alpha-repo/,
    );
  });
});

describe('home defaulting', () => {
  it('reads the user home when no home argument is given', () => {
    addOverlay(home, 'alpha-repo');
    writeRaw(
      home,
      JSON.stringify({ overlays: [{ name: 'alpha-repo', precedence: 4 }] }),
    );
    process.env['HOME'] = home;
    // os.homedir() honours $HOME on POSIX, so this exercises the real default.
    expect(listOverlays()).toEqual(['alpha-repo']);
    expect(registryPrecedence()).toEqual({ 'alpha-repo': 4 });
    expect(resolveOverlay('alpha-repo')).toContain('alpha-repo');
  });
});
