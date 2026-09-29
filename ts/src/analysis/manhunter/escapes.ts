/**
 * Escape-history section (#611): defects found after release.
 *
 * Canary holds no incident data (STRATEGY.md, Key metrics: the escaped-defect
 * ratio "requires an incident-data join canary does not hold today -- tracked
 * manually at first"). So this section reads a hand-kept log:
 *
 *   .canary/escapes.json
 *   { "schema_version": 1, "tracked_since": "2026-07-01",
 *     "escapes": [{ "id": "ESC-1", "summary": "...", "found_at": "2026-08-02" }] }
 *
 * `tracked_since` is the denominator. Without it an empty list cannot say
 * whether nothing escaped or nobody was counting, so the section is DARK.
 */

import { parseJsonSource, readSource, sourceRef } from './sources.js';
import { darkSection, fedSection, isRecord, type Section } from './types.js';

function escapeLine(raw: unknown): string {
  const e = isRecord(raw) ? raw : {};
  const field = (k: string, fallback: string) =>
    typeof e[k] === 'string' && e[k] !== '' ? e[k] : fallback;
  return `${field('id', '(no id)')}: ${field('summary', '(no summary)')} (found ${field('found_at', 'date unknown')})`;
}

/** `YYYY-MM-DD`, optionally with a time: Date.parse alone accepts "1". */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:\d{2})?)?$/;

export function escapesSection(path: string): Section {
  const read = readSource(path);
  const ref = sourceRef(read);
  if (read.kind === 'missing') {
    return darkSection(
      'escapes',
      [ref],
      `no escape log at ${path}; canary holds no incident data, so escapes must be recorded by hand (see docs/guides/release-dossier.md)`,
    );
  }
  const parsed = parseJsonSource(read);
  if (!parsed.ok) return darkSection('escapes', [ref], parsed.reason);
  const log = isRecord(parsed.value) ? parsed.value : {};
  const since = typeof log.tracked_since === 'string' ? log.tracked_since : '';
  if (!ISO_DATE.test(since) || !Array.isArray(log.escapes)) {
    return darkSection(
      'escapes',
      [ref],
      `${path} needs a tracked_since ISO date (YYYY-MM-DD) and an escapes array; without them "none escaped" and "nobody counted" look the same`,
    );
  }
  const n = log.escapes.length;
  return fedSection('escapes', {
    sources: [ref],
    denominator: `tracked since ${since}`,
    facts: [`${n} escape${n === 1 ? '' : 's'} recorded since ${since}`],
    eyes: log.escapes.map(escapeLine),
  });
}
