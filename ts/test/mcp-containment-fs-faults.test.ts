/**
 * Containment-gate refusals that a real POSIX filesystem cannot produce on
 * demand: `/` always exists, so the walk up a missing tail never runs off the
 * top, and an ancestor that `existsSync` sees is one `realpathSync` resolves.
 * Both are still contract (fleet decision F2 (a)): when the resolver cannot
 * prove a path is inside the served root, the tool must refuse. Faults are
 * injected through a module-wide `node:fs` mock -- hence this own file -- and
 * only the refusal OUTCOME is asserted, never the resolver's intermediates.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { writeTestFileImpl } from '../src/mcp-server.js';

/** Per-test fault hooks; `undefined` means "behave like the real fs". */
const faults: {
  exists?: (p: string) => boolean | undefined;
  realpathThrows?: (p: string) => boolean;
} = {};

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const realpathSync = Object.assign(
    (...args: Parameters<typeof actual.realpathSync>) => {
      if (faults.realpathThrows?.(String(args[0]))) {
        throw Object.assign(new Error('EACCES: injected'), { code: 'EACCES' });
      }
      return actual.realpathSync(...args);
    },
    { native: actual.realpathSync.native },
  );
  return {
    ...actual,
    existsSync: (p: Parameters<typeof actual.existsSync>[0]) =>
      faults.exists?.(String(p)) ?? actual.existsSync(p),
    realpathSync,
  };
});

const dirs: string[] = [];
afterEach(() => {
  delete faults.exists;
  delete faults.realpathThrows;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A served root, realpath'd so injected faults can match its children. */
function servedRoot(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'canary-mcp-faults-')));
  dirs.push(d);
  return d;
}

describe('containment refuses when it cannot resolve the target', () => {
  it('refuses when no ancestor of the target can be seen to exist', () => {
    const root = servedRoot();
    // Only the root resolves; every existence probe (up to `/`) comes back
    // false, so the walk runs off the top of the filesystem.
    faults.exists = () => false;
    const result = writeTestFileImpl('new/t.test.ts', 'x', 'vitest', root);
    expect(result).toEqual({
      error: 'path escapes the project root: new/t.test.ts',
    });
    delete faults.exists;
    expect(existsSync(join(root, 'new'))).toBe(false);
  });

  it('refuses when the nearest existing ancestor cannot be realpathed', () => {
    const root = servedRoot();
    mkdirSync(join(root, 'sub'));
    faults.realpathThrows = (p) => p === join(root, 'sub');
    const result = writeTestFileImpl('sub/t.test.ts', 'x', 'vitest', root);
    expect(result).toEqual({
      error: 'path escapes the project root: sub/t.test.ts',
    });
    expect(existsSync(join(root, 'sub', 't.test.ts'))).toBe(false);
  });

  it('still writes inside the root when no fault is injected', () => {
    // Positive control: the refusals above come from the faults, not from a
    // gate that refuses everything under this mock.
    const root = servedRoot();
    mkdirSync(join(root, 'sub'));
    const result = writeTestFileImpl('sub/t.test.ts', 'x', 'vitest', root);
    expect(result).toEqual({ written_path: join(root, 'sub', 't.test.ts') });
  });
});
