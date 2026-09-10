/**
 * `canary vacuity-check` — the CLI surface of canary-cassandra (#612).
 *
 * Registered as an **advisory** command, not a gate. That is this repo's
 * established shape for a brand-new detector (see the dogfooding jobs: advisory
 * first, ratchet to strict only after triage), and it is the one thing that must
 * not be got wrong by accident, so it is asserted here rather than described in
 * a doc: findings exit 0, a collapsed denominator exits 3.
 *
 * The asymmetry is deliberate and is the whole #508 doctrine. "I found weak
 * tests" is information a repo can absorb over time. "I verified nothing" is a
 * broken instrument, and an instrument that reports its own silence as success
 * is exactly the false-green class this command exists to detect.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { EXIT_ABSTAINED } from '../src/core/gate-result.js';
import { boundedTitle } from '../src/core/vacuity-scanner.js';
import { invokeCanary, mkTmp, rmTmp } from './canary-cli-testkit.js';

const VACUOUS = [
  `import { it, expect } from 'vitest';`,
  `import { save } from './store.js';`,
  `it('proves nothing', () => {`,
  `  save(1);`,
  `  expect(true).toBe(true);`,
  `});`,
  ``,
].join('\n');

const SOUND = [
  `import { it, expect } from 'vitest';`,
  `import { save } from './store.js';`,
  `it('saves', () => {`,
  `  expect(save(1)).toBe(2);`,
  `});`,
  ``,
].join('\n');

describe('canary vacuity-check', () => {
  it('reports findings and still exits 0 — advisory, not a gate', async () => {
    const home = mkTmp();
    try {
      const dir = join(home, 'tests');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'a.test.ts'), VACUOUS, 'utf-8');
      const res = await invokeCanary(['vacuity-check', dir]);
      expect(res.code).toBe(0);
      expect(res.stdout).toContain('VAC-001');
      // The denominator travels with the verdict, always.
      expect(res.stdout).toMatch(/1 checked|across 1/);
    } finally {
      rmTmp(home);
    }
  });

  it('exits 3 when it matched no test file — abstention, not a pass', async () => {
    const home = mkTmp();
    try {
      const dir = join(home, 'empty');
      mkdirSync(dir, { recursive: true });
      const res = await invokeCanary(['vacuity-check', dir]);
      expect(res.code).toBe(EXIT_ABSTAINED);
      expect(res.stdout + res.stderr).toMatch(/not a pass|Abstained/);
    } finally {
      rmTmp(home);
    }
  });

  it('exits 3 when the files it found held zero tests', async () => {
    const home = mkTmp();
    try {
      // The subtler zero: files WERE collected, so the file-level denominator is
      // healthy, and every one of them turned out to hold no test at all. A
      // scanner that only guarded the file count would print a clean tick here.
      const dir = join(home, 'tests');
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'a.test.ts'),
        'export const fixture = 1;\n',
        'utf-8',
      );
      const res = await invokeCanary(['vacuity-check', dir]);
      expect(res.code).toBe(EXIT_ABSTAINED);
      expect(res.stdout + res.stderr).toMatch(/not a pass|Abstained/);
    } finally {
      rmTmp(home);
    }
  });

  it('prints a clean line naming the denominator it verified', async () => {
    const home = mkTmp();
    try {
      const dir = join(home, 'tests');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'a.test.ts'), SOUND, 'utf-8');
      const res = await invokeCanary(['vacuity-check', dir]);
      expect(res.code).toBe(0);
      expect(res.stdout).toMatch(/1/);
      expect(res.stdout).not.toMatch(/Abstained/);
    } finally {
      rmTmp(home);
    }
  });

  it('emits machine-readable findings with the fidelity tier', async () => {
    const home = mkTmp();
    try {
      const dir = join(home, 'tests');
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'a.test.ts'),
        [
          `import { it, expect } from 'vitest';`,
          `import { save } from './store.js';`,
          `it('touches nothing', () => { const row = {}; expect(row).toEqual({ }); });`,
          ``,
        ].join('\n'),
        'utf-8',
      );
      const res = await invokeCanary(['vacuity-check', dir, '--json']);
      const payload = JSON.parse(res.stdout);
      expect(payload.checked).toBe(1);
      expect(
        payload.findings.some((f: { rule: string }) => f.rule === 'VAC-002'),
      ).toBe(true);
      const vac2 = payload.findings.find(
        (f: { rule: string }) => f.rule === 'VAC-002',
      );
      expect(vac2.fidelity).toBe('import-inferred');
    } finally {
      rmTmp(home);
    }
  });

  it('keeps the JSON payload parseable when it abstains', async () => {
    const home = mkTmp();
    try {
      const dir = join(home, 'empty');
      mkdirSync(dir, { recursive: true });
      const res = await invokeCanary(['vacuity-check', dir, '--json']);
      expect(res.code).toBe(EXIT_ABSTAINED);
      const payload = JSON.parse(res.stdout);
      expect(payload.checked).toBe(0);
      expect(payload.abstained).toBe(true);
    } finally {
      rmTmp(home);
    }
  });

  it('surfaces the skip reason when a target cannot be resolved', async () => {
    const home = mkTmp();
    try {
      const dir = join(home, 'tests');
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'a.test.ts'),
        [
          `import { it, expect } from 'vitest';`,
          `it('adds', () => { expect(1 + 1).toBe(2); });`,
          ``,
        ].join('\n'),
        'utf-8',
      );
      const res = await invokeCanary(['vacuity-check', dir]);
      expect(res.code).toBe(0);
      // "Cannot verify" has to reach the reader, or the rung of the ladder that
      // did not run looks the same as the one that passed.
      expect(res.stdout).toMatch(/skipped/i);
      expect(res.stdout).toMatch(/@covers/);
    } finally {
      rmTmp(home);
    }
  });

  // #860: 232 skips rendered as one several-thousand-character summary line,
  // with raw `describe` bodies inlined. A wall of text is how skips get ignored,
  // so the summary counts per reason and the per-test list moves behind a flag.
  describe('skip summary shape (#860)', () => {
    const UNRESOLVABLE = [
      `import { it, expect } from 'vitest';`,
      ...Array.from(
        { length: 12 },
        (_, i) =>
          `it('adds ${i}', () => { expect(${i} + 1).toBe(${i + 1}); });`,
      ),
      // Mixed quotes in a title is the real-suite shape that made the title
      // parser swallow the source after it, inlining it into the summary.
      `it('multi "quoted" title', () => {`,
      `  const a = 1;`,
      ...Array.from({ length: 10 }, (_, i) => `  // filler line ${i}`),
      `  expect(a).toBe(1);`,
      `});`,
      ``,
    ].join('\n');

    function withSuite(run: (dir: string) => Promise<void>) {
      return async () => {
        const home = mkTmp();
        try {
          const dir = join(home, 'tests');
          mkdirSync(dir, { recursive: true });
          writeFileSync(join(dir, 'a.test.ts'), UNRESOLVABLE, 'utf-8');
          await run(dir);
        } finally {
          rmTmp(home);
        }
      };
    }

    it(
      'counts skips per reason instead of listing every test',
      withSuite(async (dir) => {
        const res = await invokeCanary(['vacuity-check', dir]);
        expect(res.code).toBe(0);
        const summary = res.stdout.trim().split('\n').at(-1)!;
        expect(summary).toMatch(
          /13 skipped: 13 test\(s\) \[target unresolvable/,
        );
        expect(summary).not.toContain('adds 3');
        expect(summary).toMatch(/--verbose/);
        expect(summary.length).toBeLessThan(400);
      }),
    );

    it(
      'lists each skipped test, one per line with file:line, under --verbose',
      withSuite(async (dir) => {
        const res = await invokeCanary(['vacuity-check', dir, '--verbose']);
        expect(res.code).toBe(0);
        expect(res.stdout).toMatch(/a\.test\.ts:2 .*adds 0/);
        expect(res.stdout).toMatch(/a\.test\.ts:14 .*multi "quoted" title/);
      }),
    );

    // A mis-parsed title can carry the source after it (seen on this repo's
    // own suite). The label is bounded so a parser slip can never flood output.
    it('bounds a skip label to the first line of the title', () => {
      const raw = `keeps it', () => {\n    // body\n  ${'x'.repeat(300)}`;
      const label = boundedTitle(raw);
      expect(label).not.toContain('\n');
      expect(label.length).toBeLessThanOrEqual(81);
      expect(boundedTitle('short')).toBe('short');
    });
  });
});
