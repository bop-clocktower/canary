// fixtures -- duplicated setup across a suite (spec D5).
//
// A line scan, no parser: pytest fixtures and unittest setUp/setup_method are
// read by indentation, JS/TS beforeEach/beforeAll and PHP setUp/set_up by brace
// depth. Two blocks are "the same setup" when their bodies match line for line
// after comments and blank lines are dropped and whitespace is collapsed. A
// name match alone is not the same setup, and a body under two lines is idiom
// (one `vi.restoreAllMocks()`), not overgrowth.
//
// Brace counting does not lex strings, so a `{` inside a string literal can
// shift a block's end. That is a fidelity limit stated in SKILL.md.

import fs from 'node:fs';
import path from 'node:path';

/** A body shorter than this is never reported. */
export const MIN_BODY_LINES = 2;

/**
 * Every forward scan from a match is bounded (security review on #615): a
 * block, brace or indented, longer than this is abandoned as unclosed, and a
 * fixture decorator looks past at most MAX_DECORATOR_RUN decorator or blank
 * lines for its def.
 */
const MAX_BLOCK_LINES = 400;
const MAX_DECORATOR_RUN = 20;

/**
 * Files over either limit are not parsed. They are reported as not read, with
 * the reason, never dropped silently (ADR 0009 / ADR 0039 abstention rules).
 */
export const MAX_FILE_BYTES = 1_000_000;
export const MAX_FILE_LINES = 20_000;

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'vendor',
  '.venv',
  'venv',
  'dist',
  'build',
  'coverage',
  '__pycache__',
]);

const TEST_FILE = [
  /\.(test|spec)\.[cm]?[jt]sx?$/,
  /^test_.*\.py$/,
  /_test\.py$/,
  /^conftest\.py$/,
  /Test\.php$/,
  /^test-.*\.php$/,
];

const isTestFile = (name) => TEST_FILE.some((re) => re.test(name));

function walkDir(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walkDir(full, out);
    } else if (entry.isFile() && isTestFile(entry.name)) {
      out.push(full);
    }
  }
}

/**
 * Every test file under `paths`. A file named explicitly is always included.
 *
 * @param {string[]} paths
 * @returns {string[]} sorted absolute paths
 */
export function walkTestFiles(paths) {
  const out = [];
  for (const p of paths) {
    if (!fs.existsSync(p)) throw new Error(`path not found: ${p}`);
    if (fs.statSync(p).isDirectory()) walkDir(path.resolve(p), out);
    else out.push(path.resolve(p));
  }
  return [...new Set(out)].sort();
}

const indentOf = (line) => line.length - line.trimStart().length;
const squash = (line) => line.trim().replace(/\s+/g, ' ');

function normalize(lines, commentPrefix) {
  return lines.map(squash).filter((l) => l && !l.startsWith(commentPrefix));
}

const PY_DEF = /^(\s*)(?:async\s+)?def\s+(\w+)\s*\(/;
const PY_SETUP = /^(\s*)def\s+(setUp|setup_method|setUpClass|setup_class)\s*\(/;

/**
 * The indented body under the def at `at`, normalized, or null when it runs
 * past MAX_BLOCK_LINES: the same cap the brace scan uses, so no match can scan
 * to end of file and a file of many matches stays linear, not quadratic.
 */
function pythonBody(lines, at) {
  const indent = indentOf(lines[at]);
  const last = Math.min(lines.length, at + 1 + MAX_BLOCK_LINES);
  let i = at + 1;
  while (i < last && !(lines[i].trim() && indentOf(lines[i]) <= indent)) {
    i += 1;
  }
  if (i === last && last < lines.length) return null;
  return normalize(lines.slice(at + 1, i), '#');
}

/**
 * The def a `@pytest.fixture` decorates: the next def, past other decorators
 * and blank lines -- at most MAX_DECORATOR_RUN of them, so a wall of
 * decorators cannot make every one of them scan the whole wall.
 */
function decoratedDef(lines, at) {
  const last = Math.min(lines.length, at + 1 + MAX_DECORATOR_RUN);
  for (let i = at + 1; i < last; i += 1) {
    const t = lines[i].trim();
    if (!t || t.startsWith('@')) continue;
    return PY_DEF.test(lines[i]) ? i : -1;
  }
  return -1;
}

function pythonBlocks(lines) {
  const blocks = [];
  lines.forEach((line, i) => {
    let at = -1;
    let kind = 'setup';
    if (/^\s*@pytest\.fixture\b/.test(line)) {
      at = decoratedDef(lines, i);
      kind = 'pytest-fixture';
    } else if (PY_SETUP.test(line)) at = i;
    if (at === -1) return;
    const body = pythonBody(lines, at);
    if (!body) return;
    const name = PY_DEF.exec(lines[at])[2];
    blocks.push({ kind, name, line: at + 1, body });
  });
  return blocks;
}

/** Index of the line that closes the brace block opened on `at`, or -1. */
function closingLine(lines, at) {
  let depth = 0;
  let opened = false;
  const last = Math.min(lines.length, at + MAX_BLOCK_LINES);
  for (let i = at; i < last; i += 1) {
    for (const ch of lines[i]) {
      if (ch === '{') [depth, opened] = [depth + 1, true];
      else if (ch === '}') depth -= 1;
    }
    if (opened && depth <= 0) return i;
  }
  return -1;
}

const JS_HOOK = /\b(beforeEach|beforeAll)\s*\(/;
const PHP_SETUP = /\bfunction\s+(setUp|set_up)\s*\(/;

function braceBlocks(lines, pattern, kindOf) {
  const blocks = [];
  lines.forEach((line, i) => {
    const m = pattern.exec(line);
    if (!m) return;
    const end = closingLine(lines, i);
    if (end <= i + 1) return;
    const body = normalize(lines.slice(i + 1, end), '//');
    blocks.push({ kind: kindOf(m[1]), name: m[1], line: i + 1, body });
  });
  return blocks;
}

/**
 * Setup blocks in one file, each with its normalized body.
 *
 * @param {string} text file contents
 * @param {string} file name or path, for its extension
 * @returns {Array<{kind: string, name: string, line: number, body: string[]}>}
 */
export function extractBlocks(text, file) {
  const lines = text.split(/\r\n|\r|\n/);
  let blocks = [];
  if (file.endsWith('.py')) blocks = pythonBlocks(lines);
  else if (file.endsWith('.php'))
    blocks = braceBlocks(lines, PHP_SETUP, (n) => `php-${n}`);
  else if (/\.[cm]?[jt]sx?$/.test(file))
    blocks = braceBlocks(lines, JS_HOOK, (n) => n);
  return blocks.filter((b) => b.body.length >= MIN_BODY_LINES);
}

const toPosix = (p) => p.split(path.sep).join('/');

const byLocation = (a, b) =>
  a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1;

function toGroup(members) {
  const locations = members
    .map(({ file, line, name }) => ({ file, line, name }))
    .sort(byLocation);
  return {
    kind: members[0].kind,
    body_lines: members[0].body.length,
    first_line: members[0].body[0],
    locations,
  };
}

const byGroupOrder = (a, b) =>
  b.locations.length - a.locations.length ||
  byLocation(a.locations[0], b.locations[0]);

/** The text of a file within the size limits, or the reason it was not read. */
function readWithinLimits(abs) {
  if (fs.statSync(abs).size > MAX_FILE_BYTES) {
    return { reason: `larger than ${MAX_FILE_BYTES} bytes, not parsed` };
  }
  const text = fs.readFileSync(abs, 'utf8');
  const lines = text.split(/\r\n|\r|\n/).length;
  if (lines > MAX_FILE_LINES) {
    return { reason: `longer than ${MAX_FILE_LINES} lines, not parsed` };
  }
  return { text };
}

/**
 * Walk `paths`, extract every setup block and group identical bodies. Files
 * over the size limits are listed in `unread` with the reason.
 *
 * @param {string[]} paths
 * @param {string} root locations are reported relative to this directory
 */
export function scanFixtures(paths, root) {
  const files = walkTestFiles(paths);
  const byBody = new Map();
  const unread = [];
  let setupBlocks = 0;
  for (const abs of files) {
    const file = toPosix(path.relative(root, abs));
    const { text, reason } = readWithinLimits(abs);
    if (reason) {
      unread.push({ file, reason });
      continue;
    }
    for (const block of extractBlocks(text, abs)) {
      setupBlocks += 1;
      const key = `${block.kind}\n${block.body.join('\n')}`;
      if (!byBody.has(key)) byBody.set(key, []);
      byBody.get(key).push({ ...block, file });
    }
  }
  const groups = [...byBody.values()]
    .filter((members) => members.length >= 2)
    .map(toGroup)
    .sort(byGroupOrder);
  return {
    filesScanned: files.length - unread.length,
    setupBlocks,
    groups,
    unread,
  };
}
