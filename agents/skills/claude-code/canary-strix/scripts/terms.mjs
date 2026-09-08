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

/**
 * Terms from a comma- or newline-separated source.
 *
 * Comments are stripped PER LINE, before the comma split. The order matters
 * and getting it wrong is #818: splitting on `[,\n]` first meant a comment
 * line containing a comma survived in part — the fragment before the comma
 * starts with `#` and is dropped, but every fragment after one does not, and
 * was kept as a denylist term. This repo's own `.proprietary-denylist` has a
 * commented header, so 8 of the 15 terms it appeared to declare were
 * fragments of its own prose. One of them was `and on a`, which matched three
 * innocent files and reported them as company identifiers.
 *
 * Two harms, and the second is worse: a leak gate that cries wolf on the word
 * "and" is an alarm nobody reads, and the run summary said `15 term(s)` when
 * seven were real — an inflated denominator on the last line of defence
 * before a company name reaches a public repo.
 */
function split(raw) {
  return String(raw)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .flatMap((line) => line.split(','))
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
/**
 * Terms that do not look like an identifier anyone would need to hide.
 *
 * Defence in depth for #818, independent of the parser that produced it: the
 * eight phantom terms leaked from comment prose were all three-or-more
 * all-lowercase words, and this would have caught every one of them without
 * knowing anything about comments. A company, client or consumer name is one
 * or two tokens, or carries capitals; `and from this file at the` is neither.
 *
 * Reported, never dropped. A consumer could legitimately declare an odd
 * phrase, and silently discarding a term from a leak gate is a worse failure
 * than flagging a suspicious one. The caller surfaces the COUNT and shape, not
 * the values -- these are the names the scan exists to keep out of a public
 * repo, and the warning goes to a CI log.
 */
function implausibleTerms(terms) {
  return terms.filter((t) => {
    const words = t.split(/\s+/).filter(Boolean);
    return words.length >= 3 && t === t.toLowerCase();
  });
}

/**
 * @returns {{terms: string[], sources: string[], committedSource: boolean, implausible: string[]}}
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

  const sorted = [...terms].sort();
  return {
    terms: sorted,
    sources,
    committedSource,
    implausible: implausibleTerms(sorted),
  };
}
