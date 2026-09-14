/**
 * Guards that refuse to guess, and one config-read degradation.
 *
 * `repoFromEnv` exists to make `canary batwoman` fail loudly rather than infer
 * the repository from a git remote -- auditing the wrong repo's run history
 * would produce a confident report about the wrong thing. The existing CLI
 * suite always injects `repo`, so that refusal had never been exercised.
 *
 * `readJsonWithWarning` promises never to raise; the "exists but could not be
 * read" arm is the one that keeps that promise when the path resolves to
 * something unreadable.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { buildBatwomanCommand } from '../src/batwoman-cli.js';
import { readJsonWithWarning } from '../src/core/config-validation.js';
import { defaultMainDeps, type MainDeps } from '../src/main-deps.js';

const tmpDirs: string[] = [];

function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), 'canary-guards-'));
  tmpDirs.push(d);
  return d;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

/**
 * Run `batwoman` with the real env-backed `repo` wiring left in place -- the
 * seam the rest of the CLI suite overrides.
 */
async function runWithEnv(
  env: NodeJS.ProcessEnv,
  argv: string[] = ['--issue', '1'],
): Promise<{ out: string; err: string; code: number | undefined }> {
  let out = '';
  let err = '';
  const deps: MainDeps = {
    ...defaultMainDeps(),
    env,
    cwd: () => scratch(),
    out: (s) => {
      out += `${s}\n`;
    },
    err: (s) => {
      err += `${s}\n`;
    },
  };
  // `repo` is deliberately NOT overridden: repoFromEnv is the code under test.
  const command = buildBatwomanCommand(deps, {});
  command.exitOverride();
  let code: number | undefined;
  try {
    await command.parseAsync(['node', 'batwoman', ...argv]);
  } catch (e) {
    code = (e as { exitCode?: number }).exitCode ?? 1;
  }
  return { out, err, code };
}

describe('batwoman repository resolution', () => {
  it('refuses to run when GITHUB_REPOSITORY is unset', async () => {
    const { out, err, code } = await runWithEnv({});

    expect(code).toBe(1);
    // The refusal must say what to set; a bare "missing repo" would leave the
    // operator guessing at the variable name and its "owner/name" shape.
    expect(err).toContain('GITHUB_REPOSITORY');
    expect(err).toContain('owner/name');
    // No partial report: half a report reads as a whole one.
    expect(out).toBe('');
  });

  it('treats a blank GITHUB_REPOSITORY as unset', async () => {
    // An unset variable in Actions commonly arrives as "" rather than absent.
    const { err, code } = await runWithEnv({ GITHUB_REPOSITORY: '   ' });

    expect(code).toBe(1);
    expect(err).toContain('GITHUB_REPOSITORY');
  });

  it('explains that it will not infer the repository from a git remote', async () => {
    // This sentence is the whole reason the guard exists, so it is behavior:
    // it tells the operator the omission was deliberate, not a lookup failure.
    const { err } = await runWithEnv({});

    expect(err).toContain('not inferred from a git remote');
  });
});

describe('batwoman --issue validation', () => {
  // Only values that fail BEFORE any audit runs belong here. `1.5` is
  // deliberately absent: `Number.parseInt` truncates it to 1, so the command
  // accepts it and proceeds. Asserting it "fails" would have passed for the
  // wrong reason -- the failure would come from the audit's network call, not
  // from validation -- which is a vacuous test, not a covered branch.
  it.each([['0'], ['-3'], ['abc'], ['']])(
    'rejects %j as an issue number before running any audit',
    async (raw) => {
      const { code, out, err } = await runWithEnv(
        { GITHUB_REPOSITORY: 'owner/name' },
        ['--issue', raw],
      );

      // A usage error, not a crash, and not a network attempt.
      expect(code).not.toBe(0);
      expect(out).toBe('');
      expect(err).toBe('');
    },
  );
});

describe('readJsonWithWarning', () => {
  it('parses a valid JSON file with no warning', () => {
    const dir = scratch();
    const p = join(dir, 'ok.json');
    writeFileSync(p, '{"a":1}');

    expect(readJsonWithWarning(p)).toEqual([{ a: 1 }, null]);
  });

  it('reports no value and no warning when the file is absent', () => {
    // Absence is normal (an optional config), so it must not warn.
    expect(readJsonWithWarning(join(scratch(), 'nope.json'))).toEqual([
      null,
      null,
    ]);
  });

  it('warns instead of raising when the path exists but cannot be read', () => {
    // A directory exists but is not readable as a file -- the degradation that
    // keeps the documented "never raises" contract.
    const dir = scratch();

    const [value, warning] = readJsonWithWarning(dir);

    expect(value).toBeNull();
    expect(warning).toContain('could not be read');
    expect(warning).toContain(dir);
  });

  it('warns instead of raising on invalid JSON', () => {
    const dir = scratch();
    const p = join(dir, 'bad.json');
    writeFileSync(p, '{not json');

    const [value, warning] = readJsonWithWarning(p);

    expect(value).toBeNull();
    expect(warning).not.toBeNull();
  });
});
