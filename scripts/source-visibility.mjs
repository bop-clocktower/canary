#!/usr/bin/env node
// Fails when source code is invisible to the architecture analyzer (#688).
//
// The analyzer walks the tree with a hard-coded skip list — `DEFAULT_SKIP_DIRS`
// in `@harness-engineering/graph`, 55 names including `coverage`, `dist`,
// `build`, `bin`, `out`, `target`, `vendor` — plus every directory whose name
// starts with a dot. A source directory whose name collides is never walked, so
// every line inside it is invisible to `module-size`, `complexity`, `coupling`
// and the rest.
//
// This fails **OPEN**, which is what makes it worse than the usual gate bug.
// Splitting `ts/src/guardian/coverage.ts` into `ts/src/guardian/coverage/`
// dropped the reported `module-size` by 1822 lines — the exact size of the code
// that had just moved there. The ratchet gained headroom, the diff looked
// clean, and every downstream signal agreed with the lie. Renaming the
// directory to `diff-coverage/` put the number back. A metric that silently
// *improves* is exactly as strong a signal that something is wrong as one that
// regresses; this repo's ratchets only ever interrogated growth.
//
// Two independent mechanisms hid the same code, so both are checked:
//
//   1. NAME COLLISION — a directory named after a skip-list entry (or starting
//      with a dot) is never walked. Checked against git's index for tracked
//      files, and against the working tree for files git has not seen.
//   2. .GITIGNORE — `ts/.gitignore` carries `coverage/`, so the split files
//      were unstageable. They would never have been committed, and prettier
//      had been skipping them too. A source file git refuses to track is
//      invisible to every gate downstream of the index, name collision or not.
//
// Mechanism 2 is why the tracked-file arm alone is not enough: the files that
// triggered #688 were never in the index, so `git ls-files` enumerated zero of
// them and would have reported a clean tree with total confidence.
//
// Exit codes follow the repo's gate convention (#508):
//   0 = every source directory is walkable and stageable
//   1 = HIDDEN — source the arch gate cannot see, with the line count it lost
//   2 = usage error
//   3 = ABSTENTION — no source files were enumerated, the root is not a git
//       working tree, or the skip list is empty. Each of those makes every
//       collision check vacuously true, and "0 collisions found" out of zero
//       inspected files is an abstention wearing a pass.
//
//   node scripts/source-visibility.mjs [--json] [--root <dir>]
//   node scripts/source-visibility.mjs --print-skip-dirs
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * `DEFAULT_SKIP_DIRS` as of `@harness-engineering/cli@11.1.1`
 * (`node_modules/@harness-engineering/graph`), vendored in full rather than
 * sampled.
 *
 * A sampled copy is the wrong trade here even though it reads better. The
 * population this guards is "directory names a human might reasonably pick for
 * a source module", and the surprising entries — `deps`, `obj`, `target`,
 * `out`, `bin` — are exactly the ones nobody would think to sample. The list
 * is dumped by `--print-skip-dirs` so a drift check against a live install is
 * one command rather than a re-read of this file.
 */
export const ANALYZER_SKIP_DIRS = Object.freeze([
  '.agentastic',
  '.agents',
  '.aider',
  '.astro',
  '.cache',
  '.claude',
  '.codex',
  '.cursor',
  '.docusaurus',
  '.e2e',
  '.gemini',
  '.git',
  '.git-worktrees',
  '.gradle',
  '.gradle-home',
  '.harness',
  '.hg',
  '.idea',
  '.mypy_cache',
  '.next',
  '.nuxt',
  '.nyc_output',
  '.parcel-cache',
  '.playwright-mcp',
  '.pnpm-store',
  '.pytest_cache',
  '.remix',
  '.ruff_cache',
  '.svelte-kit',
  '.svn',
  '.tox',
  '.turbo',
  '.venv',
  '.vite',
  '.vs',
  '.vscode',
  '.worktrees',
  '.wrangler',
  '.yarn',
  '__pycache__',
  '_build',
  'bin',
  'build',
  'coverage',
  'deps',
  'dist',
  'node_modules',
  'obj',
  'out',
  'playwright-report',
  'storybook-static',
  'target',
  'test-results',
  'vendor',
  'venv',
]);

/** Directories never descended into, independent of the skip list. */
const WALK_STOP = new Set(['.git', 'node_modules']);

/**
 * Hand-written TypeScript. `.d.ts` is excluded so a `dist/` full of emitted
 * declarations does not read as hidden source; tests are excluded because the
 * analyzer excludes them from its own metrics.
 */
export function isSourceFile(name) {
  if (!name.endsWith('.ts') && !name.endsWith('.tsx')) return false;
  if (name.endsWith('.d.ts')) return false;
  return !/\.(test|spec)\.tsx?$/.test(name);
}

/** The first path segment that stops the analyzer walking, if any. */
export function hidingSegment(relPath, skipDirs) {
  const segments = relPath.split('/').slice(0, -1);
  for (const segment of segments) {
    if (segment.startsWith('.') || skipDirs.has(segment)) return segment;
  }
  return undefined;
}

function toPosix(p) {
  return sep === '/' ? p : p.split(sep).join('/');
}

/** Non-blank lines — the analyzer's own `countLoc`, so `hiddenLoc` is its units. */
function countLoc(absPath) {
  try {
    return readFileSync(absPath, 'utf-8')
      .split('\n')
      .filter((line) => line.trim().length > 0).length;
  } catch {
    return 0;
  }
}

/**
 * Every working-tree source file under `root`, keyed by its directory.
 *
 * Dot-directories are not descended into: a checkout can carry whole nested
 * worktrees under `.claude/`, and walking those would report another copy of
 * this repo as hidden source. Tracked files inside a dot-directory are still
 * caught, by the index arm below — `git ls-files` lists them and
 * `hidingSegment` sees the leading dot.
 */
function walkSourceDirs(root) {
  const filesByDir = new Map();
  const visit = (absDir) => {
    let entries;
    try {
      entries = readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = join(absDir, entry.name);
      if (entry.isDirectory()) {
        if (WALK_STOP.has(entry.name) || entry.name.startsWith('.')) continue;
        visit(abs);
      } else if (entry.isFile() && isSourceFile(entry.name)) {
        const relDir = toPosix(relative(root, absDir)) || '.';
        const list = filesByDir.get(relDir) ?? [];
        list.push(toPosix(relative(root, abs)));
        filesByDir.set(relDir, list);
      }
    }
  };
  visit(root);
  return filesByDir;
}

function git(root, args, input) {
  return execFileSync('git', args, {
    cwd: root,
    input,
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/** Tracked source files, or `undefined` when `root` is not a git working tree. */
function trackedSourceFiles(root) {
  let raw;
  try {
    raw = git(root, ['ls-files', '-z']);
  } catch {
    return undefined;
  }
  return raw
    .split('\0')
    .filter(Boolean)
    .map(toPosix)
    .filter((p) => isSourceFile(p.split('/').pop() ?? ''));
}

/**
 * The subset of `paths` git is configured to ignore.
 *
 * `check-ignore` exits 1 when nothing matches, which `execFileSync` throws on —
 * that is the ordinary clean case, so it is caught and read as "none".
 */
function ignoredPaths(root, paths) {
  if (paths.length === 0) return [];
  try {
    return git(root, ['check-ignore', '--stdin'], paths.join('\n'))
      .split('\n')
      .filter(Boolean)
      .map(toPosix);
  } catch {
    return [];
  }
}

class Abstention extends Error {}

/**
 * Classifies one root. Throws `Abstention` rather than returning a clean
 * report whenever the thing it would have inspected is empty.
 */
export function auditSourceVisibility(root, skipDirs) {
  if (skipDirs.size === 0) {
    throw new Abstention(
      'the analyzer skip list is empty, so every collision check would pass vacuously',
    );
  }
  const tracked = trackedSourceFiles(root);
  if (tracked === undefined) {
    throw new Abstention(
      `${root} is not a git working tree — the index and .gitignore arms of this check cannot run, and the half that can is not the half that caught #688`,
    );
  }

  const filesByDir = walkSourceDirs(root);
  const walked = [...filesByDir.values()].flat();
  if (tracked.length === 0 && walked.length === 0) {
    throw new Abstention(
      `no source files found under ${root} — zero files inspected is not a pass`,
    );
  }

  const hiddenDirs = [];
  const hidden = new Set();
  for (const [dir, files] of filesByDir) {
    const hiddenBy = hidingSegment(`${dir}/x`, skipDirs);
    if (hiddenBy === undefined) continue;
    hiddenDirs.push({ path: dir, hiddenBy });
    for (const f of files) hidden.add(f);
  }

  const hiddenFiles = [];
  for (const file of tracked) {
    const hiddenBy = hidingSegment(file, skipDirs);
    if (hiddenBy === undefined) continue;
    hiddenFiles.push({ path: file, hiddenBy });
    hidden.add(file);
  }

  const ignoredSourceFiles = ignoredPaths(root, walked);
  for (const f of ignoredSourceFiles) hidden.add(f);

  let hiddenLoc = 0;
  for (const f of hidden) hiddenLoc += countLoc(join(root, f));

  return {
    verdict: hidden.size === 0 ? 'visible' : 'hidden',
    filesChecked: new Set([...tracked, ...walked]).size,
    dirsChecked: filesByDir.size,
    skipDirCount: skipDirs.size,
    hiddenFiles: hiddenFiles.sort((a, b) => a.path.localeCompare(b.path)),
    hiddenDirs: hiddenDirs.sort((a, b) => a.path.localeCompare(b.path)),
    ignoredSourceFiles: ignoredSourceFiles.sort(),
    hiddenLoc,
  };
}

/** Human-readable lines for a report. */
export function visibilityLines(report) {
  if (report.verdict === 'visible') {
    return [
      `source visibility — clean: ${report.filesChecked} source file(s) across ${report.dirsChecked} director(ies), all walkable by the arch analyzer and all stageable.`,
    ];
  }
  const lines = [
    `source visibility — HIDDEN: ${report.hiddenLoc} line(s) of source are invisible to the arch analyzer.`,
    '  The gate is reporting BETTER than reality — module-size and complexity are',
    '  measured without this code, so the ratchet has headroom it did not earn.',
  ];
  for (const d of report.hiddenDirs) {
    lines.push(
      `  ${d.path}/ — never walked: the segment \`${d.hiddenBy}\` is in the analyzer's skip list. Rename the directory.`,
    );
  }
  for (const f of report.hiddenFiles) {
    lines.push(
      `  ${f.path} — never walked: the segment \`${f.hiddenBy}\` is in the analyzer's skip list.`,
    );
  }
  for (const f of report.ignoredSourceFiles) {
    lines.push(
      `  ${f} — git is configured to ignore it, so it is unstageable and invisible to prettier and every index-reading gate.`,
    );
  }
  return lines;
}

function parseArgs(argv) {
  const args = { json: false, root: process.cwd(), skipDirs: undefined };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--json') args.json = true;
    else if (argv[i] === '--print-skip-dirs') args.printSkipDirs = true;
    else if (argv[i] === '--root') {
      args.root = argv[++i];
      if (args.root === undefined) return { usage: '--root needs a path' };
    } else if (argv[i] === '--skip-dirs') {
      const csv = argv[++i];
      if (csv === undefined) return { usage: '--skip-dirs needs a value' };
      args.skipDirs = csv.split(',').filter(Boolean);
    } else return { usage: `unknown option ${argv[i]}` };
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.usage !== undefined) {
    console.error(
      `source-visibility.mjs: ${args.usage}\nusage: source-visibility.mjs [--json] [--root <dir>] | --print-skip-dirs`,
    );
    process.exit(2);
  }
  if (args.printSkipDirs) {
    console.log(JSON.stringify(ANALYZER_SKIP_DIRS));
    process.exit(0);
  }

  let report;
  try {
    report = auditSourceVisibility(
      args.root,
      new Set(args.skipDirs ?? ANALYZER_SKIP_DIRS),
    );
  } catch (error) {
    if (!(error instanceof Abstention)) throw error;
    console.log(
      `::error title=Source visibility unavailable::${error.message}`,
    );
    console.error(`ABSTAINED: ${error.message}`);
    process.exit(3);
  }

  if (args.json) console.log(JSON.stringify(report));
  else for (const line of visibilityLines(report)) console.log(line);

  if (report.verdict === 'hidden') {
    console.log(
      `::error title=source visibility::${report.hiddenLoc} line(s) of source are invisible to the arch analyzer — the gate is reporting better than reality`,
    );
    process.exit(1);
  }
  process.exit(0);
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
