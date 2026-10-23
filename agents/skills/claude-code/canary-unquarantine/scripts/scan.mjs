// scan -- every quarantine marker in the suite, ledgered or not.
//
// The audit starts from the ledger, so a test switched off with no ledger row
// would never be seen. This walks the suite's test files and lists every
// title-bearing marker; the audit subtracts the ones a row accounts for and
// reports the rest as unledgered, never silently ignored.

import fs from 'node:fs';
import path from 'node:path';

import { isTestFile } from '../../canary-katana/scripts/diffscan.mjs';
import {
  DEFAULT_TAGS,
  PY_EXT,
  STATIC_SKIP,
  commentAbove,
  jsDeclarations,
  maskJs,
  pyDeclarations,
  staticMarkerLine,
} from './markers.mjs';

const JS_EXT = /\.(?:[cm]?[jt]sx?)$/;

/** Build output, dependencies and tool state: never the suite's own tests. */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  'test-results',
  'playwright-report',
  '.venv',
  'venv',
  '__pycache__',
  '.canary',
  '.harness',
]);

/** Test files under `repo`, repo-relative, sorted. */
function testFiles(repo) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(path.join(repo, dir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (e.isDirectory() && !SKIP_DIRS.has(e.name)) walk(rel);
      else if (
        e.isFile() &&
        (JS_EXT.test(e.name) || PY_EXT.test(e.name)) &&
        isTestFile(rel)
      )
        out.push(rel);
    }
  };
  walk('');
  return out.sort();
}

/** The marker as the ledger would write it: the decorator, the callee or the tag. */
function markerName(lang, decl, tags) {
  if (lang === 'py') return decl.decorators[0];
  if (STATIC_SKIP.test(decl.callee)) return decl.callee;
  return tags.find((t) => decl.title.includes(t) || decl.tags?.includes(t));
}

/** The markers in one file. Template literals are blanked: fixture source is not a marker. */
function fileMarkers(repo, file, tags) {
  let source;
  try {
    source = fs.readFileSync(path.join(repo, file), 'utf8');
  } catch {
    return [];
  }
  const lang = PY_EXT.test(file) ? 'py' : 'js';
  const lines = source.split('\n');
  const decls =
    lang === 'py'
      ? pyDeclarations(source)
      : jsDeclarations(maskJs(source, { templates: true }));
  return decls.flatMap((d) => {
    const markerLine = staticMarkerLine({ lang }, d, tags);
    if (!markerLine) return [];
    return [
      {
        file,
        test: d.title,
        line: d.line,
        markerLine,
        marker: markerName(lang, d, tags),
        context: commentAbove(lines, markerLine),
      },
    ];
  });
}

/**
 * Every title-bearing quarantine marker in the suite: static skips, pytest
 * skip decorators and tagged titles. Runtime `test.skip(cond, why)` calls are
 * not listed -- they carry no title of their own and are usually conditions on
 * the environment, not quarantines; one that IS a quarantine has a ledger row
 * naming it, and `locate` finds it from there.
 *
 * `files` is the denominator: how many test files were read. Zero markers in
 * zero files is not a clean suite.
 */
export function scanSuite(repo, tags = DEFAULT_TAGS) {
  const files = testFiles(repo);
  return {
    files: files.length,
    markers: files.flatMap((file) => fileMarkers(repo, file, tags)),
  };
}
