/**
 * `canary judomaster` CLI (#614). Synthetic fixtures only: a fake cart/total
 * module in a temp root, traces captured "on another machine" under /app.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ExecuteResult } from '../src/core/executor.js';

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

const SIG = "Cannot read properties of undefined (reading 'qty')";
const TEST_REL = 'tests/generated/regression/total-typeerror.test.ts';

function seedGenerated(rel = TEST_REL): string {
  const p = join(root, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, '// generated regression test\n');
  return p;
}

async function writeBrief(): Promise<string> {
  const out = join(root, 'brief.json');
  await brief(traceFile(V8_TRACE), '--json-out', out);
  return out;
}

function executorReturning(result: ExecuteResult | (() => ExecuteResult)) {
  const spy = vi.fn(typeof result === 'function' ? result : () => result);
  return { spy, makeExecutor: () => ({ execute: spy }) as never };
}

async function verify(
  exec: ReturnType<typeof executorReturning>,
  ...args: string[]
) {
  return invokeCanary(['judomaster', 'verify', ...args, '--root', root], {
    deps: { makeExecutor: exec.makeExecutor },
  });
}

describe('canary judomaster verify', () => {
  it('reports reproduced (exit 0) when the failure carries the signature', async () => {
    const test = seedGenerated();
    const exec = executorReturning([1, `FAIL\nTypeError: ${SIG}`, '']);
    const res = await verify(exec, test, '--brief', await writeBrief());
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('reproduced');
  });

  it('flags a first-run pass as not-reproduced with vacuity (exit 1)', async () => {
    const test = seedGenerated();
    const exec = executorReturning([0, '1 passed', '']);
    const res = await verify(exec, test, '--brief', await writeBrief());
    expect(res.code).toBe(1);
    expect(res.stdout).toContain('not-reproduced');
    expect(res.stdout).toContain('VACUITY RED FLAG');
  });

  it('reports failed-other-reason (exit 1) for the wrong failure', async () => {
    const test = seedGenerated();
    const exec = executorReturning([1, 'AssertionError: nope', '']);
    const res = await verify(exec, test, '--brief', await writeBrief());
    expect(res.code).toBe(1);
    expect(res.stdout).toContain('failed-other-reason');
    expect(res.stdout).toContain('unverified');
  });

  it('is unverified (exit 3) when pytest collects nothing', async () => {
    const test = seedGenerated('tests/generated/regression/test_total.py');
    const exec = executorReturning([5, '', '']);
    const res = await verify(exec, test, '--expect', 'bad qty');
    expect(res.code).toBe(3);
    expect(res.stdout).toContain('unverified \u2014 could not reproduce');
  });

  it('is unverified (exit 3) when the executor throws', async () => {
    const test = seedGenerated();
    const exec = executorReturning(() => {
      throw new Error("Framework 'vitest' not found in registry.");
    });
    const res = await verify(exec, test, '--expect', SIG);
    expect(res.code).toBe(3);
    expect(res.stdout).toContain('not found in registry');
  });

  it('is unverified (exit 3) for an unknown framework without running', async () => {
    const test = seedGenerated('tests/generated/regression/total_spec.rb');
    const exec = executorReturning([1, SIG, '']);
    const res = await verify(exec, test, '--expect', SIG);
    expect(res.code).toBe(3);
    expect(exec.spy).not.toHaveBeenCalled();
  });

  it('confirms against --expect without a brief', async () => {
    const test = seedGenerated();
    const exec = executorReturning([1, `x ${SIG} y`, '']);
    const res = await verify(exec, test, '--expect', SIG);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('reproduced');
  });

  it('says there is no signature when given neither flag', async () => {
    const test = seedGenerated();
    const exec = executorReturning([1, SIG, '']);
    const res = await verify(exec, test);
    expect(res.code).toBe(1);
    expect(res.stdout).toContain('failed-other-reason');
    expect(res.stdout).toContain('no signature');
  });

  it('refuses (exit 2) a test outside tests/generated without spawning', async () => {
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'x.test.ts'), '// not generated\n');
    const exec = executorReturning([1, SIG, '']);
    const res = await verify(
      exec,
      join(root, 'src', 'x.test.ts'),
      '--expect',
      SIG,
    );
    expect(res.code).toBe(2);
    expect(res.stderr).toContain('tests/generated');
    expect(exec.spy).not.toHaveBeenCalled();
  });

  it('exits 2 when --brief is not a brief', async () => {
    const test = seedGenerated();
    const bogus = join(root, 'bogus.json');
    writeFileSync(bogus, JSON.stringify({ schema: 'something-else/1' }));
    const exec = executorReturning([1, SIG, '']);
    const res = await verify(exec, test, '--brief', bogus);
    expect(res.code).toBe(2);
    expect(exec.spy).not.toHaveBeenCalled();
  });

  it('exits 2 on a non-positive --timeout', async () => {
    const test = seedGenerated();
    const exec = executorReturning([1, SIG, '']);
    const res = await verify(exec, test, '--timeout', '0');
    expect(res.code).toBe(2);
    expect(exec.spy).not.toHaveBeenCalled();
  });

  it('passes the realpath, --framework and --timeout to the executor', async () => {
    const test = seedGenerated();
    const exec = executorReturning([1, SIG, '']);
    await verify(exec, test, '--framework', 'pytest', '--timeout', '5');
    expect(exec.spy).toHaveBeenCalledWith(realpathSync(test), 'pytest', 5);
  });

  it('defaults the timeout to 60 seconds', async () => {
    const test = seedGenerated();
    const exec = executorReturning([1, SIG, '']);
    await verify(exec, test);
    expect(exec.spy).toHaveBeenCalledWith(realpathSync(test), 'vitest', 60);
  });

  it('prints a JSON verify result with --json', async () => {
    const test = seedGenerated();
    const exec = executorReturning([0, '1 passed', '']);
    const res = await verify(exec, test, '--expect', SIG, '--json');
    expect(res.code).toBe(1);
    const parsed = JSON.parse(res.stdout);
    expect(parsed.schema).toBe('canary-judomaster-verify/1');
    expect(parsed.verdict).toBe('not-reproduced');
    expect(parsed.vacuity).toBe(true);
    expect(parsed.framework).toBe('vitest');
  });
});
