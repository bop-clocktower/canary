/**
 * `canary adoption` (#491): the human and machine surfaces. Advisory, exit 0,
 * every signal with a denominator or an explicit abstention. Fixtures are
 * synthetic.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildAdoptionCommand } from '../src/adoption/adoption-cli.js';
import { defaultMainDeps, type MainDeps } from '../src/main-deps.js';

function harness(root: string, gitLog: string) {
  const out: string[] = [];
  const deps: MainDeps = {
    ...defaultMainDeps(),
    out: (s) => out.push(s),
    err: () => undefined,
    cwd: () => root,
    runSubprocess: (cmd, args) => {
      expect(cmd).toBe('git');
      return args[0] === 'log'
        ? { status: 0, stdout: gitLog, stderr: '' }
        : { status: 1, stdout: '', stderr: '' };
    },
  };
  return { deps, out };
}

async function run(deps: MainDeps, args: string[]): Promise<void> {
  const cmd = buildAdoptionCommand(deps);
  cmd.exitOverride();
  await cmd.parseAsync(args, { from: 'user' });
}

describe('canary adoption', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'adoption-cli-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function writeRecord(ref: string, total: number, unaddressed: number): void {
    const dir = join(root, '.harness', 'analyses');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `canary-pr-guardian-${ref}.json`),
      JSON.stringify({
        source: 'canary-pr-guardian',
        ref,
        gate: 'soft',
        tier: 1,
        abstained: false,
        degradedNotice: null,
        analyzedAt: '2026-09-01T00:00:00+00:00',
        summary: { total, unaddressed, suppressed: total - unaddressed },
      }),
    );
  }

  it('abstains loudly on an empty repo and still succeeds', async () => {
    const { deps, out } = harness(root, '');
    await run(deps, []);
    const text = out.join('\n');
    expect(text).toContain('0 guardian records');
    expect(text.match(/abstained/g)?.length).toBe(5);
    expect(text).toMatch(/disabled.*not measured/i);
    expect(text).toMatch(/Guardian workflow: not measured/);
    expect(text).toMatch(/nothing was sent/i);
  });

  it('prints each signal with its denominator', async () => {
    writeRecord('pr-5', 4, 4);
    writeRecord('pr-6', 2, 1);
    const { deps, out } = harness(root, 'feat: a (#5)\nfeat: b (#6)');
    await run(deps, []);
    const text = out.join('\n');
    expect(text).toContain('2 guardian records');
    expect(text).toContain(
      '2 of 2 merged PRs merged with unaddressed findings',
    );
    expect(text).toContain('1 of 6 findings suppressed');
  });

  it('--json carries egress none and no health aggregate', async () => {
    writeRecord('pr-5', 4, 4);
    mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
    const { deps, out } = harness(root, 'feat: a (#5)');
    await run(deps, ['--json']);
    const parsed = JSON.parse(out.join('')) as Record<string, unknown>;
    expect(parsed['egress']).toBe('none');
    expect(parsed['schemaVersion']).toBe('1.0');
    expect(parsed).not.toHaveProperty('healthy');
    expect(parsed).not.toHaveProperty('score');
    expect(parsed['workflow']).toMatchObject({
      presence: { status: 'measured' },
      disabled: { status: 'not-measured' },
    });
    expect(
      (parsed['signals'] as Record<string, { status: string }>)[
        'mergedWithUnaddressed'
      ]?.status,
    ).toBe('measured');
  });

  it('reads records from a cwd-relative --dir, not the repo-root default', async () => {
    // The two bases differ on purpose: the default dir is repo-root-relative,
    // a user-typed relative --dir is cwd-relative.
    const sub = join(root, 'sub');
    const custom = join(sub, 'elsewhere');
    mkdirSync(custom, { recursive: true });
    writeFileSync(
      join(custom, 'canary-pr-guardian-pr-9.json'),
      JSON.stringify({
        source: 'canary-pr-guardian',
        ref: 'pr-9',
        gate: 'soft',
        tier: 1,
        abstained: false,
        degradedNotice: null,
        analyzedAt: '2026-09-01T00:00:00+00:00',
        summary: { total: 2, unaddressed: 2, suppressed: 0 },
      }),
    );
    const { deps, out } = harness(root, 'feat: a (#9)');
    deps.cwd = () => sub;
    deps.runSubprocess = (_c, args) =>
      args[0] === 'rev-parse'
        ? { status: 0, stdout: `${root}\n`, stderr: '' }
        : { status: 0, stdout: 'feat: a (#9)', stderr: '' };
    await run(deps, ['--dir', 'elsewhere', '--branch', 'trunk']);
    const text = out.join('\n');
    expect(text).toContain('1 guardian records');
    expect(text).toContain('merge state from trunk');
    expect(text).toContain(
      '1 of 1 merged PRs merged with unaddressed findings',
    );
  });

  it('says it could not determine merge state when git fails, and still exits 0', async () => {
    writeRecord('pr-5', 4, 4);
    const { deps, out } = harness(root, '');
    deps.runSubprocess = (_c, args) =>
      args[0] === 'rev-parse'
        ? { status: 0, stdout: `${root}\n`, stderr: '' }
        : { status: 128, stdout: '', stderr: 'fatal: bad revision' };
    await run(deps, ['--branch', 'nope']);
    const text = out.join('\n');
    expect(text).toMatch(/Merged over findings: not measured .*bad revision/);
    expect(text).not.toContain('0 of 0 merged PRs');
  });

  it('survives a record file that is not a JSON object', async () => {
    const dir = join(root, '.harness', 'analyses');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'canary-pr-guardian-pr-4.json'), 'null');
    const { deps, out } = harness(root, '');
    await run(deps, []);
    expect(out.join('\n')).toContain(
      'skipped canary-pr-guardian-pr-4.json: not a JSON object',
    );
  });
});
