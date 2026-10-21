/**
 * The required `security` check (`harness-security.yml`) runs on the Node the
 * repo pins, and a failing `harness validate` explains itself in the log
 * (#1401).
 *
 * Run 39298544259 failed `Validate architecture` with exit 1 and no output.
 * The log held only npm EBADENGINE warnings: the job ran Node 20, and a CLI
 * dependency declares `node >=22.19.0`. A rerun at the same SHA was green. The
 * cause was never reproduced, so this file pins down the two fixes that do not
 * depend on knowing it. The job runs the `.nvmrc` Node, so it uses the same
 * runtime as local runs and meets the CLI's engine floor. And a red validate
 * prints its exit code and its `--json` result, or says that the result was
 * empty. The next failure can then be told apart: a real violation, or a CLI
 * that crashed before it reported anything.
 *
 * Offline: parses the workflow with js-yaml. The `run:` tests execute the
 * validate step's own script under bash with a stub `npx`, so they check what
 * the step does, not what its text looks like.
 */

import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as loadYaml } from 'js-yaml';
import { afterEach, describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORKFLOW = join(
  REPO_ROOT,
  '.github',
  'workflows',
  'harness-security.yml',
);

type Step = {
  name?: string;
  id?: string;
  uses?: string;
  with?: Record<string, unknown>;
  run?: string;
};
type Workflow = { jobs: Record<string, { steps?: Step[] }> };

const steps = (): Step[] =>
  (loadYaml(readFileSync(WORKFLOW, 'utf8')) as Workflow).jobs.security!.steps!;

const validateStep = (): Step => {
  const found = steps().filter((s) => /harness validate\b/.test(s.run ?? ''));
  expect(found).toHaveLength(1);
  return found[0]!;
};

describe('harness-security.yml runs on the pinned Node (#1401)', () => {
  it('sets up Node from .nvmrc, not a hardcoded major', () => {
    const setup = steps().filter((s) =>
      (s.uses ?? '').startsWith('actions/setup-node@'),
    );
    expect(setup).toHaveLength(1);
    expect(setup[0]!.with).toEqual({ 'node-version-file': '.nvmrc' });
  });
});

describe('a failing harness validate leaves an actionable log (#1401)', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  /** Run the validate step's script with `npx` stubbed to print and exit. */
  function runStep(stdout: string, code: number) {
    dir = mkdtempSync(join(tmpdir(), 'sec-validate-'));
    const stub = join(dir, 'npx');
    writeFileSync(
      stub,
      `#!/bin/bash\necho "$*" > "${dir}/args"\nprintf '%s' '${stdout}'\nexit ${code}\n`,
    );
    chmodSync(stub, 0o755);
    const res = spawnSync('bash', ['-e', '-c', validateStep().run!], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        PATH: `${dir}:${process.env.PATH}`,
        HARNESS_CLI_EXACT: '@harness-engineering/cli@13.0.0',
      },
    });
    const args = readFileSync(join(dir, 'args'), 'utf8').trim();
    return { ...res, args, log: `${res.stdout}${res.stderr}` };
  }

  it('runs validate with --json on the exact pin', () => {
    const r = runStep('{"valid":true,"issues":[]}', 0);
    expect(r.args).toBe(
      '--yes -p @harness-engineering/cli@13.0.0 harness validate --json',
    );
    expect(r.status).toBe(0);
  });

  it('on failure, prints the exit code and the JSON result, and stays red', () => {
    const r = runStep('{"valid":false,"issues":["planted-violation"]}', 1);
    expect(r.status).toBe(1);
    expect(r.log).toMatch(/harness validate exited 1/);
    expect(r.log).toContain('planted-violation');
  });

  it('on failure with no output, says so instead of printing nothing', () => {
    const r = runStep('', 1);
    expect(r.status).toBe(1);
    expect(r.log).toMatch(/harness validate exited 1/);
    expect(r.log).toMatch(/no JSON result/);
  });

  it('keeps a non-1 exit code (a crash is not rewritten as a violation)', () => {
    const r = runStep('', 134);
    expect(r.status).toBe(134);
    expect(r.log).toMatch(/harness validate exited 134/);
  });
});
