/**
 * CliRunner-parity tests for the main `canary` command -- ports of
 * `tests/unit/test_cli_version.py` and `tests/unit/test_cli_commands.py`
 * (the `run`, `skills run`, `ticket-update`, `workflow discover`, `init`/`setup`
 * surfaces), preserving each case's exit code and key output assertions.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { invokeCanary, mkTmp, rmTmp } from './canary-cli-testkit.js';

/** Cast a partial fake to the nominal factory return type. */
function fake<T>(obj: unknown): T {
  return obj as T;
}

describe('canary version', () => {
  it('reports the installed package version, not a hardcoded string', async () => {
    const res = await invokeCanary(['version'], {
      deps: { pkgVersion: () => '5.12.0' },
    });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('canary');
    expect(res.stdout).not.toContain('v0.1 (MVP)');
  });

  it("prints 'unknown' when the package metadata is missing", async () => {
    const res = await invokeCanary(['version'], {
      deps: {
        pkgVersion: () => {
          throw new Error('PackageNotFound');
        },
      },
    });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('vunknown');
  });
});

describe('canary run', () => {
  it('reports a success exit', async () => {
    const res = await invokeCanary(['run', 'some_test.py', 'pytest'], {
      deps: {
        makeExecutor: () => fake({ execute: () => [0, '1 passed', ''] }),
      },
    });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('Success');
  });

  it('reports a failure with stderr, without crashing', async () => {
    const res = await invokeCanary(['run', 'some_test.py', 'pytest'], {
      deps: {
        makeExecutor: () => fake({ execute: () => [1, '', 'boom traceback'] }),
      },
    });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('Failure');
    expect(res.stdout).toContain('boom traceback');
  });
});

describe('canary skills run', () => {
  it('exits 1 for a missing skill', async () => {
    const res = await invokeCanary(['skills', 'run', 'no-such-skill'], {
      deps: { makeSkillRegistry: () => fake({ find: () => null }) },
    });
    expect(res.code).toBe(1);
    expect(res.stdout).toContain('no-such-skill');
  });

  it('exits 2 for a skill with a validation error', async () => {
    const skill = {
      error: 'both cli and entry declared',
      isExecutable: true,
      cli: null,
      entry: null,
      name: 'broken',
      dir: '.',
    };
    const res = await invokeCanary(['skills', 'run', 'broken'], {
      deps: { makeSkillRegistry: () => fake({ find: () => skill }) },
    });
    expect(res.code).toBe(2);
    expect(res.stdout).toContain('both cli and entry');
  });

  it('exits 2 for a markdown-only skill', async () => {
    const skill = {
      error: null,
      isExecutable: false,
      cli: null,
      entry: null,
      name: 'doc-skill',
      dir: '.',
    };
    const res = await invokeCanary(['skills', 'run', 'doc-skill'], {
      deps: { makeSkillRegistry: () => fake({ find: () => skill }) },
    });
    expect(res.code).toBe(2);
    expect(res.stdout).toContain('markdown-only');
  });
});

describe('canary ticket-update', () => {
  it('exits 1 on malformed result JSON', async () => {
    const tmp = mkTmp();
    try {
      const bad = join(tmp, 'report.json');
      writeFileSync(bad, '{not valid json', 'utf-8');
      const res = await invokeCanary(['ticket-update', '--result', bad]);
      expect(res.code).toBe(1);
      expect(res.stdout).toContain('Could not read result file');
    } finally {
      rmTmp(tmp);
    }
  });

  it('exits 1 on a missing result file', async () => {
    const tmp = mkTmp();
    try {
      const missing = join(tmp, 'nope.json');
      const res = await invokeCanary(['ticket-update', '--result', missing]);
      expect(res.code).toBe(1);
      expect(res.stdout).toContain('Could not read result file');
    } finally {
      rmTmp(tmp);
    }
  });
});

describe('canary workflow discover', () => {
  it('exits 1 with no project and no company.json', async () => {
    const tmp = mkTmp();
    try {
      const res = await invokeCanary(['workflow', 'discover'], { cwd: tmp });
      expect(res.code).toBe(1);
      expect(res.stdout).toContain('No project keys found');
    } finally {
      rmTmp(tmp);
    }
  });

  it('exits 1 when company.json is malformed (no keys)', async () => {
    const tmp = mkTmp();
    try {
      mkdirSync(join(tmp, '.canary'));
      writeFileSync(join(tmp, '.canary', 'company.json'), '{broken', 'utf-8');
      const res = await invokeCanary(['workflow', 'discover'], { cwd: tmp });
      expect(res.code).toBe(1);
      expect(res.stdout).toContain('No project keys found');
    } finally {
      rmTmp(tmp);
    }
  });

  it('succeeds for an explicit project (dry-run)', async () => {
    const mapping = {
      issue_types: ['Bug', 'Story'],
      semantic_roles: { in_progress: 'In Progress' },
      role_annotations_confirmed: true,
      toJson: () => '{"key": "ACME"}',
    };
    const res = await invokeCanary(
      ['workflow', 'discover', '--project', 'ACME', '--dry-run'],
      {
        deps: {
          makeWorkflowDiscovery: () => fake({ discover: async () => mapping }),
        },
      },
    );
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('ACME');
  });
});

describe('canary init / setup UX', () => {
  it('bare init signposts instead of erroring', async () => {
    const tmp = mkTmp();
    try {
      const res = await invokeCanary(['init'], { cwd: tmp });
      expect(res.code).toBe(0);
      expect(res.stdout).toContain('canary setup');
      expect(res.stdout).toContain('canary init <framework>');
    } finally {
      rmTmp(tmp);
    }
  });

  it('bare init warns when company.json is absent', async () => {
    const tmp = mkTmp();
    try {
      const res = await invokeCanary(['init'], { cwd: tmp });
      expect(res.stdout).toContain('company.json');
      expect(res.stdout).toContain('degraded');
    } finally {
      rmTmp(tmp);
    }
  });

  it('bare init omits the warning when configured', async () => {
    const tmp = mkTmp();
    try {
      mkdirSync(join(tmp, '.canary'));
      writeFileSync(join(tmp, '.canary', 'company.json'), '{}', 'utf-8');
      const res = await invokeCanary(['init'], { cwd: tmp });
      expect(res.code).toBe(0);
      expect(res.stdout).toContain('canary setup');
      expect(res.stdout).not.toContain('degraded');
    } finally {
      rmTmp(tmp);
    }
  });

  it('init with a framework still scaffolds', async () => {
    const scaffold = vi.fn(() => ({
      created_dirs: ['tests/'],
      created_files: ['tests/example.spec.ts'],
      skipped_files: [],
    }));
    const res = await invokeCanary(['init', 'playwright'], {
      deps: { makeScaffolder: () => fake({ scaffold }) },
    });
    expect(res.code).toBe(0);
    expect(scaffold).toHaveBeenCalledWith('playwright');
    expect(res.stdout).toContain('Scaffolding Complete');
  });

  it('setup aliases company-knowledge init (writes company.json)', async () => {
    const tmp = mkTmp();
    try {
      const res = await invokeCanary(['setup'], { cwd: tmp });
      expect(res.code).toBe(0);
      expect(res.stdout).toContain('Written to');
      expect(existsSync(join(tmp, '.canary', 'company.json'))).toBe(true);
    } finally {
      rmTmp(tmp);
    }
  });

  it('setup forwards --force', async () => {
    const tmp = mkTmp();
    try {
      mkdirSync(join(tmp, '.canary'));
      writeFileSync(join(tmp, '.canary', 'company.json'), '{}', 'utf-8');
      const res = await invokeCanary(['setup', '--force'], { cwd: tmp });
      expect(res.code).toBe(0);
      expect(res.stdout).toContain('Written to');
    } finally {
      rmTmp(tmp);
    }
  });
});
