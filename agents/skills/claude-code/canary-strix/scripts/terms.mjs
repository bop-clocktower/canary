// Where a consumer's denylist terms come from.
//
// Three sources, unioned, because a consumer's repo may be public or private
// and the right answer differs:
//
//   1. CANARY_PROPRIETARY_DENYLIST env   -- a CI secret. The only source that
//      never lands in the repo, so it is the one a PUBLIC repo must use.
//   2. .proprietary-denylist (gitignored) -- the same list at the desk, so the
//      pre-commit path catches a term before a push rather than after one.
//   3. .canary/company.json               -- committed, and therefore only
//      appropriate for a PRIVATE repo.
//
// (3) is the convenient one and the one to warn about: a committed denylist on
// a public repo publishes precisely the list of things being hidden. The loader
// reports which sources it read so a caller can say so out loud.
//
// Separators: comma OR newline. Newline matters — GitHub masks a multi-line
// secret line by line, so one term per line means each term is masked
// individually in a log. A comma-joined value is masked only as the whole
// string, which is not the form that ever appears in output.

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const DENYLIST_ENV = 'CANARY_PROPRIETARY_DENYLIST';
export const DENYLIST_FILE = '.proprietary-denylist';
export const COMPANY_FILE = '.canary/company.json';
/** The company.json key. Array of strings. */
export const COMPANY_KEY = 'proprietary_denylist';

function split(raw) {
  return String(raw)
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith('#'));
}

/**
 * @returns {{terms: string[], sources: string[], committedSource: boolean}}
 *   `committedSource` is true when a term came from a file that is tracked,
 *   which is the shape a caller should warn about on a public repo.
 */
export function loadTerms(root, env = process.env) {
  const terms = new Set();
  const sources = [];

  const fromEnv = split(env[DENYLIST_ENV] ?? '');
  if (fromEnv.length) {
    fromEnv.forEach((t) => terms.add(t));
    sources.push(DENYLIST_ENV);
  }

  const file = resolve(root, DENYLIST_FILE);
  if (existsSync(file)) {
    const fromFile = split(readFileSync(file, 'utf-8'));
    if (fromFile.length) {
      fromFile.forEach((t) => terms.add(t));
      sources.push(DENYLIST_FILE);
    }
  }

  let committedSource = false;
  const company = resolve(root, COMPANY_FILE);
  if (existsSync(company)) {
    try {
      const parsed = JSON.parse(readFileSync(company, 'utf-8'));
      const raw = parsed?.[COMPANY_KEY];
      const fromCompany = Array.isArray(raw) ? split(raw.join('\n')) : [];
      if (fromCompany.length) {
        fromCompany.forEach((t) => terms.add(t));
        sources.push(COMPANY_FILE);
        committedSource = true;
      }
    } catch {
      // A malformed company.json is the consuming repo's problem to surface,
      // not this scan's to guess at. Recorded as a source that yielded nothing
      // rather than silently treated as absent.
      sources.push(`${COMPANY_FILE} (unreadable)`);
    }
  }

  return { terms: [...terms].sort(), sources, committedSource };
}
