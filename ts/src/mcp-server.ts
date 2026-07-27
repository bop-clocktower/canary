/**
 * Canary MCP server - exposes Canary intelligence tools to Claude Code.
 *
 * Faithful TypeScript port of `agent/mcp_server.py`. The Python original builds
 * a `FastMCP("canary")` server and registers six `canary__*` tools; this port
 * uses the official MCP TypeScript SDK (`@modelcontextprotocol/sdk`) with
 * `McpServer.registerTool` over a stdio transport.
 *
 * The internal implementation functions (`analyzeFileImpl`, ...) mirror the
 * Python `_*_impl` functions one-for-one and are exported so unit tests can
 * exercise them directly without a live MCP client - exactly as the Python
 * tests call the `_impl` functions. The thin tool wrappers only JSON-wrap the
 * dict the impl returns; the returned dict SHAPE (field names + values) is the
 * MCP contract and is preserved byte-for-byte with the Python oracle.
 *
 * Python->TS nuances:
 *   - **AST-free function extraction.** Python `_extract_file_functions`
 *     `ast.walk`s a parsed module; there is no Python `ast` in TS, so
 *     {@link extractFileFunctions} reproduces the SAME name list via a careful
 *     source scan. For `.py` it blanks strings/comments (so a `def` inside a
 *     docstring never matches), collects `def`/`async def` names with their
 *     indentation depth and source order, then stable-sorts by
 *     `(indent, order)` - which reproduces `ast.walk`'s breadth-first ordering
 *     for `FunctionDef` nodes (top-level before nested, siblings in source
 *     order). For `.ts/.js` it applies the same two regexes as the Python
 *     original, functions first then const-arrows. A genuinely unparseable
 *     Python file yields best-effort names here rather than Python's `[]`
 *     (ast SyntaxError) - the documented cost of having no real parser.
 *   - **subprocess.** `_run_tests_impl` delegates to the already-ported
 *     {@link CanaryTestExecutor} (spawnSync, maxBuffer:Infinity).
 *   - **pathlib -> node:path/fs.** `Path(...).suffix` semantics are reproduced
 *     by {@link pySuffix} (empty for a trailing dot or dotfile).
 *   - **Python truthiness.** `target_dir or _WORKING_DIR` uses `||`; the env
 *     default for `_WORKING_DIR` uses `??` to mirror `os.environ.get(k, cwd)`
 *     (an explicitly-empty env var stays `""`).
 *   - **ensure_ascii.** Hand-built JSON returned to the MCP host is escaped via
 *     {@link ensureAscii} (the reporter.ts pattern) so non-ASCII code points
 *     emit `\uXXXX`, matching Python's default `json.dumps`.
 *   - **splitlines.** `context_snippets` uses {@link pySplitlines}, which drops
 *     a single trailing-newline empty tail exactly as `str.splitlines()` does.
 *   - File writes are LF + UTF-8 on every platform (matches the sibling ports).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod';

import { DomainScanner } from './core/domain-scanner.js';
import { detectEnvironment } from './core/environment-detect.js';
import { CanaryTestExecutor } from './core/executor.js';
import { FrameworkRegistry } from './core/framework-registry.js';
import { HarnessMigrator } from './core/migrator.js';
import { findTestFiles, PatternMatcher } from './core/pattern-matcher.js';
import { Scaffolder } from './core/scaffolder.js';

// ---------------------------------------------------------------------------
// Module constants (mirror agent/mcp_server.py)
// ---------------------------------------------------------------------------

const SERVER_NAME = 'canary';
const SERVER_VERSION = '0.1.0';

/**
 * Python: `_WORKING_DIR = os.environ.get("CLAUDE_PLUGIN_ROOT", os.getcwd())`.
 * `??` (not `||`) mirrors `dict.get(key, default)`: an env var set to `""`
 * keeps `""`; only an unset var falls back to the cwd.
 */
const WORKING_DIR = process.env['CLAUDE_PLUGIN_ROOT'] ?? process.cwd();

const CONFIG_FRAMEWORK_GLOBS: readonly (readonly [
  string,
  readonly string[],
])[] = [
  [
    'playwright',
    [
      'playwright.config.ts',
      'playwright.config.js',
      'playwright.config.mts',
      'playwright.config.mjs',
    ],
  ],
  [
    'vitest',
    [
      'vitest.config.ts',
      'vitest.config.js',
      'vitest.config.mts',
      'vitest.config.mjs',
    ],
  ],
  ['pytest', ['pytest.ini', 'pyproject.toml']],
];

const SUFFIX_FRAMEWORK: Record<string, string> = {
  '.ts': 'playwright',
  '.tsx': 'playwright',
  '.js': 'playwright',
  '.jsx': 'playwright',
  '.mjs': 'playwright',
  '.py': 'pytest',
};

// Cap test-file path list size to keep response payload reasonable.
const MAX_EXISTING_TESTS = 10;
// Cap file-local function extraction so a giant file doesn't dominate.
const MAX_FILE_FUNCTIONS = 20;

// ---------------------------------------------------------------------------
// Python-compatibility helpers
// ---------------------------------------------------------------------------

/**
 * Reproduce Python's `json.dumps(..., ensure_ascii=True)` (the library default):
 * escape every code point >= 0x80 as `\uXXXX`. Copied per-module, matching the
 * reporter.ts / guardian pattern (the regex range is written with `\u....`
 * escapes so this source stays ASCII).
 */
function ensureAscii(json: string): string {
  return json.replace(
    /[\u0080-\uffff]/g,
    (ch) => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'),
  );
}

/**
 * Split like Python's `str.splitlines()` for the common line endings: splits on
 * `\r\n` / `\r` / `\n` and drops the single empty tail a trailing separator
 * would otherwise leave (so `"a\nb\n"` -> `["a", "b"]`, not `["a", "b", ""]`).
 */
function pySplitlines(text: string): string[] {
  if (text === '') return [];
  const parts = text.split(/\r\n|\r|\n/);
  if (parts[parts.length - 1] === '') parts.pop();
  return parts;
}

/**
 * Python `Path(name).suffix`: the last dotted extension, but empty when the dot
 * is the first character (`.gitignore`) or the last character (`foo.`).
 */
function pySuffix(name: string): string {
  const i = name.lastIndexOf('.');
  if (i > 0 && i < name.length - 1) return name.slice(i);
  return '';
}

/** Render a caught value the way Python's `str(e)` renders an exception. */
function errStr(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// ---------------------------------------------------------------------------
// Framework / project detection helpers (Python module-level functions)
// ---------------------------------------------------------------------------

/**
 * Return `[framework, source]` where source indicates trust level (Python:
 * `_detect_framework_from_config`). Walks up from `projectRoot` checking for
 * canonical config files. `source` is one of `"config"` (config file found) or
 * `"unknown"` (no signal). `pyproject.toml` only counts when it actually
 * configures pytest (`[tool.pytest` present).
 */
/**
 * Match a single directory's canonical config files (Python: the inner loop of
 * `_detect_framework_from_config`). Returns `[framework, "config"]` on the first
 * hit, or `null`. `pyproject.toml` only counts when it configures pytest.
 */
function configFrameworkAt(dir: string): [string, string] | null {
  for (const [fw, globs] of CONFIG_FRAMEWORK_GLOBS) {
    for (const name of globs) {
      const candidate = join(dir, name);
      if (!existsSync(candidate)) continue;
      if (name !== 'pyproject.toml') return [fw, 'config'];
      // Confirm pyproject.toml actually configures pytest; otherwise keep
      // looking - pyproject alone is not enough to claim pytest.
      let text: string;
      try {
        text = readFileSync(candidate, 'utf-8');
      } catch {
        continue;
      }
      if (text.includes('[tool.pytest')) return [fw, 'config'];
    }
  }
  return null;
}

export function detectFrameworkFromConfig(
  projectRoot: string,
): [string, string] {
  let cur = resolve(projectRoot);
  // Walk up to filesystem root or .git boundary.
  for (;;) {
    const hit = configFrameworkAt(cur);
    if (hit) return hit;
    if (existsSync(join(cur, '.git'))) break;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return ['unknown', 'unknown'];
}

/**
 * Walk up from `filePath` to the nearest `.git` directory, else return the
 * file's parent (Python: `_project_root_for`). The project boundary is the
 * `.git` root, matching `canary skills list` and the overlay loader.
 */
export function projectRootFor(filePath: string): string {
  const start = dirname(resolve(filePath));
  let cur = start;
  for (;;) {
    if (existsSync(join(cur, '.git'))) return cur;
    const parent = dirname(cur);
    if (parent === cur) return start;
    cur = parent;
  }
}

// ---------------------------------------------------------------------------
// File-local function extraction (Python: _extract_file_functions)
// ---------------------------------------------------------------------------

const TS_LIKE_SUFFIXES = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs']);

/**
 * Blank the interior of every Python string literal and comment, preserving
 * newlines and overall character positions. This neutralizes any `def ...` that
 * appears inside a docstring/string or after a `#`, so the line-based `def`
 * scan below only sees real statements - the guarantee Python's `ast` gives for
 * free. Line structure and indentation are untouched (code is copied verbatim),
 * so a matched `def` line keeps its true indentation depth.
 */
/** Blank a `#` comment through end-of-line. Returns the next scan index. */
function blankComment(src: string, start: number, out: string[]): number {
  let i = start;
  while (i < src.length && src[i] !== '\n') {
    out.push(' ');
    i++;
  }
  return i;
}

/** Blank one char, preserving a newline so line structure survives. */
function blankChar(ch: string, out: string[]): void {
  out.push(ch === '\n' ? '\n' : ' ');
}

/**
 * Blank a Python string literal starting at `start` (a quote char). Handles
 * single- and triple-quoted forms plus backslash escapes. Returns the index
 * just past the string (or end-of-input / newline for an unterminated
 * single-line string).
 */
function blankPyString(src: string, start: number, out: string[]): number {
  const q = src[start]!;
  const triple = src.substr(start, 3) === q + q + q;
  const delim = triple ? q + q + q : q;
  const dl = delim.length;
  const n = src.length;
  for (let k = 0; k < dl; k++) out.push(' ');
  let i = start + dl;
  while (i < n) {
    const c = src[i]!;
    if (c === '\\' && i + 1 < n) {
      blankChar(c, out);
      blankChar(src[i + 1]!, out);
      i += 2;
      continue;
    }
    if (!triple && c === '\n') break; // unterminated single-line string
    if (src.substr(i, dl) === delim) {
      for (let k = 0; k < dl; k++) out.push(' ');
      return i + dl;
    }
    blankChar(c, out);
    i++;
  }
  return i;
}

function blankPyStringsAndComments(src: string): string {
  const out: string[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i]!;
    if (c === '#') {
      i = blankComment(src, i, out);
    } else if (c === '"' || c === "'") {
      i = blankPyString(src, i, out);
    } else {
      out.push(c);
      i++;
    }
  }
  return out.join('');
}

const PY_DEF_RE = /^(\s*)(?:async\s+)?def\s+([A-Za-z_]\w*)/;

/**
 * True iff `()`, `[]`, `{}` are balanced across `s` (with string/comment interiors
 * already blanked). Valid Python always balances these outside strings, so an
 * imbalance means the file would raise `SyntaxError` -- where Python's `ast.parse`
 * returns no functions. A cheap proxy for "parseable": it never rejects valid
 * Python (so it introduces no divergence), and it catches the common WIP case
 * (a mid-edit unclosed paren) so we return `[]` like the oracle instead of
 * best-effort names. It does NOT catch every SyntaxError; see the note below.
 */
function pyBracketsBalanced(s: string): boolean {
  const close: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
  const stack: string[] = [];
  for (const ch of s) {
    if (ch === '(' || ch === '[' || ch === '{') stack.push(ch);
    else if (ch === ')' || ch === ']' || ch === '}') {
      if (stack.pop() !== close[ch]) return false;
    }
  }
  return stack.length === 0;
}

/**
 * Collect Python `def`/`async def` names approximating `ast.walk` order via a
 * stable sort of `(indentDepth, sourceOrder)`: a top-level def sorts before a
 * method/nested def, and same-indent defs keep source order. This reproduces the
 * breadth-first order `ast.walk` yields for consistently-indented modules (the
 * formatter norm) -- the verified common case.
 *
 * Accepted limitations vs a real parser (advisory `file_functions` field only,
 * not a machine contract): inconsistent indent WIDTHS across sibling blocks can
 * reorder (indent columns approximate AST depth); a non-ASCII identifier name is
 * missed (`\w` is ASCII); and a file that is unparseable in a way brackets still
 * balance yields best-effort names rather than the oracle's `[]`.
 */
function extractPyFunctions(text: string): string[] {
  // Join backslash-continued physical lines so a `def \\<newline>foo():` header
  // is seen as one logical line (Python's lexer does this).
  const joined = text.replace(/\\\n/g, '');
  const cleaned = blankPyStringsAndComments(joined);
  // Unbalanced brackets -> the module cannot parse -> Python's ast returns [].
  if (!pyBracketsBalanced(cleaned)) return [];
  const found: { indent: number; order: number; name: string }[] = [];
  let order = 0;
  for (const line of cleaned.split('\n')) {
    const m = PY_DEF_RE.exec(line);
    if (m) found.push({ indent: m[1]!.length, order, name: m[2]! });
    order++;
  }
  found.sort((a, b) => a.indent - b.indent || a.order - b.order);
  return found.map((d) => d.name);
}

const TS_FN_RE =
  /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm;
const TS_CONST_RE =
  /^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/gm;

/**
 * Collect TS/JS `function name(` then `const name = (` names, matching the two
 * Python regexes and their order: all function declarations first (source
 * order), then all const-arrow declarations (source order).
 */
function extractTsFunctions(text: string): string[] {
  const names: string[] = [];
  for (const m of text.matchAll(TS_FN_RE)) names.push(m[1]!);
  for (const m of text.matchAll(TS_CONST_RE)) names.push(m[1]!);
  return names;
}

/**
 * Best-effort file-local function extraction (Python:
 * `_extract_file_functions`). Falls back to an empty list on read failure.
 */
export function extractFileFunctions(filePath: string): string[] {
  const suffix = extname(filePath).toLowerCase();
  let text: string;
  try {
    text = readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }
  let names: string[] = [];
  if (suffix === '.py') {
    names = extractPyFunctions(text);
  } else if (TS_LIKE_SUFFIXES.has(suffix)) {
    names = extractTsFunctions(text);
  }
  // Dedupe preserving order, then cap.
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const nm of names) {
    if (!seen.has(nm)) {
      seen.add(nm);
      deduped.push(nm);
    }
  }
  return deduped.slice(0, MAX_FILE_FUNCTIONS);
}

/**
 * Return up to N existing test file paths relative to `projectRoot` (Python:
 * `_find_existing_tests`). Uses the pattern-matcher's discovery; returns an
 * empty list when nothing is found.
 */
export function findExistingTests(
  projectRoot: string,
  framework: string,
): string[] {
  const files = findTestFiles(projectRoot, framework, '');
  if (files.length === 0) return [];
  const out: string[] = [];
  for (const f of files.slice(0, MAX_EXISTING_TESTS)) {
    // Python `f.relative_to(project_root)` raises for a non-descendant and
    // falls back to the absolute path; a `..` prefix is the JS analog.
    const rel = relative(projectRoot, f);
    out.push(rel.startsWith('..') ? f : rel);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tool implementation functions (Python: _*_impl)
// ---------------------------------------------------------------------------

/** Python: `_analyze_file_impl`. */
export function analyzeFileImpl(filePath: string): Record<string, unknown> {
  if (!existsSync(filePath)) {
    return { error: `file not found: ${filePath}` };
  }

  const projectRoot = projectRootFor(filePath);
  const pattern = new PatternMatcher().scan(projectRoot);
  const domain = new DomainScanner().scan(projectRoot);

  // Framework detection: config files first, suffix as fallback.
  let [framework, frameworkSource] = detectFrameworkFromConfig(projectRoot);
  if (frameworkSource !== 'config') {
    const suffixFw = SUFFIX_FRAMEWORK[extname(filePath).toLowerCase()];
    if (suffixFw) {
      framework = suffixFw;
      frameworkSource = 'suffix';
    }
  }

  let contextSnippets: string[];
  try {
    contextSnippets = pySplitlines(readFileSync(filePath, 'utf-8')).slice(
      0,
      40,
    );
  } catch {
    contextSnippets = [];
  }

  // Context-aware persona & environment detection (#341): attach the detected
  // BASE_URL, suite type, and SDET-vs-manual user level. The file under
  // analysis is itself an "open file" signal for the user-level heuristic.
  const environment = detectEnvironment(projectRoot, {
    openFiles: [filePath],
  }).toDict();

  return {
    framework,
    framework_source: frameworkSource,
    test_type: framework === 'playwright' ? 'e2e' : 'api',
    imports: pattern.common_imports,
    // `functions` historically returned project-wide public functions from the
    // DomainScanner. Kept for backward compat; agents should prefer
    // `file_functions` for the target file's own definitions.
    functions: domain.functions.slice(0, 10),
    file_functions: extractFileFunctions(filePath),
    existing_tests: findExistingTests(projectRoot, framework),
    context_snippets: contextSnippets,
    environment,
  };
}

/** Python: `_write_test_file_impl`. */
export function writeTestFileImpl(
  filePath: string,
  content: string,
  framework: string,
): Record<string, unknown> {
  let outPath = filePath;
  if (pySuffix(basename(filePath)) === '') {
    const extMap: Record<string, string> = {
      playwright: '.spec.ts',
      vitest: '.test.ts',
      pytest: '.py',
      k6: '.js',
    };
    // Python `Path.with_suffix` on a suffix-less name appends the extension;
    // with no existing suffix to strip, that is a plain concatenation.
    outPath = filePath + (extMap[framework] ?? '.ts');
  }
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, content, 'utf-8');
  return { written_path: outPath };
}

/** Python: `_run_tests_impl`. */
export function runTestsImpl(testFile: string): Record<string, unknown> {
  const suffix = extname(testFile).toLowerCase();
  const framework = suffix === '.py' ? 'pytest' : 'playwright';
  const executor = new CanaryTestExecutor();
  let exitCode: number;
  let stdout: string;
  let stderr: string;
  try {
    [exitCode, stdout, stderr] = executor.execute(testFile, framework);
  } catch (exc) {
    return { passed: 0, failed: 0, output: errStr(exc), exit_code: 1 };
  }
  const output = (stdout || '') + (stderr || '');
  // `output.count(" passed")` - non-overlapping occurrences.
  const passedCount = output.split(' passed').length - 1;
  const passed = passedCount + (exitCode === 0 ? 1 : 0);
  const failed = exitCode === 0 ? 0 : 1;
  return { passed, failed, output, exit_code: exitCode };
}

/** Python: `_init_suite_impl`. */
export function initSuiteImpl(
  framework: string,
  targetDir: string,
): Record<string, unknown> {
  const target = targetDir || WORKING_DIR;
  const scaffolder = new Scaffolder();
  const result = scaffolder.scaffold(framework, target);
  const createdFiles = (result['created_files'] as string[]) ?? [];
  const createdDirs = (result['created_dirs'] as string[]) ?? [];
  const out: Record<string, unknown> = {
    files_created: [...createdFiles, ...createdDirs],
    framework,
    status: (result['status'] as string | undefined) ?? 'scaffolded',
  };
  if (result['status'] === 'unsupported') {
    // Degraded: no template - surface the actionable guidance rather than
    // implying an empty-but-successful scaffold.
    out['guidance'] = result['guidance'];
    out['execution_command'] = result['execution_command'];
  }
  return out;
}

/** Python: `_list_frameworks_impl`. */
export function listFrameworksImpl(): Record<string, unknown> {
  const registry = new FrameworkRegistry();
  const names = registry.getAllFrameworks().map((f) => f.name);
  // `frameworks` stays a name list for backward compatibility; `details`
  // additively exposes each framework's run-command (#357).
  return { frameworks: names, details: registry.summaries() };
}

/** Python: `_migrate_impl`. */
export function migrateImpl(
  targetDir: string,
  apply: boolean,
): Record<string, unknown> {
  const root = targetDir || WORKING_DIR;
  const migrator = new HarnessMigrator();
  const ctx = migrator.detect(root);
  if (!ctx.is_harness_project) {
    // #319 C: distinguish "config present but not a test project" from a
    // genuinely missing config.
    if (ctx.not_test_project_reason) {
      return { error: ctx.not_test_project_reason };
    }
    return { error: 'no harness.config.json found' };
  }
  const report = migrator.migrate(root, { dryRun: !apply });
  if (report.dry_run) {
    return {
      framework: report.framework,
      files_created: [],
      files_skipped: [],
      manual_followups: report.manual_followups,
      dry_run: true,
    };
  }
  return {
    framework: report.framework,
    files_created: [...report.created_files, ...report.created_dirs],
    files_skipped: report.skipped_configs,
    manual_followups: report.manual_followups,
    dry_run: false,
  };
}

// ---------------------------------------------------------------------------
// MCP tool wrappers + registration
// ---------------------------------------------------------------------------

/** A single JSON-text tool result (mirrors FastMCP's dict-return handling). */
export type ToolResult = { content: { type: 'text'; text: string }[] };

/** Wrap an impl's return dict as a JSON-text MCP tool result. */
function toToolResult(result: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: 'text', text: ensureAscii(JSON.stringify(result)) }],
  };
}

/**
 * The load-bearing namespace invariant: every canary tool carries the
 * `canary__` prefix so it can never collide with a harness tool sharing the
 * session's MCP namespace. Exported for the registration regression test.
 */
export const CANARY_TOOL_NAMES = [
  'canary__analyze_file',
  'canary__write_test_file',
  'canary__run_tests',
  'canary__init_suite',
  'canary__list_frameworks',
  'canary__migrate',
] as const;

// Tool wrappers - each only JSON-wraps the dict its impl returns (Python: the
// thin `@mcp.tool()` functions). Exported for direct delegation tests.

export function analyzeFileTool(args: { file_path: string }): ToolResult {
  return toToolResult(analyzeFileImpl(args.file_path));
}

export function writeTestFileTool(args: {
  file_path: string;
  content: string;
  framework: string;
}): ToolResult {
  return toToolResult(
    writeTestFileImpl(args.file_path, args.content, args.framework),
  );
}

export function runTestsTool(args: { test_file: string }): ToolResult {
  return toToolResult(runTestsImpl(args.test_file));
}

export function initSuiteTool(args: {
  framework: string;
  target_dir: string;
}): ToolResult {
  return toToolResult(initSuiteImpl(args.framework, args.target_dir));
}

export function listFrameworksTool(): ToolResult {
  return toToolResult(listFrameworksImpl());
}

export function migrateTool(args: {
  target_dir: string;
  apply: boolean;
}): ToolResult {
  return toToolResult(migrateImpl(args.target_dir, args.apply));
}

/**
 * Build the Canary MCP server and register all six `canary__*` tools (Python:
 * the module-level `mcp = FastMCP("canary")` plus the `@mcp.tool()`
 * registrations). Input schemas preserve the Python param names, types, and
 * defaults exactly.
 */
export function createServer(): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  server.registerTool(
    'canary__analyze_file',
    {
      description:
        'Analyse a source file and return everything needed to write a test.',
      inputSchema: { file_path: z.string() },
    },
    analyzeFileTool,
  );

  server.registerTool(
    'canary__write_test_file',
    {
      description:
        'Write test content to file_path, creating parent directories as needed.',
      inputSchema: {
        file_path: z.string(),
        content: z.string(),
        framework: z.string(),
      },
    },
    writeTestFileTool,
  );

  server.registerTool(
    'canary__run_tests',
    {
      description:
        'Run a test file and return exit code and output without raising.',
      inputSchema: { test_file: z.string() },
    },
    runTestsTool,
  );

  server.registerTool(
    'canary__init_suite',
    {
      description: 'Scaffold a test suite for framework in target_dir.',
      inputSchema: {
        framework: z.string(),
        target_dir: z.string().default(''),
      },
    },
    initSuiteTool,
  );

  server.registerTool(
    'canary__list_frameworks',
    {
      description:
        'Return all frameworks registered in agent/frameworks/registry.json.',
    },
    listFrameworksTool,
  );

  server.registerTool(
    'canary__migrate',
    {
      description:
        'Migrate a harness-scaffolded project to Canary layout. Dry-run by default.',
      inputSchema: {
        target_dir: z.string().default(''),
        apply: z.boolean().default(false),
      },
    },
    migrateTool,
  );

  return server;
}

/**
 * Console-script entry point for `canary-mcp` (Python: `main()` calling
 * `mcp.run()`). Starts the server over stdio so it works against any installed
 * canary without depending on a checked-out source tree.
 */
export async function runStdio(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
