// areas -- read critical-areas.json and work out what each area matches on.
//
// The file is checked against its contract (lib/contracts, #1242). A problem
// with the file as a whole degrades katana to recording-only; a problem with
// one entry makes only that area not assessed. Neither is guessed past.

import fs from 'node:fs';

import {
  normSymbol,
  validateCriticalAreas,
} from '../../../lib/contracts/critical-areas.mjs';
import {
  dirsOf,
  isGenericDir,
  moduleKey,
  stripCodeSuffix,
  toPosix,
} from './nearby.mjs';

// A derived (basename) symbol shorter than this matches too much to mean
// anything. A DECLARED symbol is taken as given: someone chose it.
export const MIN_DERIVED_SYMBOL = 4;

/**
 * @typedef {{available: boolean, areas: Array<Record<string, any>>,
 *            reason: string, problems?: Map<number, string[]>}} CriticalAreas
 *   `problems` maps an area's index to the contract errors that make it
 *   unusable; such an area is reported as not assessed, never guessed at.
 */

const unavailable = (reason) => ({ available: false, areas: [], reason });

const AREA_INDEX = /^areas\[(\d+)\]/;

/** Split validator errors into whole-file ones and per-area ones. */
function partitionErrors(errors) {
  const fileErrors = [];
  const problems = new Map();
  for (const e of errors) {
    const text = `${e.path}: ${e.message}`;
    const m = AREA_INDEX.exec(e.path);
    if (!m) fileErrors.push(text);
    else
      problems.set(Number(m[1]), [...(problems.get(Number(m[1])) ?? []), text]);
  }
  return { fileErrors, problems };
}

/**
 * Load critical-areas.json; unavailable (not throwing) on any problem with the
 * file as a whole. A single bad entry does not sink the file: it is carried in
 * `problems` and reported as not assessed.
 * @returns {CriticalAreas}
 */
export function loadCriticalAreas(filePath) {
  if (filePath === null || filePath === undefined) {
    return unavailable('critical-area file not provided');
  }
  if (!fs.existsSync(filePath)) {
    return unavailable(`critical-area file not found: ${filePath}`);
  }
  let data;
  try {
    data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (exc) {
    return unavailable(`critical-area file malformed: ${exc.message}`);
  }
  const { fileErrors, problems } = partitionErrors(
    validateCriticalAreas(data).errors,
  );
  if (fileErrors.length) {
    return unavailable(
      `critical-area file malformed: ${fileErrors.join('; ')}`,
    );
  }
  return { available: true, areas: [...data.areas], problems, reason: '' };
}

const basename = (p) => toPosix(p).split('/').pop() || '';

/**
 * Symbols an area path exposes: its basename minus code suffix, plus parts.
 * `src/loyalty/points.service.ts` -> {points.service, points, service}.
 */
export function areaSymbols(areaPath) {
  const base = stripCodeSuffix(basename(areaPath));
  const symbols = new Set([base]);
  for (const part of base.split('.')) if (part) symbols.add(part);
  return symbols;
}

const derivedSymbols = (areaPath) =>
  new Set(
    [...areaSymbols(areaPath)]
      .map(normSymbol)
      .filter((n) => n.length >= MIN_DERIVED_SYMBOL),
  );

/** Declared `symbols` replace the basename; an invalid entry matches nothing. */
function symbolsFor(area, areaPath, problems) {
  if (problems) return new Set();
  if (Array.isArray(area.symbols)) {
    return new Set(area.symbols.map(normSymbol).filter(Boolean));
  }
  return derivedSymbols(areaPath);
}

/** The first symbol a test name contains, or null. */
export const coveringSymbol = (testName, normSymbols) => {
  const normalized = normSymbol(testName);
  for (const sym of normSymbols) if (normalized.includes(sym)) return sym;
  return null;
};

export const nameCovers = (testName, normSymbols) =>
  coveringSymbol(testName, normSymbols) !== null;

/**
 * Everything matching and proximity need to know about one area, computed
 * once. `anchor` is the deepest significant directory name, or null when every
 * directory is generic (`src/engine.ts`).
 */
export function areaContext(area, problems) {
  const areaPath = typeof area?.path === 'string' ? area.path : '';
  const dirs = dirsOf(areaPath);
  const significant = dirs.filter((d) => !isGenericDir(d));
  const key = moduleKey(areaPath);
  return {
    path: areaPath,
    risk: Number.parseFloat(area?.risk_score) || 0.0,
    problems,
    syms: symbolsFor(area ?? {}, areaPath, problems),
    dirs,
    anchor: significant.length ? significant[significant.length - 1] : null,
    key,
    keySegs: key.split('/'),
    stem: stripCodeSuffix(basename(areaPath)).toLowerCase(),
  };
}
