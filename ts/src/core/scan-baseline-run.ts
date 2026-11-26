/**
 * The run contract of the scanner baseline (#1322): flags, exit codes and
 * reports. A port of `agents/skills/lib/scan-baseline-run.mjs`, so
 * `canary vacuity-check` answers exactly as canary-savant and canary-blackhawk
 * do; the format and comparison are `scan-baseline.ts`.
 *
 *   0  no finding outside the baseline (fixed findings never fail)
 *   1  a finding outside the baseline, or `--update-baseline` refused growth
 *   2  usage error, or a baseline file that is missing, unreadable or malformed
 *   3  the scan checked zero items -- an abstention, never a pass (#508)
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import { EXIT_ABSTAINED } from './gate-result.js';
import {
  buildBaseline,
  compareBaseline,
  identityOf,
  parseBaseline,
  serializeBaseline,
  type Baseline,
  type BaselineComparison,
  type BaselineEntry,
  type FindingIdentity,
} from './scan-baseline.js';

const EXIT_OK = 0;
const EXIT_NEW = 1;
const EXIT_USAGE = 2;

/** The longest list the text report prints before pointing at --json. */
const TEXT_LIST_LIMIT = 20;

const ABSTAINED_LINE =
  '\u{26A0} Abstained \u{2014} verified zero items; this is not a pass.';

/** The exit-code table a baseline-capable command appends to its --help. */
export const BASELINE_EXIT_HELP =
  '\nExit codes (with --baseline or --update-baseline):\n' +
  '  0  no finding outside the baseline (fixed ones never fail)\n' +
  '  1  a finding outside the baseline, or growth refused\n' +
  '  2  usage error, or a missing or malformed baseline file\n' +
  '  3  the scan checked zero items: abstained, never a pass\n';

export interface BaselineOpts {
  baseline?: string;
  updateBaseline?: string;
  allowGrowth?: boolean;
}

type Verdict = 'abstained' | 'new' | 'clean' | 'growth-refused' | 'written';

export interface BaselineRun {
  mode: 'compare' | 'update';
  file: string;
  exitCode: number;
  error?: string;
  verdict?: Verdict;
  checked?: number;
  cmp?: BaselineComparison;
  initial?: boolean;
}

/** A usage error for an impossible flag combination, else null. */
export function baselineFlagError(opts: BaselineOpts): string | null {
  // An empty value (an unset CI variable) must not quietly mean "no baseline".
  if (opts.baseline === '' || opts.updateBaseline === '') {
    return 'a baseline flag needs a file path, got an empty value';
  }
  if (opts.baseline && opts.updateBaseline) {
    return 'argument --baseline: not allowed with --update-baseline';
  }
  if (opts.allowGrowth && !opts.updateBaseline) {
    return 'argument --allow-growth: only valid with --update-baseline';
  }
  return null;
}

function loadBaseline(
  file: string,
  tool: string,
  optional: boolean,
): { baseline?: Baseline; error?: string } {
  if (!existsSync(file)) {
    return optional ? {} : { error: `baseline file not found: ${file}` };
  }
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    return {
      error: `baseline file ${file} is unreadable (${(e as Error).message})`,
    };
  }
  const parsed = parseBaseline(text, tool);
  if (parsed.error) return { error: `baseline file ${file} ${parsed.error}` };
  return parsed;
}

function verdictFor(
  mode: BaselineRun['mode'],
  existing: Baseline | undefined,
  cmp: BaselineComparison,
  checked: number,
  allowGrowth: boolean,
): { verdict: Verdict; exitCode: number } {
  if (checked === 0) return { verdict: 'abstained', exitCode: EXIT_ABSTAINED };
  if (mode === 'compare') {
    return cmp.newCount
      ? { verdict: 'new', exitCode: EXIT_NEW }
      : { verdict: 'clean', exitCode: EXIT_OK };
  }
  if (existing && cmp.newCount && !allowGrowth) {
    return { verdict: 'growth-refused', exitCode: EXIT_NEW };
  }
  return { verdict: 'written', exitCode: EXIT_OK };
}

/**
 * Run the baseline contract for one scan, or return null when no baseline
 * flag was given. `findings` are raw identities; each is normalized with
 * {@link identityOf} here. Reads and, in update mode, writes the baseline
 * file; the result's `exitCode` is the command's exit code.
 */
export function runBaseline(
  tool: string,
  opts: BaselineOpts,
  checked: number,
  findings: FindingIdentity[],
): BaselineRun | null {
  const identities = findings.map((f) => identityOf(f));
  const file = opts.updateBaseline ?? opts.baseline;
  if (!file) return null;
  const mode = opts.updateBaseline ? 'update' : 'compare';
  const loaded = loadBaseline(file, tool, mode === 'update');
  if (loaded.error) {
    return { mode, file, exitCode: EXIT_USAGE, error: loaded.error };
  }
  const existing = loaded.baseline;
  const cmp = compareBaseline(existing ?? buildBaseline(tool, []), identities);
  const v = verdictFor(mode, existing, cmp, checked, opts.allowGrowth === true);
  if (v.verdict === 'written') {
    writeFileSync(file, serializeBaseline(buildBaseline(tool, identities)));
  }
  return { mode, file, ...v, checked, cmp, initial: !existing };
}

/** The JSON block a command adds to its payload as `baseline`. */
export function baselineJson(r: BaselineRun): Record<string, unknown> {
  if (r.error || !r.cmp) return { file: r.file, mode: r.mode, error: r.error };
  return {
    file: r.file,
    mode: r.mode,
    verdict: r.verdict,
    checked: r.checked,
    new: r.cmp.newCount,
    fixed: r.cmp.fixedCount,
    baselined: r.cmp.baselined,
    entries: { new: r.cmp.new, fixed: r.cmp.fixed },
  };
}

function listLines(label: string, entries: BaselineEntry[]): string[] {
  const lines = entries
    .slice(0, TEXT_LIST_LIMIT)
    .map((e) => `  ${label}  ${e.file}  ${e.rule}  ${e.anchor} (x${e.count})`);
  const more = entries.length - TEXT_LIST_LIMIT;
  if (more > 0) lines.push(`  ... and ${more} more (--json lists all)`);
  return lines;
}

function verdictLine(r: BaselineRun, cmp: BaselineComparison): string {
  switch (r.verdict) {
    case 'abstained':
      return `${ABSTAINED_LINE} The baseline was not compared.`;
    case 'new':
      return (
        `${cmp.newCount} finding(s) not in the baseline. Fix them, or accept ` +
        `them with --update-baseline ${r.file} --allow-growth.`
      );
    case 'clean':
      return cmp.fixedCount
        ? `No new findings. ${cmp.fixedCount} fixed: run --update-baseline ` +
            `${r.file} to shrink the baseline.`
        : 'No new findings.';
    case 'growth-refused':
      return (
        `Refused: ${cmp.newCount} new finding(s) would grow ${r.file}. ` +
        'Pass --allow-growth to accept them.'
      );
    default:
      return `Baseline written to ${r.file}.`;
  }
}

/** The human-readable report a command prints after its own output. */
export function renderBaselineText(r: BaselineRun): string {
  const cmp = r.cmp;
  if (r.error || !cmp) return `baseline: ${r.error ?? 'not run'}`;
  const head =
    `Baseline ${r.file}: ${r.checked} checked, ${cmp.baselined} baselined, ` +
    `${cmp.newCount} new, ${cmp.fixedCount} fixed.`;
  const showNew = !(r.verdict === 'written' && r.initial);
  return [
    head,
    ...(showNew ? listLines('NEW  ', cmp.new) : []),
    ...listLines('FIXED', cmp.fixed),
    verdictLine(r, cmp),
  ].join('\n');
}
