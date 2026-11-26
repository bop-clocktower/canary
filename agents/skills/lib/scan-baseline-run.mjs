// The run contract of the shared scanner baseline (#1322): the flags, the
// exit codes and the reports every baseline-capable CLI shares. The file
// format, identity and comparison live in scan-baseline.mjs; see its header
// for why the baseline exists and how a finding is keyed.
//
// ## Exit codes
//
//   0  no finding outside the baseline (fixed findings never fail)
//   1  a finding outside the baseline; or --update-baseline refused growth
//   2  usage error, or a baseline file that is missing, unreadable or malformed
//   3  the scan checked zero items -- an abstention, never a pass (#508)
//
// Standard library only, every Node global imported (lib-portability.test.ts).

import fs from 'node:fs';

import {
  buildBaseline,
  compareBaseline,
  identityOf,
  parseBaseline,
  serializeBaseline,
} from './scan-baseline.mjs';

const EXIT_OK = 0;
const EXIT_NEW = 1;
const EXIT_USAGE = 2;
const EXIT_ABSTAINED = 3;

/** The longest list the text report prints before pointing at --json. */
const TEXT_LIST_LIMIT = 20;

const ABSTAINED_LINE =
  '\u{26A0} Abstained \u{2014} verified zero items; this is not a pass.';

/** Help text every baseline-capable CLI appends, so the table cannot drift. */
export const BASELINE_HELP =
  'baseline:\n' +
  '  --baseline FILE         fail only on findings FILE does not hold\n' +
  '  --update-baseline FILE  write FILE from this scan (refuses growth)\n' +
  '  --allow-growth          let --update-baseline add new findings\n' +
  '\n' +
  'exit codes (with --baseline or --update-baseline):\n' +
  '  0  no finding outside the baseline (fixed ones never fail)\n' +
  '  1  a finding outside the baseline, or growth refused\n' +
  '  2  usage error, or a missing or malformed baseline file\n' +
  '  3  the scan checked zero items: abstained, never a pass';

/**
 * The flags a baseline-capable skill CLI spreads into its parse-args spec, so
 * every skill spells them the same way.
 */
export const BASELINE_FLAGS = {
  booleans: { '--allow-growth': 'allowGrowth' },
  values: {
    '--baseline': { key: 'baseline' },
    '--update-baseline': { key: 'updateBaseline' },
  },
};

/** A usage error for an impossible flag combination, else null. */
export function baselineFlagError(opts) {
  if (opts.baseline && opts.updateBaseline) {
    return 'argument --baseline: not allowed with --update-baseline';
  }
  if (opts.allowGrowth && !opts.updateBaseline) {
    return 'argument --allow-growth: only valid with --update-baseline';
  }
  return null;
}

/** Whether any baseline flag was given, i.e. the baseline contract applies. */
function baselineRequested(opts) {
  return Boolean(opts.baseline || opts.updateBaseline);
}

function loadBaseline(file, tool, optional) {
  if (!fs.existsSync(file)) {
    return optional ? {} : { error: `baseline file not found: ${file}` };
  }
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return { error: `baseline file ${file} is unreadable (${e.message})` };
  }
  const parsed = parseBaseline(text, tool);
  if (parsed.error) return { error: `baseline file ${file} ${parsed.error}` };
  return parsed;
}

function verdictFor(mode, existing, cmp, checked, allowGrowth) {
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
 * Run the baseline contract for one scan.
 *
 * `opts` carries the parsed flags `{baseline, updateBaseline, allowGrowth}`,
 * `checked` the scan's denominator, `identities` one entry per finding (from
 * {@link identityOf}). Reads and, in update mode, writes the baseline file.
 * The result's `exitCode` is the command's exit code.
 */
function runBaseline({ tool, opts, checked, identities }) {
  const mode = opts.updateBaseline ? 'update' : 'compare';
  const file = opts.updateBaseline || opts.baseline;
  const loaded = loadBaseline(file, tool, mode === 'update');
  if (loaded.error) {
    return { mode, file, exitCode: EXIT_USAGE, error: loaded.error };
  }
  const existing = loaded.baseline;
  const cmp = compareBaseline(existing ?? buildBaseline(tool, []), identities);
  const v = verdictFor(mode, existing, cmp, checked, opts.allowGrowth);
  if (v.verdict === 'written') {
    fs.writeFileSync(file, serializeBaseline(buildBaseline(tool, identities)));
  }
  return { mode, file, ...v, checked, cmp, initial: !existing };
}

/** The JSON block a CLI adds to its payload as `baseline`. */
export function baselineJson(r) {
  if (r.error) return { file: r.file, mode: r.mode, error: r.error };
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

function listLines(label, entries) {
  const lines = entries
    .slice(0, TEXT_LIST_LIMIT)
    .map((e) => `  ${label}  ${e.file}  ${e.rule}  ${e.anchor} (x${e.count})`);
  const more = entries.length - TEXT_LIST_LIMIT;
  if (more > 0) lines.push(`  ... and ${more} more (--json lists all)`);
  return lines;
}

const VERDICT_LINE = {
  abstained: () => `${ABSTAINED_LINE} The baseline was not compared.`,
  new: (r) =>
    `${r.cmp.newCount} finding(s) not in the baseline. Fix them, or accept ` +
    `them with --update-baseline ${r.file} --allow-growth.`,
  clean: (r) =>
    r.cmp.fixedCount
      ? `No new findings. ${r.cmp.fixedCount} fixed: run --update-baseline ` +
        `${r.file} to shrink the baseline.`
      : 'No new findings.',
  'growth-refused': (r) =>
    `Refused: ${r.cmp.newCount} new finding(s) would grow ${r.file}. ` +
    'Pass --allow-growth to accept them.',
  written: (r) => `Baseline written to ${r.file}.`,
};

/** The human-readable baseline report a CLI prints after its own output. */
function renderBaselineText(r) {
  if (r.error) return `baseline: ${r.error}`;
  const { checked, cmp } = r;
  const head =
    `Baseline ${r.file}: ${checked} checked, ${cmp.baselined} baselined, ` +
    `${cmp.newCount} new, ${cmp.fixedCount} fixed.`;
  const showNew = !(r.verdict === 'written' && r.initial);
  const lines = [
    head,
    ...(showNew ? listLines('NEW  ', cmp.new) : []),
    ...listLines('FIXED', cmp.fixed),
    VERDICT_LINE[r.verdict](r),
  ];
  return lines.join('\n');
}

/**
 * The ratchet run for a skill scan result (`{findings, filesScanned}`, each
 * finding `{file, ruleId, snippet}`), or null when no baseline flag was given.
 * The snippet is the anchor: the scanners' line text is what survives an
 * insertion above it.
 */
export function skillBaseline(tool, opts, result) {
  if (!baselineRequested(opts)) return null;
  return runBaseline({
    tool,
    opts,
    checked: result.filesScanned,
    identities: result.findings.map((f) =>
      identityOf({ file: f.file, rule: f.ruleId, anchor: f.snippet }),
    ),
  });
}

/** `text` with the baseline report appended, when there is one. */
export function withBaselineText(text, r) {
  return r ? `${text}\n\n${renderBaselineText(r)}` : text;
}
