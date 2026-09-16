import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { invokeCanary, mkTmp, rmTmp } from './canary-cli-testkit.js';

const REPO = resolve(__dirname, '..', '..');
const CORPUS = resolve(__dirname, 'fixtures', 'gen-data');
const EMITTING = readdirSync(CORPUS)
  .filter((f) => f.endsWith('.schema.json') && f !== 'unresolvable.schema.json')
  .sort();
const skillCli = (skill: string) =>
  join(REPO, 'agents', 'skills', 'claude-code', skill, 'scripts', 'cli.mjs');

describe('gen-data corpus is detector-clean (criterion 7)', () => {
  let out: string;
  beforeAll(() => {
    out = mkTmp();
  });
  afterAll(() => rmTmp(out));

  it('the corpus has at least 5 emitting schemas (denominator guard)', () => {
    expect(EMITTING.length).toBeGreaterThanOrEqual(5);
  });

  it.each(EMITTING)(
    '%s emits, and blackhawk + savant CLIs report 0 findings',
    async (schema) => {
      const res = await invokeCanary([
        'gen-data',
        '--schema',
        join(CORPUS, schema),
        '--framework',
        'vitest',
        '--out',
        out,
        '--json',
      ]);
      expect(res.code).toBe(0);
      const file = JSON.parse(res.stdout).output as string;
      expect(readFileSync(file, 'utf-8').length).toBeGreaterThan(0);
      for (const skill of ['canary-blackhawk', 'canary-savant']) {
        const r = spawnSync('node', [skillCli(skill), '--json', file], {
          encoding: 'utf-8',
          timeout: 20_000,
        });
        expect(r.status, `${skill} stderr: ${r.stderr}`).toBe(0);
        const report = JSON.parse(r.stdout);
        // A 0-file scan is an abstention, not a pass.
        expect(report.summary.files_scanned).toBe(1);
        expect(report.findings).toEqual([]);
      }
    },
  );

  it('unresolvable.schema.json abstains with exit 3', async () => {
    const res = await invokeCanary([
      'gen-data',
      '--schema',
      join(CORPUS, 'unresolvable.schema.json'),
      '--framework',
      'vitest',
      '--out',
      out,
    ]);
    expect(res.code).toBe(3);
  });
});
