/**
 * Pure scoring for `canary critical-areas` (#1529): the skill's formula with
 * business_critical removed and redistributed, because at the skill's weights
 * the maximum is 0.70 and katana's CRITICAL_RISK would be all but unreachable.
 */
export const MAX_AREAS = 25;
export const CHURN_WINDOW_DAYS = 90;

export interface FileSignals {
  path: string;
  /** `null` is unmeasured (a shallow clone), never "no commits". */
  churn: number | null;
  importers: number;
  /** 0-100; `null` is unmeasured, never 0%. */
  coveragePct: number | null;
}

export interface SignalSource {
  status: 'measured' | 'absent';
  reason?: string;
  window_days?: number;
  report?: string;
  files_matched?: number;
}

export interface DocumentInput {
  generated: string;
  base: string;
  /** Candidates: they alone set the maxima and count as analyzed. */
  files: FileSignals[];
  /** Kept-symbols paths in HEAD that are not candidates. */
  extras: FileSignals[];
  symbols: ReadonlyMap<string, string[]>;
  sources: Record<'churn' | 'importers' | 'coverage', SignalSource>;
}

interface Maxima {
  churn: number;
  importers: number;
}

const round = (n: number, places: number): number =>
  Math.round(n * 10 ** places) / 10 ** places;
const ratio = (value: number, max: number): number =>
  max > 0 ? Math.min(1, value / max) : 0;
const atLeastHalf = (value: number | null, max: number): boolean =>
  value !== null && value > 0 && value >= max / 2;

function maximaOf(files: FileSignals[]): Maxima {
  return {
    churn: Math.max(0, ...files.map((f) => f.churn ?? 0)),
    importers: Math.max(0, ...files.map((f) => f.importers)),
  };
}

/** Shallow clones have no churn, so importers carry the whole weight (D9). */
function baseScore(file: FileSignals, max: Maxima): number {
  const importers = ratio(file.importers, max.importers);
  if (file.churn === null) return importers;
  return 0.5 * ratio(file.churn, max.churn) + 0.5 * importers;
}

function riskScore(file: FileSignals, max: Maxima): number {
  const base = baseScore(file, max);
  // Untested alone is not critical: the boost needs another signal (D4).
  if (base === 0) return 0;
  const boost =
    file.coveragePct === null ? 0 : 0.15 * (1 - file.coveragePct / 100);
  return round(Math.min(1, base + boost), 2);
}

function signalsOf(file: FileSignals, max: Maxima): string[] {
  const signals: string[] = [];
  if (atLeastHalf(file.churn, max.churn)) signals.push('high_churn');
  if (atLeastHalf(file.importers, max.importers)) {
    signals.push('many_dependents');
  }
  if (file.coveragePct !== null && file.coveragePct < 50) {
    signals.push('low_coverage');
  }
  return signals;
}

function summaryOf(file: FileSignals): string {
  const churn =
    file.churn === null
      ? 'churn not measured'
      : `${file.churn} commits in ${CHURN_WINDOW_DAYS} days`;
  const coverage =
    file.coveragePct === null
      ? 'coverage not measured'
      : `coverage ${file.coveragePct}%`;
  return `${churn}, ${file.importers} importers, ${coverage}`;
}

function areaOf(file: FileSignals, max: Maxima, symbols: string[] | undefined) {
  const score = riskScore(file, max);
  const signals = signalsOf(file, max);
  return {
    path: file.path,
    risk_score: score,
    rank_score: score,
    signals,
    recommended_test_types: signals.includes('many_dependents')
      ? ['unit', 'integration']
      : ['unit'],
    summary: summaryOf(file),
    churn_commits: file.churn,
    importers: file.importers,
    coverage_pct: file.coveragePct,
    ...(symbols === undefined ? {} : { symbols }),
  };
}

type Area = ReturnType<typeof areaOf>;

const byRank = (a: Area, b: Area): number =>
  b.risk_score - a.risk_score || (a.path < b.path ? -1 : 1);

/**
 * The top scored candidates, plus any path a person gave symbols to (D5, D13).
 * An extra is listed for its symbols alone, so it never takes a top slot.
 */
export function buildDocument(input: DocumentInput) {
  const { files, extras, symbols } = input;
  const max = maximaOf(files);
  const toArea = (f: FileSignals) => areaOf(f, max, symbols.get(f.path));
  const candidates = files.map(toArea).sort(byRank);
  const scored = candidates.filter((a) => a.risk_score > 0);
  const top = new Set(scored.slice(0, MAX_AREAS).map((a) => a.path));
  const ranked = [...candidates, ...extras.map(toArea)].sort(byRank);
  return {
    generated: input.generated,
    base: input.base,
    generator: 'canary critical-areas',
    files_analyzed: files.length,
    signal_sources: input.sources,
    // No score means nothing to rank, so symbols alone do not make a map.
    areas:
      scored.length > 0
        ? ranked.filter((a) => top.has(a.path) || a.symbols !== undefined)
        : [],
  };
}
