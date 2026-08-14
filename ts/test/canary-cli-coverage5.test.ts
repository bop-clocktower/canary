/**
 * Fifth coverage pass -- the skills-run `.py` cli branch (python interpreter
 * dispatch) and workflow-discover reading project keys from company.json when
 * no --project is given.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { defaultAnalyzeDeps } from '../src/analysis/cli.js';
import { LocalAsyncAdapter } from '../src/history/store.js';
import { SupabaseHistoryStore } from '../src/history/supabase-store.js';
import { invokeCanary, mkTmp, rmTmp } from './canary-cli-testkit.js';

function fake<T>(obj: unknown): T {
  return obj as T;
}

// Regression tests for adversarial-review fidelity fixes on the main CLI port.
describe('CLI fidelity fixes (adversarial review)', () => {
  // #1: Python typer(no_args_is_help=True) prints help and exits 2 on a bare
  // invocation -- a usage exit, NOT 0.
  it('bare `canary` exits 2 (no_args_is_help)', async () => {
    const res = await invokeCanary([]);
    expect(res.code).toBe(2);
  });

  // #7: a skills-run cli spawn FAILURE (missing interpreter -> status null) must
  // exit 1 like Python's FileNotFoundError, not a silent 0.
  it('skills run maps a cli spawn failure to exit 1, not 0', async () => {
    const tmp = mkTmp();
    try {
      writeFileSync(join(tmp, 'run.py'), 'print(1)\n', 'utf-8');
      const skill = {
        error: null,
        isExecutable: true,
        cli: 'run.py',
        entry: null,
        name: 'e',
        dir: tmp,
      };
      const res = await invokeCanary(
        ['skills', 'run', 'e', '--allow-executable-skills'],
        {
          deps: {
            makeSkillRegistry: () => fake({ find: () => skill }),
            pythonExe: () => 'python3',
            // spawn failure: no status
            runSubprocess: () => ({ status: null, stdout: '', stderr: '' }),
          },
        },
      );
      expect(res.code).toBe(1);
    } finally {
      rmTmp(tmp);
    }
  });

  // #3: analyze's production makeStore used to IGNORE --db-url (the engine held
  // the synchronous store contract) and warn to stderr so the divergence was at
  // least not silent. #711 made the engine async, so the flag is honoured for
  // real -- the warning is gone because the thing it apologised for is gone.
  it('analyze makeStore honours --db-url instead of warning about it', () => {
    const priorKey = process.env.SUPABASE_ANON_KEY;
    // Savant only collects framework teardown hooks as restore regions, so the
    // in-test try/finally restore below is not recognised as one (#733).
    // savant-ignore SV003 -- the finally restores or deletes this exact key
    process.env.SUPABASE_ANON_KEY = 'test-anon-key';
    const writes: string[] = [];
    const spy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((s: string | Uint8Array): boolean => {
        writes.push(String(s));
        return true;
      });
    try {
      const store = defaultAnalyzeDeps().makeStore('https://proj.supabase.co');
      expect(store).toBeInstanceOf(SupabaseHistoryStore);
    } finally {
      spy.mockRestore();
      if (priorKey === undefined) delete process.env.SUPABASE_ANON_KEY;
      else process.env.SUPABASE_ANON_KEY = priorKey;
    }
    expect(writes.join('')).not.toContain('--db-url is ignored');
  });

  it('analyze makeStore still defaults to the local store with no db-url', () => {
    const priorUrl = process.env.CANARY_HISTORY_DB_URL;
    delete process.env.CANARY_HISTORY_DB_URL;
    try {
      expect(defaultAnalyzeDeps().makeStore()).toBeInstanceOf(
        LocalAsyncAdapter,
      );
    } finally {
      if (priorUrl !== undefined) process.env.CANARY_HISTORY_DB_URL = priorUrl;
    }
  });
});

describe('skills run: python cli target', () => {
  it('dispatches a .py target through the python interpreter', async () => {
    const tmp = mkTmp();
    try {
      const cli = join(tmp, 'run.py');
      writeFileSync(cli, 'print("hi")\n', 'utf-8');
      const skill = {
        error: null,
        isExecutable: true,
        cli: 'run.py',
        entry: null,
        name: 'e',
        dir: tmp,
      };
      const seen: string[][] = [];
      const res = await invokeCanary(
        ['skills', 'run', 'e', 'arg1', '--allow-executable-skills'],
        {
          deps: {
            makeSkillRegistry: () => fake({ find: () => skill }),
            pythonExe: () => 'python3',
            runSubprocess: (cmd: string, args: string[]) => {
              seen.push([cmd, ...args]);
              return { status: 0, stdout: '', stderr: '' };
            },
          },
        },
      );
      expect(res.code).toBe(0);
      expect(seen[0]![0]).toBe('python3');
      expect(seen[0]!).toContain('arg1');
    } finally {
      rmTmp(tmp);
    }
  });
});

describe('help output exits 0 (helpDisplayed, not a usage error)', () => {
  it('--help on the program exits 0', async () => {
    const res = await invokeCanary(['--help']);
    expect(res.code).toBe(0);
  });

  it('--help on a subcommand exits 0', async () => {
    const res = await invokeCanary(['recommend', '--help']);
    expect(res.code).toBe(0);
  });
});

describe('workflow discover: keys from company.json', () => {
  it('reads jira_projects when no --project is given', async () => {
    const tmp = mkTmp();
    try {
      mkdirSync(join(tmp, '.canary'));
      writeFileSync(
        join(tmp, '.canary', 'company.json'),
        JSON.stringify({ jira_projects: ['ACME'] }),
        'utf-8',
      );
      const mapping = {
        issue_types: ['Story'],
        semantic_roles: {},
        role_annotations_confirmed: true,
        toJson: () => '{}',
      };
      const res = await invokeCanary(['workflow', 'discover'], {
        cwd: tmp,
        deps: {
          makeWorkflowDiscovery: () => fake({ discover: async () => mapping }),
        },
      });
      expect(res.code).toBe(0);
      expect(res.stdout).toContain('ACME');
    } finally {
      rmTmp(tmp);
    }
  });
});
