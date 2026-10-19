/**
 * Where a coverage report's paths actually live in the repo (#883, #1291).
 *
 * A report's keys are relative to wherever its tool ran (vitest under `ts/`
 * writes `src/cli.ts`). This module anchors them to repo-relative paths, once,
 * for both consumers: the instrumentation-scope denominator (which trees does
 * the report cover?) and per-unit matching (which file does this key name?).
 */

// canary:allow-untested fp: module-load imports/signature scored via line 0 (#1408)
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import type { ReportIndex } from './types.js';

/**
 * The repo-relative prefix a report's relative paths are rooted at (#883): the
 * nearest ancestor of the report's directory under which any of `samples`
 * exists (vitest under `ts/` writes `src/cli.ts`). Every sample is tried, since
 * a stale report names deleted files. The repo root itself is tried last and
 * yields `''` (#1291). No hit, or outside the repo: `null`, not anchored.
 */
function anchorPrefix(
  samples: string[],
  reportPath: string,
  root: string,
): string | null {
  const rel = relative(root, resolve(dirname(reportPath)));
  const dir = rel === '' ? [] : rel.split(sep);
  if (dir[0] === '..' || isAbsolute(rel)) return null;
  for (let i = dir.length; i >= 0; i--) {
    const prefix = i === 0 ? '' : `${dir.slice(0, i).join('/')}/`;
    if (samples.some((s) => existsSync(join(root, prefix, s)))) return prefix;
  }
  return null;
}

/** The deepest directory shared by every path in `paths` ('' when none). */
function commonDir(paths: string[]): string {
  const dirs = paths.map((p) => p.split('/').slice(0, -1));
  const first = dirs[0] ?? [];
  let n = first.length;
  for (const d of dirs) {
    while (n > 0 && d.slice(0, n).join('/') !== first.slice(0, n).join('/'))
      n--;
  }
  return first.slice(0, n).join('/');
}

/**
 * Every report key as `[key, path, anchored]`, `path` being the repo-relative
 * file it names: grouped by top-level segment, each group under its
 * {@link anchorPrefix}. `anchored` is whether that prefix was found.
 */
function anchoredGroups(
  index: ReportIndex,
  reportPath: string,
  repoRoot: string,
): [string, string, boolean][][] {
  const root = resolve(repoRoot);
  const groups = new Map<string, [string, string][]>();
  for (const raw of Object.keys(index)) {
    const p = isAbsolute(raw) ? relative(root, raw).split(sep).join('/') : raw;
    const clean = p.replace(/^\.\//, '');
    const top = clean.split('/')[0]!;
    (groups.get(top) ?? groups.set(top, []).get(top)!).push([raw, clean]);
  }
  return [...groups.values()].map((pairs) => {
    const paths = pairs.map(([, p]) => p);
    const prefix = anchorPrefix(paths, reportPath, root);
    return pairs.map(([raw, p]) => [raw, (prefix ?? '') + p, prefix !== null]);
  });
}

/**
 * The repo-relative source trees a report instruments (#883): one per top-level
 * segment of its (anchored) paths, narrowed to the deepest shared directory.
 * `''` means the report is rooted at the repo itself and covers everything.
 */
export function instrumentedTrees(
  index: ReportIndex,
  reportPath: string,
  repoRoot: string,
): string[] {
  return anchoredGroups(index, reportPath, repoRoot).map((group) =>
    commonDir(group.map(([, p]) => p)),
  );
}

/**
 * `index` re-keyed by the anchored paths (#1291). Matching raw keys let a
 * report under `pkg-a/` naming `src/index.ts` suffix-bind a changed
 * `pkg-b/src/index.ts`; an anchored entry now binds by exact match only (see
 * `FileCoverage.anchored`). Absolute and colliding keys are left as they were.
 */
export function anchorIndex(
  index: ReportIndex,
  reportPath: string,
  repoRoot: string,
): ReportIndex {
  const out: ReportIndex = Object.assign(Object.create(null), index);
  const keys = anchoredGroups(index, reportPath, repoRoot).flat();
  for (const [raw, path, anchored] of keys) {
    if (isAbsolute(raw) || (raw !== path && Object.hasOwn(out, path))) continue;
    const file = out[raw]!;
    delete out[raw];
    out[path] = anchored ? { ...file, anchored } : file;
  }
  return out;
}

/**
 * How many changed `paths` lie inside a tree the report instruments (#883) —
 * the denominator a zero-match abstention needs. Zero eligible means the files
 * are outside the instrumentation scope, so no fresh report could match them;
 * eligible-but-unmatched means the report itself is stale.
 */
export function countEligible(
  paths: string[],
  index: ReportIndex,
  reportPath: string,
  repoRoot: string,
): number {
  const trees = instrumentedTrees(index, reportPath, repoRoot);
  const inside = (p: string) =>
    trees.some((t) => t === '' || p.startsWith(`${t}/`));
  return paths.filter(inside).length;
}
