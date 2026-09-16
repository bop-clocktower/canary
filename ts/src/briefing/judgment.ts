/**
 * Judgment half of the mission-briefing charter (#593, criterion 9).
 *
 * The skill writes judgment; this module decides what of it the charter may
 * carry. An item that does not cite a changed line is dropped, not trusted,
 * so "every item cites a line inside the added ranges" is enforced by code
 * rather than hoped for from a prompt.
 */
import type { BriefingUnit } from './facts.js';

/** The six categories named by canary-edge-case-discovery's SKILL.md. */
export const EDGE_CASE_CATEGORIES = [
  'Boundary values',
  'Race conditions',
  'Locale and timezone',
  'Partial network',
  'Unexpected input shapes',
  'Accessibility',
] as const;

export interface RawItem {
  text?: unknown;
  cite?: unknown;
  category?: unknown;
}
export interface Judgment {
  mission: string;
  verify: RawItem[];
  edge_cases: RawItem[];
}

function arrayField(
  o: Record<string, unknown>,
  key: string,
): RawItem[] | string {
  const v = o[key];
  if (v === undefined) return [];
  return Array.isArray(v) ? (v as RawItem[]) : `'${key}' is not an array`;
}

/** Parse skill-written judgment JSON; a string return is the reason it was rejected. */
export function parseJudgment(raw: string): Judgment | string {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return 'judgment is not valid JSON';
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return 'judgment is not a JSON object';
  }
  const o = data as Record<string, unknown>;
  if (typeof o['mission'] !== 'string')
    return "'mission' is missing or not a string";
  const verify = arrayField(o, 'verify');
  if (typeof verify === 'string') return verify;
  const edge = arrayField(o, 'edge_cases');
  if (typeof edge === 'string') return edge;
  return { mission: o['mission'], verify, edge_cases: edge };
}

type EdgeCaseCategory = (typeof EDGE_CASE_CATEGORIES)[number];
interface VerifyItem {
  text: string;
  cite: string;
}
interface EdgeCaseItem extends VerifyItem {
  category: EdgeCaseCategory;
}
export interface DroppedItem {
  section: 'verify' | 'edge_cases';
  text: string;
  cite: string | null;
  reason: string;
}
export interface JudgmentResult {
  mission: string;
  verify: VerifyItem[];
  edge_cases: EdgeCaseItem[];
  dropped: DroppedItem[];
}

/** `path:line` with a 1-based line; compiled once rather than per item. */
const CITE_PATTERN = /^(.+):([1-9]\d*)$/;

/** Why a cite is unusable for `units`, or null when it lands on an added line. */
function citeProblem(cite: unknown, units: BriefingUnit[]): string | null {
  if (typeof cite !== 'string' || cite.trim() === '') return 'no citation';
  const m = CITE_PATTERN.exec(cite.trim());
  if (m === null) return 'citation is not path:line';
  const unit = units.find((u) => u.path === m[1]);
  if (unit === undefined) return 'cites a file outside this charter';
  const line = Number(m[2]);
  const inside = unit.added_ranges.some(([s, e]) => line >= s && line <= e);
  return inside ? null : 'cites a line outside the added ranges';
}

function itemProblem(item: RawItem, units: BriefingUnit[]): string | null {
  if (typeof item.text !== 'string' || item.text.trim() === '')
    return 'no text';
  return citeProblem(item.cite, units);
}

function dropped(
  section: DroppedItem['section'],
  item: RawItem,
  reason: string,
): DroppedItem {
  return {
    section,
    text: typeof item.text === 'string' ? item.text : '',
    cite: typeof item.cite === 'string' ? item.cite : null,
    reason,
  };
}

function unitRank(cite: string, units: BriefingUnit[]): number {
  return units.findIndex((u) => cite.startsWith(`${u.path}:`));
}

function isCategory(c: unknown): c is EdgeCaseCategory {
  return (EDGE_CASE_CATEGORIES as readonly unknown[]).includes(c);
}

/** Keep only items citing a changed line; everything else is dropped with a reason. */
export function applyJudgment(
  j: Judgment,
  units: BriefingUnit[],
): JudgmentResult {
  const result: JudgmentResult = {
    mission: j.mission.trim(),
    verify: [],
    edge_cases: [],
    dropped: [],
  };
  for (const item of j.verify) {
    const problem = itemProblem(item, units);
    if (problem !== null) result.dropped.push(dropped('verify', item, problem));
    else
      result.verify.push({
        text: item.text as string,
        cite: (item.cite as string).trim(),
      });
  }
  for (const item of j.edge_cases) {
    const problem = isCategory(item.category)
      ? itemProblem(item, units)
      : 'unknown edge-case category';
    if (problem !== null)
      result.dropped.push(dropped('edge_cases', item, problem));
    else
      result.edge_cases.push({
        category: item.category as EdgeCaseCategory,
        text: item.text as string,
        cite: (item.cite as string).trim(),
      });
  }
  // Array.prototype.sort is stable, so the skill's order holds within a unit.
  result.verify.sort(
    (a, b) => unitRank(a.cite, units) - unitRank(b.cite, units),
  );
  return result;
}
