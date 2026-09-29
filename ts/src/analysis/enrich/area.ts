/**
 * Map a recorded test file to a critical area (#1125, decision D8).
 *
 * `area` in the history store means "the critical area this test file maps to"
 * in `.canary/critical-areas.json`. Candidates share the test's file stem
 * (extension and a `.test`/`.spec` marker stripped). Among them, the area
 * sharing the most trailing directory segments wins, then the higher
 * `risk_score`, then the lexically smaller path, so the choice is
 * deterministic.
 *
 * An areas file that is absent or unusable is an abstention with a note, never
 * a silent empty (#508): `loadAreas` returns the reason for `record` to print.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  parseCriticalAreas,
  type CriticalArea,
} from '../../core/inventory-checks.js';

const CRITICAL_AREAS_FILE = '.canary/critical-areas.json';

interface AreasLoad {
  areas: CriticalArea[];
  note?: string;
}

function unusable(reason: string): AreasLoad {
  return {
    areas: [],
    note:
      `area not recorded: ${reason}. \`history record\` maps each test ` +
      `file to an area listed in ${CRITICAL_AREAS_FILE}.`,
  };
}

/** The file's text, `null` when it does not exist, or the read error code. */
function readAreasText(
  cwd: string,
): { text: string | null } | { code: string } {
  try {
    return { text: readFileSync(join(cwd, CRITICAL_AREAS_FILE), 'utf-8') };
  } catch (err) {
    const code = String((err as NodeJS.ErrnoException).code);
    return code === 'ENOENT' ? { text: null } : { code };
  }
}

/** The areas under `cwd`, or none plus the note that says why. */
export function loadAreas(cwd: string): AreasLoad {
  const read = readAreasText(cwd);
  if ('code' in read) {
    return unusable(`${CRITICAL_AREAS_FILE} could not be read (${read.code})`);
  }
  const parsed = parseCriticalAreas(read.text);
  if (!parsed.ok) return unusable(parsed.reason);
  if (parsed.areas.length === 0) {
    return unusable(`${CRITICAL_AREAS_FILE} lists no areas`);
  }
  return { areas: parsed.areas };
}

/** Path segments; JUnit `file` attributes can carry Windows separators. */
const segments = (path: string): string[] => path.split(/[\\/]/);

function fileStem(path: string): string {
  const base = segments(path).pop() ?? '';
  return base.replace(/\.[^.]+$/, '').replace(/\.(test|spec)$/, '');
}

/** How many trailing directory segments two paths have in common. */
function sharedTrailingDirs(a: string, b: string): number {
  const x = segments(a).slice(0, -1).reverse();
  const y = segments(b).slice(0, -1).reverse();
  let n = 0;
  while (n < x.length && n < y.length && x[n] === y[n]) n++;
  return n;
}

interface Candidate {
  area: CriticalArea;
  shared: number;
}

function byRank(p: Candidate, q: Candidate): number {
  if (p.shared !== q.shared) return q.shared - p.shared;
  // parseCriticalAreas turns a non-numeric score into NaN; rank it as 0.
  const risk = (c: Candidate): number =>
    Number.isFinite(c.area.risk_score) ? c.area.risk_score : 0;
  if (risk(p) !== risk(q)) return risk(q) - risk(p);
  return p.area.path < q.area.path ? -1 : 1;
}

/** The matched area's `path`, or undefined when no area shares the stem. */
export function areaFor(
  testFile: string,
  areas: readonly CriticalArea[],
): string | undefined {
  const stem = fileStem(testFile);
  // An empty stem (JUnit with no `file`, a directory-style area) maps nothing:
  // the store is append-only, so a wrong area is worse than none.
  if (stem === '') return undefined;
  const ranked = areas
    .filter((a) => fileStem(a.path) === stem)
    .map((a) => ({ area: a, shared: sharedTrailingDirs(testFile, a.path) }))
    .sort(byRank);
  return ranked[0]?.area.path;
}
