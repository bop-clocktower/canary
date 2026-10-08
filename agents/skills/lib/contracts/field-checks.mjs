// Per-value checks of the canary QA contracts that the validator (rules.mjs)
// and a producer (canary-starling) must agree on (#1225). A producer with a
// weaker check than the validator writes a feed the validator then refuses,
// whole: starling once judged timestamps by `Date.parse`, which rolls
// 2026-02-30 over to 03-02, while the `real-dates` rule refused it.
//
// The two patterns are READ from run.v1.schema.json, not copied, so neither
// check can drift from the schema it adds to.

import { readFileSync } from 'node:fs';

const { $defs } = JSON.parse(
  readFileSync(new URL('./run.v1.schema.json', import.meta.url), 'utf8'),
);

/** The schema's `timestamp` pattern; it captures no field. */
export const TIMESTAMP_RE = new RegExp($defs.timestamp.pattern);
const REPO_PATH_RE = new RegExp($defs.repoPath.pattern);

/** Hour, minute, second, offset hour, offset minute. A leap second is refused. */
const CLOCK_MAX = [23, 59, 59, 23, 59];

/** setUTCFullYear, not Date.UTC: Date.UTC reads years 0-99 as 1900-1999. */
const daysInMonth = (year, month) =>
  new Date(new Date(0).setUTCFullYear(year, month, 0)).getUTCDate();

const isRealDay = (y, mo, d) =>
  mo >= 1 && mo <= 12 && d >= 1 && d <= daysInMonth(y, mo);

/**
 * True when `value` matches the schema pattern AND names a real instant: the
 * calendar date exists and every clock and offset field is in range (#1154
 * S2). `Date.parse` is not the judge; it rolls 02-30 over to 03-02.
 */
export function isTimestamp(value) {
  if (typeof value !== 'string' || !TIMESTAMP_RE.test(value)) return false;
  // The pattern fixes the layout: YYYY-MM-DDTHH:MM:SS[.f](Z|±HH:MM).
  const offset = value.endsWith('Z') ? [] : value.slice(-5).split(':');
  const [y, mo, d, ...clock] = [
    ...value.slice(0, 19).split(/[-T:]/),
    ...offset,
  ].map(Number);
  return isRealDay(y, mo, d) && clock.every((v, i) => v <= CLOCK_MAX[i]);
}

const HOME = 'is home-relative (~), not repo-relative (ADR 0029)';
const ROOTED = 'is absolute (\\), not repo-relative (ADR 0029)';
const DRIVE = 'is drive-relative (C:), not repo-relative (ADR 0029)';
const ESCAPES = 'escapes the repository root (ADR 0029)';
const ROOT = 'names the repository root, not a file (ADR 0029)';

/** +1 per directory entered, -1 per `..`; `.` and empty segments stay put. */
const depthStep = (seg) =>
  seg === '..' ? -1 : Number(seg !== '' && seg !== '.');

/** `C:x` (drive-relative); `C:/x` and `C:\x` are the schema pattern's error. */
const isDriveRelative = (file) => /^[A-Za-z]:(?![\\/])/.test(file);

/** Where the `..` segments climb above the root, or where the path ends. */
function pathDepth(segments) {
  let depth = 0;
  for (const seg of segments) {
    depth += depthStep(seg);
    if (depth < 0) return ESCAPES;
  }
  return depth === 0 ? ROOT : null;
}

/**
 * Why `file` is not a path `git ls-files` could print, or null (ADR 0029):
 * everything the schema's `repoPath` pattern cannot express. A string the
 * pattern refuses (empty, `/x`, `C:/x`) gets only the pattern's error.
 */
export function notRepoRelative(file) {
  if (file === '' || !REPO_PATH_RE.test(file)) return null;
  const segments = file.split(/[\\/]/);
  if (segments[0].startsWith('~')) return HOME;
  if (file.startsWith('\\')) return ROOTED;
  if (isDriveRelative(file)) return DRIVE;
  return pathDepth(segments);
}

/** For a producer: the schema pattern and every repo-relative rule pass. */
export const isRepoPath = (file) =>
  typeof file === 'string' &&
  file.trim() !== '' &&
  REPO_PATH_RE.test(file) &&
  notRepoRelative(file) === null;
