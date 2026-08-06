/**
 * ESM/CJS test-file discovery and the single-file false clean (#566).
 *
 * Four defects, one investigation, all of the same family as #503/#508 -- a
 * gate that measured nothing reporting a pass:
 *
 *   1. `.mjs`/`.cjs` never matched the discovery glob, and worse, an extension
 *      the linter did not recognise fell through `detectFramework` to `pytest`.
 *      Python assertion scanners over ESM JavaScript find nothing, so a single
 *      `.mjs` file rendered "No issues found" and exited 0. A *directory* of
 *      the same files abstained correctly -- the contract was half-wired, and
 *      the abstention's own remedy text ("or pass a single file directly")
 *      routed the reader into the lying path.
 *   2. `walkFiles` had no ignore-dir set, so `node_modules` was scanned. A
 *      consumer measured 254 of 256 findings inside a vendored dependency.
 *   3. `--json` returned before the exit-code throw, so a `--json` consumer
 *      gating on `$?` saw every finding-bearing run as clean.
 *
 * The parity tests deliberately use the REAL linter: the bug lived in
 * framework detection, so a fake linter would report parity that the shipped
 * code does not have.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { EXIT_ABSTAINED } from '../src/core/gate-result.js';
import { invokeCanary, mkTmp, rmTmp } from './canary-cli-testkit.js';

/**
 * One assertion-free vitest test -- LINT-006 bait. Identical bytes are written
 * under every extension so a difference in findings can only come from
 * discovery or framework detection, never from the content.
 */
const ASSERTION_FREE = [
  'import { test } from "vitest";',
  'test("no assertions here at all", async () => {',
  '  const x = 1 + 1;',
  '  console.log(x);',
  '});',
  '',
].join('\n');

function writeProbe(base: string, ext: string): string {
  const file = join(base, `probe.test.${ext}`);
  writeFileSync(file, ASSERTION_FREE, 'utf-8');
  return file;
}

/**
 * Findings for one file, minus `file` itself -- the probes differ only by
 * extension, so the path is the one field that is *expected* to differ.
 */
async function findingsFor(file: string): Promise<unknown[]> {
  const res = await invokeCanary(['review-test', file, '--json']);
  const findings = JSON.parse(res.stdout) as Record<string, unknown>[];
  return findings.map(({ file: _file, ...rest }) => rest);
}

describe('review-test: single-file findings do not depend on the extension', () => {
  it('reports the same findings for .mjs and .cjs as for .js and .ts', async () => {
    const base = mkTmp();
    try {
      const js = await findingsFor(writeProbe(base, 'js'));
      expect(js.length).toBeGreaterThan(0); // guard: the bait must bite

      for (const ext of ['ts', 'mjs', 'cjs']) {
        const got = await findingsFor(writeProbe(base, ext));
        expect(got, `.${ext} should match .js`).toEqual(js);
      }
    } finally {
      rmTmp(base);
    }
  });

  it('never renders a green all-clear for a .mjs file that has findings', async () => {
    const base = mkTmp();
    try {
      const res = await invokeCanary(['review-test', writeProbe(base, 'mjs')]);
      expect(res.stdout).not.toContain('No issues found');
      expect(res.stdout).toContain('LINT-006');
    } finally {
      rmTmp(base);
    }
  });
});

describe('review-test: an unparseable single file abstains', () => {
  it('exits 3 rather than reporting clean on an extension it cannot lint', async () => {
    const base = mkTmp();
    try {
      const file = join(base, 'probe.test.rb');
      writeFileSync(file, "it 'does a thing' do\nend\n", 'utf-8');

      const res = await invokeCanary(['review-test', file]);
      expect(res.code).toBe(EXIT_ABSTAINED);
      expect(res.stdout).not.toContain('No issues found');
      expect(res.stdout).toContain('Abstained');
      expect(res.stdout).toContain('.rb');
    } finally {
      rmTmp(base);
    }
  });

  it('flake-check abstains on the same file', async () => {
    const base = mkTmp();
    try {
      const file = join(base, 'probe.test.rb');
      writeFileSync(file, 'sleep 2\n', 'utf-8');

      const res = await invokeCanary(['flake-check', file]);
      expect(res.code).toBe(EXIT_ABSTAINED);
      expect(res.stdout).not.toContain('No flakiness patterns detected');
    } finally {
      rmTmp(base);
    }
  });
});

describe('directory discovery', () => {
  it('collects .mjs and .cjs test files', async () => {
    const base = mkTmp();
    try {
      const dir = join(base, 'esm-suite');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'a.test.mjs'), ASSERTION_FREE, 'utf-8');
      writeFileSync(join(dir, 'b.spec.cjs'), ASSERTION_FREE, 'utf-8');

      const res = await invokeCanary(['review-test', dir, '--json']);
      expect(res.code).not.toBe(EXIT_ABSTAINED);
      const findings = JSON.parse(res.stdout) as { file: string }[];
      const files = new Set(findings.map((f) => f.file));
      expect(files.size).toBe(2);
    } finally {
      rmTmp(base);
    }
  });

  it('excludes node_modules from the walk', async () => {
    const base = mkTmp();
    try {
      const dir = join(base, 'suite');
      const vendored = join(dir, 'node_modules', 'zod', 'test');
      mkdirSync(vendored, { recursive: true });
      writeFileSync(join(dir, 'mine.test.js'), ASSERTION_FREE, 'utf-8');
      writeFileSync(join(vendored, 'theirs.test.js'), ASSERTION_FREE, 'utf-8');

      const res = await invokeCanary(['review-test', dir, '--json']);
      const findings = JSON.parse(res.stdout) as { file: string }[];
      expect(findings.length).toBeGreaterThan(0);
      expect(findings.every((f) => !f.file.includes('node_modules'))).toBe(
        true,
      );
    } finally {
      rmTmp(base);
    }
  });
});

describe('--json carries the same exit code as human mode', () => {
  const critical = [
    'import { test } from "vitest";',
    'test("waits on the wall clock", async () => {',
    '  await page.waitForTimeout(5000);',
    '  await page.click(".btn");',
    '});',
    '',
  ].join('\n');

  it('review-test: a critical finding exits 1 in both modes', async () => {
    const base = mkTmp();
    try {
      const file = join(base, 'crit.test.ts');
      writeFileSync(file, critical, 'utf-8');

      const human = await invokeCanary(['review-test', file]);
      const json = await invokeCanary(['review-test', file, '--json']);
      expect(human.code).toBe(1); // guard: the fixture must be critical
      expect(json.code).toBe(human.code);
    } finally {
      rmTmp(base);
    }
  });

  it('flake-check: findings exit 1 in both modes', async () => {
    const base = mkTmp();
    try {
      const file = join(base, 'flaky.test.ts');
      writeFileSync(file, critical, 'utf-8');

      const human = await invokeCanary(['flake-check', file]);
      const json = await invokeCanary(['flake-check', file, '--json']);
      expect(human.code).toBe(1); // guard: the fixture must be flaky
      expect(json.code).toBe(human.code);
    } finally {
      rmTmp(base);
    }
  });
});
