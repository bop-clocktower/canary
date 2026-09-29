/**
 * `canary judomaster brief` reading the trace from stdin (#614). Kept in its
 * own file because `vi.mock('node:fs')` is module-wide: here fd 0 returns a
 * Slack-quoted, ANSI-coloured paste and every other read passes through.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { invokeCanary, mkTmp, rmTmp } from './canary-cli-testkit.js';

const PASTE = [
  '> ```',
  "> \x1b[31mTypeError: Cannot read properties of undefined (reading 'qty')\x1b[0m",
  '>     at cartTotal (/app/src/cart/total.ts:12:7)',
  '> ```',
].join('\n');

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) =>
      args[0] === 0 ? PASTE : actual.readFileSync(...args),
  };
});

let root: string;

beforeEach(() => {
  root = mkTmp();
  mkdirSync(join(root, 'src', 'cart'), { recursive: true });
  const body = Array.from({ length: 20 }, (_, i) => `// line ${i + 1}`);
  writeFileSync(join(root, 'src', 'cart', 'total.ts'), body.join('\n'));
});

afterEach(() => rmTmp(root));

describe('canary judomaster brief (stdin)', () => {
  it.each([[[]], [['-']]])('reads stdin with args %j', async (extra) => {
    const res = await invokeCanary([
      'judomaster',
      'brief',
      ...extra,
      '--root',
      root,
    ]);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('src/cart/total.ts:12');
  });
});
