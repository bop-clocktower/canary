/**
 * `canary vacuity-check --baseline / --update-baseline` (#1322).
 *
 * The ratchet a consuming monorepo had to hand-roll: fail on a vacuous test
 * the committed baseline does not hold, report a fixed one as shrinkage, and
 * never let a scan that checked zero tests read as a pass. Every case plants a
 * REAL VAC-001 through the real scanner, so a comparison that matched
 * everything (or nothing) cannot pass here.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createCanaryCommand } from '../src/cli.js';
import { EXIT_ABSTAINED } from '../src/core/gate-result.js';
import { invokeCanary, mkTmp, rmTmp } from './canary-cli-testkit.js';

const vacuous = (title: string, pad = 0): string =>
  [
    `import { it, expect } from 'vitest';`,
    `import { save } from './store.js';`,
    ...Array<string>(pad).fill('// padding'),
    `it('${title}', () => {`,
    `  save(1);`,
    `  expect(true).toBe(true);`,
    `});`,
    ``,
  ].join('\n');

let home = '';
beforeEach(() => {
  home = mkTmp();
  mkdirSync(join(home, 'tests'), { recursive: true });
});
afterEach(() => rmTmp(home));

const put = (rel: string, text: string): void =>
  writeFileSync(join(home, rel), text, 'utf-8');
const run = (...args: string[]) =>
  invokeCanary(['vacuity-check', 'tests', ...args], { cwd: home });
const readBaseline = () =>
  JSON.parse(readFileSync(join(home, 'bl.json'), 'utf-8')) as {
    tool: string;
    findings: Array<{ file: string; rule: string; anchor: string }>;
  };
const baselineOf = (stdout: string) =>
  (JSON.parse(stdout) as { baseline: Record<string, unknown> }).baseline;

describe('canary vacuity-check --baseline', () => {
  it('writes a baseline keyed on file, rule and test name -- no line', async () => {
    put('tests/a.test.ts', vacuous('proves nothing'));
    expect((await run('--update-baseline', 'bl.json')).code).toBe(0);
    const bl = readBaseline();
    expect(bl.tool).toBe('canary vacuity-check');
    expect(bl.findings).toContainEqual({
      file: 'tests/a.test.ts',
      rule: 'VAC-001',
      anchor: 'proves nothing',
      count: 1,
    });
  });

  it('passes against its own baseline and reports the counts', async () => {
    put('tests/a.test.ts', vacuous('proves nothing'));
    await run('--update-baseline', 'bl.json');
    const res = await run('--baseline', 'bl.json', '--json');
    expect(res.code).toBe(0);
    expect(baselineOf(res.stdout)).toMatchObject({
      checked: 1,
      new: 0,
      fixed: 0,
      baselined: 1,
    });
  });

  it('keeps the identity when the test moves down the file', async () => {
    put('tests/a.test.ts', vacuous('proves nothing'));
    await run('--update-baseline', 'bl.json');
    put('tests/a.test.ts', vacuous('proves nothing', 12));
    expect((await run('--baseline', 'bl.json')).code).toBe(0);
  });

  it('fails (exit 1) on a vacuous test the baseline does not hold', async () => {
    put('tests/a.test.ts', vacuous('proves nothing'));
    await run('--update-baseline', 'bl.json');
    put('tests/b.test.ts', vacuous('also nothing'));
    const res = await run('--baseline', 'bl.json', '--json');
    expect(res.code).toBe(1);
    const b = baselineOf(res.stdout) as {
      new: number;
      entries: { new: Array<{ file: string; anchor: string }> };
    };
    expect(b.new).toBe(1);
    expect(b.entries.new[0]).toMatchObject({
      file: 'tests/b.test.ts',
      anchor: 'also nothing',
    });
  });

  it('reports a fixed finding as shrinkage and exits 0', async () => {
    put('tests/a.test.ts', vacuous('proves nothing'));
    put('tests/b.test.ts', vacuous('also nothing'));
    await run('--update-baseline', 'bl.json');
    rmSync(join(home, 'tests/b.test.ts'));
    const res = await run('--baseline', 'bl.json');
    expect(res.code).toBe(0);
    expect(res.stdout).toMatch(/1 fixed/);
  });

  it('abstains (exit 3) on zero tests checked, and writes nothing', async () => {
    put('tests/a.test.ts', vacuous('proves nothing'));
    await run('--update-baseline', 'bl.json');
    const before = readFileSync(join(home, 'bl.json'), 'utf-8');
    rmSync(join(home, 'tests/a.test.ts'));
    const res = await run('--baseline', 'bl.json', '--json');
    expect(res.code).toBe(EXIT_ABSTAINED);
    expect(baselineOf(res.stdout)).toMatchObject({
      checked: 0,
      verdict: 'abstained',
    });
    expect((await run('--update-baseline', 'bl.json')).code).toBe(
      EXIT_ABSTAINED,
    );
    expect(readFileSync(join(home, 'bl.json'), 'utf-8')).toBe(before);
  });

  it('refuses to grow an existing baseline without --allow-growth', async () => {
    put('tests/a.test.ts', vacuous('proves nothing'));
    await run('--update-baseline', 'bl.json');
    put('tests/b.test.ts', vacuous('also nothing'));
    expect((await run('--update-baseline', 'bl.json')).code).toBe(1);
    expect(readBaseline().findings).toHaveLength(1);
    const res = await run('--update-baseline', 'bl.json', '--allow-growth');
    expect(res.code).toBe(0);
    expect(readBaseline().findings).toHaveLength(2);
  });

  it('errors (exit 2) on a missing or malformed baseline file', async () => {
    put('tests/a.test.ts', vacuous('proves nothing'));
    const missing = await run('--baseline', 'nope.json');
    expect(missing.code).toBe(2);
    expect(missing.stderr).toMatch(/nope\.json/);
    put('bad.json', '{"schemaVersion":1,"tool":"canary-savant","findings":[]}');
    const wrong = await run('--baseline', 'bad.json');
    expect(wrong.code).toBe(2);
    expect(wrong.stderr).toMatch(/canary-savant/);
  });

  it('rejects contradictory flags as a usage error', async () => {
    put('tests/a.test.ts', vacuous('proves nothing'));
    const both = await run('--baseline', 'a', '--update-baseline', 'b');
    expect(both.code).toBe(2);
    expect((await run('--allow-growth')).code).toBe(2);
    // An unset CI variable must not quietly mean "no baseline".
    expect((await run('--baseline', '')).code).toBe(2);
  });

  it('documents the exit-code table in --help', async () => {
    expect((await invokeCanary(['vacuity-check', '--help'])).code).toBe(0);
    // The harness does not capture commander's help text, so render it here
    // through outputHelp(), which (unlike helpInformation) runs addHelpText.
    const cmd = createCanaryCommand().commands.find(
      (c) => c.name() === 'vacuity-check',
    )!;
    let help = '';
    cmd.configureOutput({ writeOut: (s) => void (help += s) });
    cmd.outputHelp();
    expect(help).toMatch(/--baseline <file>/);
    expect(help).toMatch(/--update-baseline <file>/);
    expect(help).toMatch(/Exit codes[\s\S]*\n {2}3 {2}/);
  });
});
