/**
 * Guardian sections (#611): coverage tiers and open findings, read from the
 * analysis records `canary guardian pr-check` writes to `.harness/analyses/`
 * (`canary-pr-guardian-<ref>.json`, producer contract v1.x).
 *
 * The records are parsed as JSON with the minimal shape below rather than by
 * importing guardian's types: the `analysis` layer may not depend on
 * `guardian`, and a file format is a contract, not a module.
 *
 * The denominator is units CHECKED across records that did not abstain. Zero
 * findings over 80 checked units is a clean result; zero findings over zero
 * checked units is no result, and both sections go DARK.
 */

import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { parseJsonSource, readSource, sourceRef } from './sources.js';
import {
  darkSection,
  fedSection,
  isRecord,
  type Section,
  type SourceRef,
} from './types.js';

const RECORD_PREFIX = 'canary-pr-guardian-';
const FIDELITIES = ['coverage-verified', 'graph-verified', 'heuristic'];

interface GuardianFinding {
  path: string;
  unit: string;
  severity: string;
  fidelity: string;
  evidence: string;
  suppressed: boolean;
}

interface GuardianRecord {
  ref: string;
  checked: number;
  abstained: boolean;
  coverageStatus: string | null;
  byFidelity: Record<string, number>;
  findings: GuardianFinding[];
}

interface Loaded {
  sources: SourceRef[];
  records: GuardianRecord[];
  unreadable: number;
}

const str = (v: unknown, fallback = ''): string =>
  typeof v === 'string' ? v : fallback;
const num = (v: unknown): number => (typeof v === 'number' ? v : 0);

function toFinding(raw: unknown): GuardianFinding {
  const f = isRecord(raw) ? raw : {};
  return {
    path: str(f.path, '?'),
    unit: str(f.unit),
    severity: str(f.severity, 'unknown'),
    fidelity: str(f.fidelity, 'unknown'),
    evidence: str(f.evidence),
    suppressed: f.suppressed === true,
  };
}

function toRecord(raw: Record<string, unknown>): GuardianRecord {
  const summary = isRecord(raw.summary) ? raw.summary : {};
  const coverage = isRecord(raw.coverage) ? raw.coverage : null;
  const byFidelity = isRecord(summary.byFidelity) ? summary.byFidelity : {};
  return {
    ref: str(raw.ref, 'unknown-ref'),
    checked: num(raw.checked),
    abstained: raw.abstained === true,
    coverageStatus: coverage === null ? null : str(coverage.status, 'unknown'),
    byFidelity: Object.fromEntries(
      Object.entries(byFidelity).map(([k, v]) => [k, num(v)]),
    ),
    findings: Array.isArray(raw.findings) ? raw.findings.map(toFinding) : [],
  };
}

function recordFiles(dir: string): string[] | null {
  try {
    return readdirSync(dir)
      .filter((n) => n.startsWith(RECORD_PREFIX) && n.endsWith('.json'))
      .sort();
  } catch {
    return null;
  }
}

function loadRecords(dir: string, names: string[]): Loaded {
  const loaded: Loaded = { sources: [], records: [], unreadable: 0 };
  for (const name of names) {
    const read = readSource(join(dir, name));
    loaded.sources.push(sourceRef(read));
    const parsed = parseJsonSource(read);
    if (parsed.ok && isRecord(parsed.value)) {
      loaded.records.push(toRecord(parsed.value));
    } else {
      loaded.unreadable += 1;
    }
  }
  return loaded;
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

function tiersBody(usable: GuardianRecord[]): {
  facts: string[];
  eyes: string[];
} {
  const totals = new Map<string, number>();
  for (const r of usable) {
    for (const [k, v] of Object.entries(r.byFidelity)) {
      totals.set(k, (totals.get(k) ?? 0) + v);
    }
  }
  const total = usable.reduce((n, r) => n + r.findings.length, 0);
  const mix = FIDELITIES.map((f) => `${f}: ${totals.get(f) ?? 0}`).join(', ');
  const heuristic = totals.get('heuristic') ?? 0;
  const eyes = usable
    .filter((r) => r.coverageStatus !== 'verified')
    .map(
      (r) =>
        `${r.ref}: coverage input ${r.coverageStatus ?? 'not recorded'}, so part of that diff was judged below the coverage tier`,
    );
  if (heuristic > 0) {
    eyes.push(
      `${heuristic} of ${plural(total, 'finding')} rest on heuristic evidence only`,
    );
  }
  return { facts: [`${mix} (of ${plural(total, 'finding')})`], eyes };
}

function findingsBody(usable: GuardianRecord[]): {
  facts: string[];
  eyes: string[];
} {
  const all = usable.flatMap((r) => r.findings.map((f) => ({ r, f })));
  const open = all.filter(({ f }) => !f.suppressed);
  return {
    facts: [
      `${plural(all.length, 'finding')}: ${open.length} unaddressed, ${all.length - open.length} suppressed`,
    ],
    eyes: open.map(
      ({ r, f }) =>
        `${r.ref}: ${f.path} ${f.unit} (${f.severity}, ${f.fidelity}): ${f.evidence}`,
    ),
  };
}

function darkBoth(sources: SourceRef[], reason: string): [Section, Section] {
  return [
    darkSection('coverage-tiers', sources, reason),
    darkSection('guardian-findings', sources, reason),
  ];
}

function darkReason(dir: string, loaded: Loaded): string {
  if (loaded.records.length === 0) {
    return `${plural(loaded.unreadable, 'guardian record')} in ${dir}, none readable`;
  }
  return (
    `${plural(loaded.records.length, 'guardian record')} in ${dir}, but every one ` +
    'abstained or judged nothing (0 units checked)'
  );
}

/** `[coverage-tiers, guardian-findings]`, sharing one read of the records. */
export function guardianSections(dir: string): [Section, Section] {
  const names = recordFiles(dir);
  if (names === null || names.length === 0) {
    return darkBoth(
      [],
      `no guardian analysis records (${RECORD_PREFIX}*.json) in ${dir}`,
    );
  }
  const loaded = loadRecords(dir, names);
  const usable = loaded.records.filter((r) => !r.abstained && r.checked > 0);
  if (usable.length === 0)
    return darkBoth(loaded.sources, darkReason(dir, loaded));
  const checked = usable.reduce((n, r) => n + r.checked, 0);
  const denominator = `${plural(usable.length, 'record')}, ${checked} units checked`;
  const unreadable =
    loaded.unreadable > 0
      ? [`${loaded.unreadable} record(s) unreadable and not counted`]
      : [];
  const tiers = tiersBody(usable);
  const findings = findingsBody(usable);
  return [
    fedSection('coverage-tiers', {
      sources: loaded.sources,
      denominator,
      facts: [...tiers.facts, ...unreadable],
      eyes: tiers.eyes,
    }),
    fedSection('guardian-findings', {
      sources: loaded.sources,
      denominator,
      facts: [...findings.facts, ...unreadable],
      eyes: findings.eyes,
    }),
  ];
}
