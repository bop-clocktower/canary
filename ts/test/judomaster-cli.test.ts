/**
 * `canary judomaster` CLI (#614). Synthetic fixtures only: a fake cart/total
 * module in a temp root, traces captured "on another machine" under /app.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { invokeCanary, mkTmp, rmTmp } from './canary-cli-testkit.js';

const V8_TRACE = [
  "TypeError: Cannot read properties of undefined (reading 'qty')",
  '    at cartTotal (/app/src/cart/total.ts:12:7)',
  '    at checkout (/app/src/cart/checkout.ts:30:10)',
].join('\n');

let root: string;

beforeEach(() => {
  root = mkTmp();
  mkdirSync(join(root, 'src', 'cart'), { recursive: true });
  const body = Array.from({ length: 20 }, (_, i) => `// line ${i + 1}`);
  writeFileSync(join(root, 'src', 'cart', 'total.ts'), body.join('\n'));
});

afterEach(() => rmTmp(root));

function traceFile(text: string): string {
  const p = join(root, 'trace.txt');
  writeFileSync(p, text);
  return p;
}

const brief = (...extra: string[]) =>
  invokeCanary(['judomaster', 'brief', ...extra, '--root', root]);

describe('canary judomaster brief', () => {
  it('emits a markdown brief naming the in-repo suspect', async () => {
    const res = await brief(traceFile(V8_TRACE));
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('src/cart/total.ts:12');
    expect(res.stdout).toContain(
      'tests/generated/regression/total-typeerror.test.ts',
    );
  });

  it('prints a parseable brief with --json', async () => {
    const res = await brief(traceFile(V8_TRACE), '--json');
    expect(res.code).toBe(0);
    const parsed = JSON.parse(res.stdout);
    expect(parsed.schema).toBe('canary-judomaster-brief/1');
    expect(parsed.suspect.path).toBe('src/cart/total.ts');
  });

  it('writes the JSON brief with --json-out', async () => {
    const out = join(root, 'brief.json');
    const res = await brief(traceFile(V8_TRACE), '--json-out', out);
    expect(res.code).toBe(0);
    const parsed = JSON.parse(readFileSync(out, 'utf-8'));
    expect(parsed.signature.kind).toBe('message');
  });

  it('abstains (exit 3) on prose with no frames', async () => {
    const res = await brief(traceFile('checkout broke, see screenshot'));
    expect(res.code).toBe(3);
    expect(res.stderr).toContain('no V8 or CPython frames');
  });

  it('abstains (exit 3) when no frame resolves inside the root', async () => {
    const res = await brief(
      traceFile('Error: boom\n    at run (/elsewhere/lib/other.ts:3:1)'),
    );
    expect(res.code).toBe(3);
    expect(res.stderr).toContain('no frame resolves inside');
    expect(res.stderr).toContain('/elsewhere/lib/other.ts:3');
  });

  it('exits 2 when the trace file cannot be read', async () => {
    const res = await brief(join(root, 'nope.txt'));
    expect(res.code).toBe(2);
    expect(res.stderr).toContain('cannot read');
  });

  it('exits 2 when --root does not exist', async () => {
    const res = await invokeCanary([
      'judomaster',
      'brief',
      traceFile(V8_TRACE),
      '--root',
      join(root, 'missing'),
    ]);
    expect(res.code).toBe(2);
    expect(existsSync(join(root, 'missing'))).toBe(false);
  });
});
