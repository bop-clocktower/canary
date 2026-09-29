/**
 * `canary manhunter` (#611) end to end through the real command tree.
 *
 * The exit code IS the release-checklist item: 0 when the evidence is
 * complete, 1 when any section is dark and undeclared, 3 when nothing at all
 * was read. Worth-your-eyes items never move it -- the dossier grades the
 * evidence, not the product.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createCanaryCommand } from '../src/cli.js';
import { EXIT_ABSTAINED } from '../src/core/gate-result.js';
import { invokeCanary, mkTmp, rmTmp } from './canary-cli-testkit.js';

let root: string;
beforeEach(() => {
  root = mkTmp();
});
afterEach(() => {
  rmTmp(root);
});

function put(rel: string, body: unknown): void {
  const path = join(root, rel);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(
    path,
    typeof body === 'string' ? body : JSON.stringify(body, null, 2),
  );
}

function seedHistory(): void {
  const line = (i: number) =>
    JSON.stringify({
      schema_version: 3,
      run_id: `api-${i}`,
      suite: 'api',
      branch: 'main',
      commit_sha: `c0ffee${i}`,
      timestamp: `2026-09-0${i + 1}T00:00:00Z`,
      total: 1,
      passed: 1,
      failed: 0,
      flaky: 0,
      skipped: 0,
      tests: [
        { test_name: 'a', test_file: 'tests/a.spec.ts', status: 'passed' },
      ],
    });
  put(
    'test-results/reports/history-v2.jsonl',
    [0, 1, 2].map(line).join('\n') + '\n',
  );
}

/** Every conventional source present with a non-zero denominator. */
function seedAll(): void {
  seedHistory();
  put('.harness/analyses/canary-pr-guardian-pr-1.json', {
    schemaVersion: '1.3',
    ref: 'pr-1',
    checked: 10,
    abstained: false,
    coverage: { status: 'verified' },
    summary: {
      total: 0,
      unaddressed: 0,
      suppressed: 0,
      byFidelity: {},
    },
    findings: [],
  });
  put('.canary/quarantine.json', { schema_version: 2, entries: [] });
  put('.canary/escapes.json', {
    schema_version: 1,
    tracked_since: '2026-07-01',
    escapes: [],
  });
  put('a11y/report.json', {
    version: 1,
    summary: { pages: 2, rule_evaluations: 50, abstained: false },
    findings: [],
  });
}

describe('canary manhunter', () => {
  it('exits 3 and says it abstained when no source exists at all', async () => {
    const r = await invokeCanary(['manhunter', '--root', root]);
    expect(r.code).toBe(EXIT_ABSTAINED);
    expect(r.stdout).toContain('**Evidence verdict:** ABSTAINED');
  });

  it('exits 1 when any section is dark, and names it', async () => {
    seedAll();
    const r = await invokeCanary(['manhunter', '--root', root]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('**Evidence verdict:** INCOMPLETE');
    expect(r.stdout).toContain('## Accessibility sweep: DARK');
  });

  it('exits 0 once every source is fed', async () => {
    seedAll();
    const r = await invokeCanary([
      'manhunter',
      '--root',
      root,
      '--sweep',
      'a11y/report.json',
      '--release',
      'v9.9.9',
    ]);
    expect(r.stdout).toContain('**Evidence verdict:** COMPLETE');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('# Release quality dossier: v9.9.9');
  });

  it('lets a declared exclusion complete the dossier and prints its reason', async () => {
    seedAll();
    const r = await invokeCanary([
      'manhunter',
      '--root',
      root,
      '--exclude',
      'sweep=no UI surface',
    ]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('## Accessibility sweep: EXCLUDED');
    expect(r.stdout).toContain('no UI surface');
  });

  it('refuses an exclusion with no reason or an unknown section (usage error)', async () => {
    const empty = await invokeCanary([
      'manhunter',
      '--root',
      root,
      '--exclude',
      'sweep=',
    ]);
    expect(empty.code).toBe(2);
    expect(empty.stderr).toContain('needs a reason');
    const unknown = await invokeCanary([
      'manhunter',
      '--root',
      root,
      '--exclude',
      'vibes=fine',
    ]);
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain('unknown section "vibes"');
  });

  it('writes --out and --json-out and nothing to stdout, and verify round-trips the digest', async () => {
    seedAll();
    const r = await invokeCanary([
      'manhunter',
      '--root',
      root,
      '--out',
      join(root, 'dossier.md'),
      '--json-out',
      join(root, 'dossier.json'),
    ]);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe('');
    expect(existsSync(join(root, 'dossier.md'))).toBe(true);
    const json = JSON.parse(readFileSync(join(root, 'dossier.json'), 'utf-8'));
    expect(json.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(join(root, 'dossier.md'), 'utf-8')).toContain(
      json.digest,
    );

    const ok = await invokeCanary([
      'manhunter',
      'verify',
      join(root, 'dossier.json'),
    ]);
    expect(ok.code).toBe(0);
    expect(ok.stdout).toContain('digest matches');

    json.verdict = 'complete';
    writeFileSync(join(root, 'tampered.json'), JSON.stringify(json));
    const bad = await invokeCanary([
      'manhunter',
      'verify',
      join(root, 'tampered.json'),
    ]);
    expect(bad.code).toBe(1);
    expect(bad.stdout).toContain('digest MISMATCH');

    const missing = await invokeCanary([
      'manhunter',
      'verify',
      join(root, 'nope.json'),
    ]);
    expect(missing.code).toBe(2);
  });

  it('produces the same digest on two runs over the same evidence', async () => {
    seedAll();
    const digest = async (name: string) => {
      await invokeCanary([
        'manhunter',
        '--root',
        root,
        '--json-out',
        join(root, name),
      ]);
      return JSON.parse(readFileSync(join(root, name), 'utf-8')).digest;
    };
    expect(await digest('a.json')).toBe(await digest('b.json'));
  });

  it('is mounted on the canary command tree with its verify subcommand', () => {
    const manhunter = createCanaryCommand().commands.find(
      (c) => c.name() === 'manhunter',
    );
    expect(manhunter).toBeDefined();
    expect(manhunter!.commands.map((c) => c.name())).toEqual(['verify']);
    expect(manhunter!.helpInformation()).toContain('--exclude <id=reason>');
  });
});
