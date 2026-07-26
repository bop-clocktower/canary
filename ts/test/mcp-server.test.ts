/**
 * Tests for the `mcp-server` port (`agent/mcp_server.py`,
 * `tests/unit/test_mcp_server.py` + `tests/unit/test_mcp_tool_registration.py`).
 *
 * Every Python case is preserved. The `_impl` functions are tested directly
 * with the same inputs/outputs the Python tests assert (no live MCP client
 * needed), exactly as the Python suite does. Dependencies the Python tests
 * `patch` (`Scaffolder.scaffold`, `CanaryTestExecutor.execute`,
 * `HarnessMigrator.detect/migrate`) are stubbed here with `vi.spyOn` on the
 * prototype, since the impls instantiate their own collaborators just like the
 * Python originals. The AST-free `file_functions` extraction gets extra
 * byte-exact ordering coverage against the `ast.walk` oracle.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DomainScanner } from '../src/core/domain-scanner.js';
import { CanaryTestExecutor } from '../src/core/executor.js';
import { FrameworkRegistry } from '../src/core/framework-registry.js';
import {
  HarnessMigrator,
  MigrationContext,
  MigrationReport,
} from '../src/core/migrator.js';
import { PatternMatcher } from '../src/core/pattern-matcher.js';
import { Scaffolder } from '../src/core/scaffolder.js';
import {
  analyzeFileImpl,
  analyzeFileTool,
  CANARY_TOOL_NAMES,
  createServer,
  extractFileFunctions,
  initSuiteImpl,
  initSuiteTool,
  listFrameworksImpl,
  listFrameworksTool,
  migrateImpl,
  migrateTool,
  runStdio,
  runTestsImpl,
  runTestsTool,
  writeTestFileImpl,
  writeTestFileTool,
} from '../src/mcp-server.js';

const roots: string[] = [];
function mkroot(): string {
  const r = mkdtempSync(join(tmpdir(), 'canary-mcp-'));
  roots.push(r);
  return r;
}
function gitRoot(): string {
  const r = mkroot();
  mkdirSync(join(r, '.git'));
  return r;
}

afterEach(() => {
  vi.restoreAllMocks();
  while (roots.length) {
    const r = roots.pop()!;
    rmSync(r, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// analyzeFileImpl
// ---------------------------------------------------------------------------

describe('analyzeFileImpl', () => {
  it('returns the expected keys when the file exists', () => {
    const root = gitRoot();
    const target = join(root, 'login.ts');
    writeFileSync(target, 'export function login() {}');
    // Mirror the Python mocks so the assertion is about shape, not scanners.
    vi.spyOn(PatternMatcher.prototype, 'scan').mockReturnValue({
      test_count: 0,
      language: '',
      naming_style: '',
      assertion_style: '',
      uses_classes: false,
      uses_fixtures: false,
      uses_describe: false,
      common_imports: ['react'],
      sample_names: [],
    });
    vi.spyOn(DomainScanner.prototype, 'scan').mockReturnValue({
      sourceFiles: 1,
      modules: [],
      components: [],
      functions: ['login'],
      apiRoutes: [],
    });

    const result = analyzeFileImpl(target);
    expect(['playwright', 'vitest', 'pytest', 'k6', 'unknown']).toContain(
      result['framework'],
    );
    expect(result).toHaveProperty('imports');
    expect(result).toHaveProperty('functions');
    expect(result).toHaveProperty('existing_tests');
    expect(result).toHaveProperty('context_snippets');
    expect(result['imports']).toEqual(['react']);
    expect(result['functions']).toEqual(['login']);
  });

  it('returns an error dict when the file does not exist', () => {
    const result = analyzeFileImpl('/nonexistent/path/foo.ts');
    expect(result).toHaveProperty('error');
    expect(String(result['error'])).toContain('file not found');
  });

  it('reports framework_source=config from a config file', () => {
    const root = gitRoot();
    writeFileSync(join(root, 'playwright.config.ts'), 'export default {};');
    const target = join(root, 'login.spec.ts');
    writeFileSync(target, "import { test } from '@playwright/test';\n");
    const result = analyzeFileImpl(target);
    expect(result['framework']).toBe('playwright');
    expect(result['framework_source']).toBe('config');
    expect(result['test_type']).toBe('e2e');
  });

  it('wires in #341 environment/persona detection', () => {
    const root = gitRoot();
    writeFileSync(join(root, '.env'), 'BASE_URL=https://app.example.com\n');
    writeFileSync(
      join(root, 'playwright.config.ts'),
      "export default { testDir: './tests/e2e' };\n",
    );
    const target = join(root, 'tests', 'e2e', 'login.spec.ts');
    mkdirSync(join(root, 'tests', 'e2e'), { recursive: true });
    writeFileSync(target, "import { test } from '@playwright/test';\n");
    const result = analyzeFileImpl(target);
    const env = result['environment'] as Record<string, unknown>;
    expect(env['base_url']).toBe('https://app.example.com');
    expect(env['suite_type']).toBe('e2e');
    expect(env['user_level']).toBe('sdet');
  });

  it('falls back to framework_source=suffix without a config file', () => {
    const root = gitRoot();
    const target = join(root, 'tests', 'test_x.py');
    mkdirSync(join(root, 'tests'));
    writeFileSync(target, 'def test_thing(): pass\n');
    const result = analyzeFileImpl(target);
    expect(result['framework_source']).toBe('suffix');
    expect(result['framework']).toBe('pytest');
  });

  it('extracts top-level and class-level defs from Python', () => {
    const root = gitRoot();
    const target = join(root, 'mod.py');
    writeFileSync(
      target,
      'def foo():\n    pass\n\n' +
        'async def bar():\n    pass\n\n' +
        'class C:\n    def baz(self):\n        pass\n',
    );
    const result = analyzeFileImpl(target);
    expect(new Set(result['file_functions'] as string[])).toEqual(
      new Set(['foo', 'bar', 'baz']),
    );
    // ast.walk BFS order: top-level defs before the class method.
    expect(result['file_functions']).toEqual(['foo', 'bar', 'baz']);
  });

  it('extracts function and const-arrow definitions from TS', () => {
    const root = gitRoot();
    const target = join(root, 'mod.ts');
    writeFileSync(
      target,
      'export function alpha() {}\n' +
        'async function beta() {}\n' +
        'export const gamma = () => {};\n' +
        'const delta = async (x: number) => x;\n',
    );
    const result = analyzeFileImpl(target);
    expect(new Set(result['file_functions'] as string[])).toEqual(
      new Set(['alpha', 'beta', 'gamma', 'delta']),
    );
    // Functions first (source order), then const-arrows (source order).
    expect(result['file_functions']).toEqual([
      'alpha',
      'beta',
      'gamma',
      'delta',
    ]);
  });

  it('returns relative paths to discovered existing tests', () => {
    const root = gitRoot();
    mkdirSync(join(root, 'tests'));
    writeFileSync(join(root, 'tests', 'test_one.py'), 'def test_a(): pass');
    writeFileSync(join(root, 'tests', 'test_two.py'), 'def test_b(): pass');
    const target = join(root, 'src', 'thing.py');
    mkdirSync(join(root, 'src'));
    writeFileSync(target, 'def thing(): pass');
    const result = analyzeFileImpl(target);
    const existing = result['existing_tests'] as string[];
    expect(existing).toHaveLength(2);
    expect(existing.every((p) => p.includes('test_'))).toBe(true);
  });

  it('returns empty context_snippets for an empty file', () => {
    const root = gitRoot();
    const target = join(root, 'empty.ts');
    writeFileSync(target, '');
    const result = analyzeFileImpl(target);
    expect(result['context_snippets']).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// extractFileFunctions - AST-free extraction edge cases
// ---------------------------------------------------------------------------

describe('extractFileFunctions', () => {
  it('reproduces ast.walk order for nested then top-level defs', () => {
    const root = mkroot();
    const p = join(root, 'nested.py');
    writeFileSync(
      p,
      'def a():\n    def a_inner():\n        pass\ndef b():\n    pass\n',
    );
    // BFS: both top-level defs before the nested one.
    expect(extractFileFunctions(p)).toEqual(['a', 'b', 'a_inner']);
  });

  it('ignores a def that appears inside a docstring', () => {
    const root = mkroot();
    const p = join(root, 'doc.py');
    writeFileSync(
      p,
      '"""\ndef fake_in_docstring():\n    pass\n"""\ndef real():\n    pass\n',
    );
    expect(extractFileFunctions(p)).toEqual(['real']);
  });

  it('ignores a def in a trailing comment', () => {
    const root = mkroot();
    const p = join(root, 'cmt.py');
    writeFileSync(p, 'x = 1  # def not_a_func():\ndef actual():\n    pass\n');
    expect(extractFileFunctions(p)).toEqual(['actual']);
  });

  it('dedupes repeated names preserving first occurrence', () => {
    const root = mkroot();
    const p = join(root, 'dupe.py');
    writeFileSync(p, 'def dup():\n    pass\ndef dup():\n    pass\n');
    expect(extractFileFunctions(p)).toEqual(['dup']);
  });

  it('returns an empty list for an unknown extension', () => {
    const root = mkroot();
    const p = join(root, 'notes.txt');
    writeFileSync(p, 'def foo(): pass');
    expect(extractFileFunctions(p)).toEqual([]);
  });

  it('returns an empty list for a missing file', () => {
    expect(extractFileFunctions('/does/not/exist.py')).toEqual([]);
  });

  // Regression (adversarial review #1): a syntactically-invalid Python file
  // (unclosed paren, a common mid-edit state) is unparseable, so Python's
  // ast.parse raises SyntaxError and _extract_file_functions returns []. The
  // bracket-balance gate reproduces that instead of emitting best-effort names.
  it('returns [] for an unparseable Python file (unbalanced brackets)', () => {
    const root = mkroot();
    const p = join(root, 'broken.py');
    writeFileSync(p, 'def ok():\n    pass\ndef broken(:\n    pass\n');
    expect(extractFileFunctions(p)).toEqual([]);
  });

  // Regression (adversarial review #3): a backslash-continued def header is one
  // logical line in Python; join it so the name is still extracted.
  it('extracts a name from a backslash-continued def header', () => {
    const root = mkroot();
    const p = join(root, 'cont.py');
    writeFileSync(p, 'def \\\nfoo():\n    pass\n');
    expect(extractFileFunctions(p)).toEqual(['foo']);
  });
});

// ---------------------------------------------------------------------------
// listFrameworksImpl
// ---------------------------------------------------------------------------

describe('listFrameworksImpl', () => {
  it('surfaces exactly the registry framework names', () => {
    const result = listFrameworksImpl();
    const names = new Set(result['frameworks'] as string[]);
    const expected = new Set(
      new FrameworkRegistry().getAllFrameworks().map((f) => f.name),
    );
    expect(names).toEqual(expected);
    // Core four must always be present.
    for (const core of ['playwright', 'vitest', 'pytest', 'k6']) {
      expect(names.has(core)).toBe(true);
    }
    expect(result).toHaveProperty('details');
  });
});

// ---------------------------------------------------------------------------
// writeTestFileImpl
// ---------------------------------------------------------------------------

describe('writeTestFileImpl', () => {
  it('creates parent dirs and writes file, returning written_path', () => {
    const root = mkroot();
    const deep = join(root, 'nested', 'dir', 'my_test.spec.ts');
    const result = writeTestFileImpl(deep, '// test content', 'playwright');
    expect(result['written_path']).toBe(deep);
    expect(existsSync(deep)).toBe(true);
    expect(readFileSync(deep, 'utf-8')).toBe('// test content');
  });

  it('infers a .spec.ts extension for playwright when none is given', () => {
    const root = mkroot();
    const noExt = join(root, 'my_test');
    const result = writeTestFileImpl(noExt, 'content', 'playwright');
    expect(String(result['written_path']).endsWith('.spec.ts')).toBe(true);
  });

  it('infers a .py extension for pytest', () => {
    const root = mkroot();
    const result = writeTestFileImpl(join(root, 'my_test'), 'x', 'pytest');
    expect(String(result['written_path']).endsWith('.py')).toBe(true);
  });

  it('falls back to .ts for an unknown framework', () => {
    const root = mkroot();
    const result = writeTestFileImpl(join(root, 'my_test'), 'x', 'mystery');
    expect(String(result['written_path']).endsWith('.ts')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// runTestsImpl
// ---------------------------------------------------------------------------

describe('runTestsImpl', () => {
  it('returns exit_code=0 and a positive passed count on success', () => {
    vi.spyOn(CanaryTestExecutor.prototype, 'execute').mockReturnValue([
      0,
      '1 passed in 0.01s',
      '',
    ]);
    const result = runTestsImpl('/tmp/test_ok.py');
    expect(result['exit_code']).toBe(0);
    expect(result['failed']).toBe(0);
    expect(result['passed'] as number).toBeGreaterThan(0);
  });

  it('returns exit_code=1 without raising on failure', () => {
    vi.spyOn(CanaryTestExecutor.prototype, 'execute').mockReturnValue([
      1,
      '',
      'AssertionError',
    ]);
    const result = runTestsImpl('/tmp/test_bad.py');
    expect(result['exit_code']).toBe(1);
    expect(result['failed']).toBe(1);
  });

  it('converts an executor exception into a degraded result', () => {
    vi.spyOn(CanaryTestExecutor.prototype, 'execute').mockImplementation(() => {
      throw new Error('boom');
    });
    const result = runTestsImpl('/tmp/test_x.spec.ts');
    expect(result).toEqual({
      passed: 0,
      failed: 0,
      output: 'boom',
      exit_code: 1,
    });
  });

  it('renders a non-Error throw via String()', () => {
    vi.spyOn(CanaryTestExecutor.prototype, 'execute').mockImplementation(() => {
      throw 'stringy';
    });
    const result = runTestsImpl('/tmp/test_x.spec.ts');
    expect(result['output']).toBe('stringy');
    expect(result['exit_code']).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// initSuiteImpl
// ---------------------------------------------------------------------------

describe('initSuiteImpl', () => {
  it('returns the framework and the created scaffold items', () => {
    vi.spyOn(Scaffolder.prototype, 'scaffold').mockReturnValue({
      created_files: ['playwright.config.ts'],
      created_dirs: ['tests/e2e'],
      skipped_files: [],
    });
    const result = initSuiteImpl('playwright', '/some/dir');
    expect(result['framework']).toBe('playwright');
    expect(result['status']).toBe('scaffolded');
    expect(result['files_created']).toEqual([
      'playwright.config.ts',
      'tests/e2e',
    ]);
  });

  it('surfaces guidance on the unsupported degrade path', () => {
    const root = mkroot();
    // schemathesis is a real registry framework with no scaffold template.
    const result = initSuiteImpl('schemathesis', root);
    expect(result['status']).toBe('unsupported');
    expect(result['guidance']).toBeTruthy();
    expect(String(result['execution_command'])).toContain('schemathesis');
  });
});

// ---------------------------------------------------------------------------
// migrateImpl
// ---------------------------------------------------------------------------

function ctx(
  isHarness: boolean,
  notTestReason: string | null = null,
): MigrationContext {
  return new MigrationContext({
    project_root: '/dir',
    is_harness_project: isHarness,
    not_test_project_reason: notTestReason,
  });
}

describe('migrateImpl', () => {
  it('dry-run returns a plan with dry_run=true and no files_created', () => {
    vi.spyOn(HarnessMigrator.prototype, 'detect').mockReturnValue(ctx(true));
    vi.spyOn(HarnessMigrator.prototype, 'migrate').mockReturnValue(
      new MigrationReport({
        framework: 'playwright',
        shape: 'e2e-ui',
        dry_run: true,
        manual_followups: ['Remove harness.config.json'],
      }),
    );
    const result = migrateImpl('/dir', false);
    expect(result['dry_run']).toBe(true);
    expect(result['files_created']).toEqual([]);
    expect(result['manual_followups']).toEqual(['Remove harness.config.json']);
  });

  it('apply=true returns dry_run=false and populated files_created', () => {
    vi.spyOn(HarnessMigrator.prototype, 'detect').mockReturnValue(ctx(true));
    vi.spyOn(HarnessMigrator.prototype, 'migrate').mockReturnValue(
      new MigrationReport({
        framework: 'playwright',
        shape: 'e2e-ui',
        dry_run: false,
        created_files: ['playwright.config.ts'],
        created_dirs: ['tests/e2e'],
        skipped_configs: [],
        manual_followups: [],
      }),
    );
    const result = migrateImpl('/dir', true);
    expect(result['dry_run']).toBe(false);
    expect(result['files_created']).toEqual([
      'playwright.config.ts',
      'tests/e2e',
    ]);
  });

  it('returns an error dict when no harness markers are found', () => {
    vi.spyOn(HarnessMigrator.prototype, 'detect').mockReturnValue(ctx(false));
    const result = migrateImpl('/dir', false);
    expect(result).toHaveProperty('error');
    expect(String(result['error'])).toContain('no harness.config.json');
  });

  it('surfaces the not-a-test-project reason when present', () => {
    vi.spyOn(HarnessMigrator.prototype, 'detect').mockReturnValue(
      ctx(false, 'skills overlay, not a test project'),
    );
    const result = migrateImpl('/dir', false);
    expect(result['error']).toBe('skills overlay, not a test project');
  });
});

// ---------------------------------------------------------------------------
// Tool registration + wrapper delegation (test_mcp_tool_registration.py)
// ---------------------------------------------------------------------------

const HARNESS_TOOL_NAMES = new Set([
  'run_ci_checks',
  'acceptance_eval',
  'outcome_eval',
  'review_changes',
  'run_skill',
  'search_skills',
  'manage_roadmap',
  'detect_drift',
  'code_search',
  'ask_graph',
  'run_security_scan',
  'check_docs',
]);

describe('tool registration', () => {
  it('registers exactly the six canary tools', () => {
    expect(new Set(CANARY_TOOL_NAMES)).toEqual(
      new Set([
        'canary__analyze_file',
        'canary__write_test_file',
        'canary__run_tests',
        'canary__init_suite',
        'canary__list_frameworks',
        'canary__migrate',
      ]),
    );
  });

  it('gives every tool the load-bearing canary__ prefix', () => {
    for (const name of CANARY_TOOL_NAMES) {
      expect(name.startsWith('canary__')).toBe(true);
    }
  });

  it('never collides with a bare harness tool name', () => {
    for (const name of CANARY_TOOL_NAMES) {
      expect(HARNESS_TOOL_NAMES.has(name)).toBe(false);
    }
  });

  it('builds an McpServer without throwing', () => {
    const server = createServer();
    expect(server).toBeInstanceOf(McpServer);
  });
});

describe('tool wrappers delegate to their impls', () => {
  it('analyze wrapper JSON-wraps the impl error dict', () => {
    const out = analyzeFileTool({ file_path: '/does/not/exist.ts' });
    expect(out.content[0]!.type).toBe('text');
    const parsed = JSON.parse(out.content[0]!.text);
    expect(parsed.error).toContain('file not found');
  });

  it('write wrapper forwards all three args', () => {
    const root = mkroot();
    const out = writeTestFileTool({
      file_path: join(root, 'x'),
      content: 'body',
      framework: 'pytest',
    });
    const parsed = JSON.parse(out.content[0]!.text);
    expect(String(parsed.written_path).endsWith('.py')).toBe(true);
  });

  it('run wrapper wraps the impl result', () => {
    vi.spyOn(CanaryTestExecutor.prototype, 'execute').mockReturnValue([
      0,
      '2 passed',
      '',
    ]);
    const parsed = JSON.parse(
      runTestsTool({ test_file: '/t/x.py' }).content[0]!.text,
    );
    expect(parsed.exit_code).toBe(0);
  });

  it('init wrapper wraps the scaffold result', () => {
    vi.spyOn(Scaffolder.prototype, 'scaffold').mockReturnValue({
      created_files: ['pytest.ini'],
      created_dirs: ['tests'],
      skipped_files: [],
    });
    const parsed = JSON.parse(
      initSuiteTool({ framework: 'pytest', target_dir: '/dir' }).content[0]!
        .text,
    );
    expect(parsed.framework).toBe('pytest');
    expect(parsed.files_created).toEqual(['pytest.ini', 'tests']);
  });

  it('list wrapper wraps the registry names', () => {
    const parsed = JSON.parse(listFrameworksTool().content[0]!.text);
    expect(parsed.frameworks).toContain('playwright');
  });

  it('migrate wrapper forwards target_dir and apply', () => {
    vi.spyOn(HarnessMigrator.prototype, 'detect').mockReturnValue(ctx(false));
    const parsed = JSON.parse(
      migrateTool({ target_dir: '/dir', apply: true }).content[0]!.text,
    );
    expect(parsed.error).toContain('no harness.config.json');
  });
});

describe('runStdio', () => {
  it('connects the server over a stdio transport', async () => {
    const connect = vi
      .spyOn(McpServer.prototype, 'connect')
      .mockResolvedValue(undefined);
    await runStdio();
    expect(connect).toHaveBeenCalledOnce();
  });
});
