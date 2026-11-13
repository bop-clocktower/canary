/**
 * A scanned checkout is untrusted (#1575). `git clone` materializes tracked
 * symlinks, so a tree can aim a source path, or the existing map at
 * `.canary/critical-areas.json`, at `/dev/zero` or a FIFO. Reading either with
 * `readFileSync` never returns: `/dev/zero` grew past 2 GB RSS, a FIFO with no
 * writer blocks in `open`.
 *
 * Those reads are synchronous, so in the vitest worker a regression would hang
 * the run with vitest's timer unable to fire. They run in a child process
 * bounded by a spawn `timeout:` instead, which turns a hang into a failure.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { keepSymbols } from '../src/critical-areas/declared-symbols.js';
import { countImporters } from '../src/critical-areas/importers.js';
import { mkTmp, rmTmp } from './canary-cli-testkit.js';

const CHILD = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'critical-areas-read-child.mjs',
);
/** Well past the child's ~0.3s, well short of a hang worth waiting on. */
const CHILD_TIMEOUT_MS = 5_000;
/** One byte past the read cap, MAX_TREE_READ_BYTES in regular-file.ts. */
const PAST_CAP = 8 * 1024 * 1024 + 1;

const SYMBOLS_MAP = JSON.stringify({
  areas: [{ path: 'src/a.ts', symbols: ['chargeCard'] }],
});

describe.skipIf(process.platform === 'win32')('a hostile tree (#1575)', () => {
  let root: string;
  beforeEach(() => {
    root = mkTmp();
  });
  afterEach(() => {
    rmTmp(root);
  });

  const plant = (path: string, body: string): string => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body, 'utf-8');
    return join(root, path);
  };
  const link = (path: string, target: string): string => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    symlinkSync(target, join(root, path));
    return join(root, path);
  };
  const fifo = (path: string): string => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    const made = spawnSync('mkfifo', [join(root, path)]);
    expect(made.status).toBe(0);
    return join(root, path);
  };

  /** Run one read in a child; a hang comes back as a killed child, not a hang. */
  function inChild(mode: 'importers' | 'symbols', path: string) {
    const res = spawnSync(process.execPath, [CHILD, mode, root, path], {
      encoding: 'utf-8',
      timeout: CHILD_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    });
    expect(res.signal, `the read did not finish: ${res.stderr}`).toBeNull();
    expect(res.status, res.stderr).toBe(0);
    return JSON.parse(res.stdout) as Record<string, unknown>;
  }

  describe('source files', () => {
    it.each([
      ['a symlink to /dev/zero', () => link('src/z.ts', '/dev/zero')],
      ['a FIFO', () => fifo('src/z.ts')],
      ['a symlink to a FIFO', () => link('src/z.ts', fifo('pipe'))],
    ])('skips %s as unread instead of hanging', (_name, make) => {
      make();
      expect(inChild('importers', 'src/z.ts')).toEqual({
        status: 'absent',
        reason: 'read 0 of 1 source file(s) from the working tree',
        files_read: 0,
        files_unread: 1,
      });
    });

    it('does not follow a symlink, even to a regular file', () => {
      plant('src/a.ts', '');
      plant('elsewhere/real.ts', "import '../src/a.js';\n");
      link('src/m.ts', join(root, 'elsewhere', 'real.ts'));
      const { counts, source } = countImporters(root, ['src/a.ts', 'src/m.ts']);
      expect(counts!.get('src/a.ts')).toBe(0);
      expect(source).toMatchObject({ status: 'partial', files_unread: 1 });
    });

    it('skips a file past the read cap', () => {
      plant('src/a.ts', '');
      const big = plant('src/big.ts', "import './a.js';\n");
      truncateSync(big, PAST_CAP);
      const { counts, source } = countImporters(root, [
        'src/a.ts',
        'src/big.ts',
      ]);
      expect(counts!.get('src/a.ts')).toBe(0);
      expect(source).toMatchObject({ status: 'partial', files_unread: 1 });
    });
  });

  describe('the existing map (declared symbols)', () => {
    const OUT = join('.canary', 'critical-areas.json');

    it.each([
      ['a symlink to /dev/zero', () => link(OUT, '/dev/zero')],
      ['a FIFO', () => fifo(OUT)],
    ])('reads %s as no map instead of hanging', (_name, make) => {
      expect(inChild('symbols', make())).toEqual({ kept: [] });
    });

    it('does not follow a symlink, even to a regular map', () => {
      const real = plant('elsewhere/map.json', SYMBOLS_MAP);
      const out = link(OUT, real);
      expect([...keepSymbols(out, ['src/a.ts']).kept.keys()]).toEqual([]);
    });

    it('still reads a regular map', () => {
      const out = plant(OUT, SYMBOLS_MAP);
      expect([...keepSymbols(out, ['src/a.ts']).kept.keys()]).toEqual([
        'src/a.ts',
      ]);
    });
  });
});
