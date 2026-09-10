#!/usr/bin/env node
/**
 * Performance ratchet (#717).
 *
 * Reads the output of `harness check-perf` and compares its violation count
 * against the triaged baseline in `.harness/perf-baseline.json`. Above the
 * baseline, the build fails.
 *
 * Why this exists: `check-perf` ran in no workflow, so its 237 violations at
 * 8c865b5 protected nothing. Same wiring `entropy-ratchet.mjs` gave `harness
 * cleanup` in #544 — a ceiling that may fall and never rise — and a ratchet
 * rather than strict-at-zero because a gate that blocks every PR on day one
 * gets demoted to advisory within a week.
 *
 * ## Why the parse is defensive
 *
 * `check-perf` has no `--findings-json`, so this parses human-readable output:
 *
 *     x Validation failed (237 issues)   <- carries its own denominator
 *     v validation passed                <- carries NOTHING
 *
 * A clean tree prints the second line. So does a run that measured nothing —
 * and so do `--coupling` and `--size`, which report a pass over the findings
 * that are their own subject (ADR 0014). Hence two guards, neither sufficient
 * alone: an IMPLAUSIBLE ZERO is an abstention here (`isImplausibleCollapse`),
 * and `ts/test/workflow-false-green.test.ts` asserts the wired invocation
 * carries no narrowing flag.
 *
 * ## Two rules, not one (#812, porting #703)
 *
 * An absolute ceiling makes headroom a shared, non-renewable budget no branch
 * can see, so two independently-green branches collide and whichever merges
 * second is blamed for violations it did not add. The perf ceiling reached
 * zero headroom on 2026-09-09 (233 measured against 233). When the caller
 * supplies `--base-report` — the same check run against the PR's merge base —
 * this also fails on the delta the branch itself introduced, which is
 * order-independent. The ceiling stays as a BACKSTOP; either rule can fail.
 * The workflow must scan both sides with the same resolved CLI and keep the
 * base worktree outside the checkout; `ts/test/perf-ratchet.test.ts` asserts
 * both against the YAML.
 *
 * Usage:
 *   harness check-perf > report.txt 2>&1 || true
 *   node scripts/perf-ratchet.mjs --report report.txt \
 *     [--base-report base-report.txt] [--cli-version 12.6.0]
 *
 * Exit codes follow the repo's gate convention (#508):
 *   0 = verified — at or under the baseline, and at or under the merge base
 *   1 = the ratchet fired — violations grew past the baseline or the base
 *   2 = error — the baseline file is missing or unreadable
 *   3 = ABSTENTION — nothing was measured on either side, or a zero is
 *       implausible. A base that could not be measured is not a base of zero.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_BASELINE = join(REPO_ROOT, '.harness', 'perf-baseline.json');

/**
 * Slack above which the baseline is stale enough to mention. Never a failure:
 * a codebase that got better must not turn the build red.
 */
const NUDGE_SLACK = 20;

/**
 * Below this baseline the implausible-collapse guard switches off: a handful
 * of violations can legitimately clear in one change, and refusing to believe
 * a real zero would make the gate impossible to ever satisfy.
 */
const COLLAPSE_GUARD_MIN_BASELINE = 20;

/**
 * The fraction of the baseline below which a sudden drop reads as a check that
 * stopped measuring rather than a codebase that improved. Deliberately loose:
 * a real paydown is a few percent (296 -> 281 on 2026-08-13), so removing
 * three quarters of the findings in one step is not a paydown.
 */
const COLLAPSE_RATIO = 0.25;

function parseArgs(argv) {
  const args = {
    report: null,
    baseReport: null,
    baseline: DEFAULT_BASELINE,
    cliVersion: null,
    reportRoot: null,
    baseReportRoot: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--report') args.report = argv[i + 1];
    else if (argv[i] === '--base-report') args.baseReport = argv[i + 1];
    else if (argv[i] === '--baseline') args.baseline = argv[i + 1];
    else if (argv[i] === '--cli-version') args.cliVersion = argv[i + 1];
    else if (argv[i] === '--report-root') args.reportRoot = argv[i + 1];
    else if (argv[i] === '--base-report-root')
      args.baseReportRoot = argv[i + 1];
  }
  return args;
}

/**
 * Pull the violation count out of a `harness check-perf` run.
 *
 * Returns the integer count, `0` for an explicit pass line, or `null` when the
 * output matches neither shape — which the caller must treat as an abstention,
 * never as zero. A bare `Validation failed` with no parseable count is `null`
 * too: a header that stopped carrying its denominator is an unmeasured run.
 */
function violationsFrom(text) {
  const failure = /Validation failed\s*\((\d+)\s+issues?\)/i.exec(text);
  if (failure) return Number.parseInt(failure[1], 10);
  if (/validation passed/i.test(text)) return 0;
  return null;
}

/**
 * Is this drop too steep to be real work? See `COLLAPSE_RATIO`. Only consulted
 * when the baseline is large enough for the question to be meaningful.
 */
function isImplausibleCollapse(violations, maxViolations) {
  if (maxViolations < COLLAPSE_GUARD_MIN_BASELINE) return false;
  return violations < maxViolations * COLLAPSE_RATIO;
}

function fail(code, message) {
  console.error(message);
  process.exit(code);
}

/**
 * The triaged ceiling, or exit 2. Read BEFORE the report: a broken baseline is
 * an operator error to fix in one file, an unmeasured run is a gate that did
 * not run, and resolving the baseline first keeps a 2 from surfacing as a 3.
 */
function readBaseline(baseline) {
  let maxViolations;
  let harnessCli = null;
  let allowances = [];
  try {
    const parsed = JSON.parse(readFileSync(baseline, 'utf8'));
    maxViolations = parsed.maxViolations;
    if (typeof parsed.harnessCli === 'string') harnessCli = parsed.harnessCli;
    allowances = parsed.deltaAllowances ?? [];
  } catch (err) {
    fail(2, `perf-ratchet: cannot read baseline ${baseline}: ${err.message}`);
  }
  if (!Number.isInteger(maxViolations)) {
    fail(2, `perf-ratchet: ${baseline} has no integer "maxViolations".`);
  }
  return {
    maxViolations,
    harnessCli,
    allowances: readAllowances(allowances, baseline),
  };
}

/**
 * Abstain unless the CLI that produced this report is the one the ceiling was
 * calibrated against (#744). The workflows pin a FLOATING major, so the
 * analyzer behind this absolute count changes with no commit here, and the
 * offline guards compare the baseline against itself. Deliberately NOT the
 * collapse guard's job: that catches a detector going dark, this catches an
 * instrument that is merely different — the quieter failure that happened.
 */
function requireMatchingInstrument(harnessCli, cliVersion, maxViolations) {
  if (harnessCli === null || cliVersion === harnessCli) return;
  fail(
    3,
    `perf-ratchet: ABSTAINED — this baseline's ${maxViolations} ceiling was ` +
      `calibrated against harness CLI ${harnessCli}, but ` +
      (cliVersion === null
        ? 'the caller did not say which version produced this report ' +
          '(pass `--cli-version`).'
        : `this report was produced by ${cliVersion}.`) +
      '\nThe measurement is therefore not comparable to the ceiling.\n' +
      'Re-measure in a clean worktree and update "measuredCount" and ' +
      '"harnessCli" in the baseline in the SAME PR. Do not silence this by ' +
      'deleting "harnessCli".',
  );
}

/**
 * The raw text of one report, or exit 3. `label` names which side this is —
 * one message for "head produced nothing" and "base produced nothing" is how
 * a delta gate goes dark with nobody able to tell which half. An unreadable
 * report is an ABSTENTION, not an error: the workflow step redirects stdout,
 * so a missing file means check-perf died before writing anything.
 */
function readReportText(path, label) {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    return fail(
      3,
      `perf-ratchet: ABSTAINED — cannot read ${label} report ${path}: ` +
        `${err.message}\nThe check-perf step most likely failed before ` +
        'producing output. Read the step log; do NOT treat an absent report ' +
        'as zero violations.',
    );
  }
}

/**
 * The measured violation count for one side, or exit 3. Every non-numeric
 * path is an ABSTENTION, because each means the check did not measure the
 * codebase: an unparseable report, or a collapse too steep to be real work.
 */
function readViolations(path, maxViolations, label) {
  const violations = violationsFrom(readReportText(path, label));
  if (violations === null) {
    fail(
      3,
      `perf-ratchet: ABSTAINED — the ${label} perf report has neither a ` +
        '"Validation failed (N issues)" header nor a "validation passed" ' +
        'line, so nothing was measured. This is the #544 shape: the check ' +
        'most likely failed at startup (`Could not resolve entry points` ' +
        'means `performance.entryPoints` went missing from ' +
        'harness.config.json — see ADR 0012). Read the step log; do NOT ' +
        'treat an unparseable report as zero.',
    );
  }

  if (isImplausibleCollapse(violations, maxViolations)) {
    fail(
      3,
      `perf-ratchet: ABSTAINED — ${violations} violations in the ${label} ` +
        `perf report against a baseline of ${maxViolations} is too steep a ` +
        'drop to be real work.\nCheck the invocation FIRST: `check-perf ' +
        '--coupling` and `--size` report "validation passed" over findings ' +
        'they should be reporting, so a narrowed run looks exactly like a ' +
        'clean one. The gate must call a bare `harness check-perf` with no ' +
        'narrowing flag.\nIf the drop is genuine, lower "maxViolations" in ' +
        'the baseline in the same commit that earned it, and this stops firing.',
    );
  }

  return violations;
}

/**
 * The delta rule (#812): fail when this branch adds violations its merge base
 * did not have. Called BEFORE the absolute backstop, because it names what
 * this branch actually did — a branch that inherits an over-ceiling base
 * should read "you added 2" first, not a total it did not cause.
 */
/**
 * ## Finding identities, and why the delta rule needs them (#850)
 *
 * The delta rule compared two SCALAR counts, and that blindness had a
 * direction. `check-perf` flags a coupling ratio of 1.00 — which is the
 * DEFINITION of a CLI wiring module, since it imports many things and is
 * imported by few — so all five of this repo's CLI modules already carry one.
 * Adding a subcommand in a NEW module cost +2 findings and failed the delta
 * rule; adding the same subcommand to `ts/src/cli.ts`, already past the
 * 300-line threshold and already flagged for both rules, cost +0, because a
 * file already flagged for a rule is not flagged twice. The gate was cheapest
 * to satisfy by making an oversized file more oversized (#851 paid the honest
 * price instead, retiring six findings to buy room for two).
 *
 * So the delta is computed over finding IDENTITIES, which lets a REVIEWED
 * allowance exempt the findings a legitimate module shape causes.
 *
 * Identity is `(file, rule, subject)` and deliberately EXCLUDES magnitude: a
 * file going 377 -> 900 lines is the same identity and still passes. That is
 * the second half of #850, left open on purpose and pinned by a test.
 * Severity IS part of identity, because a function crossing from the warning
 * to the error threshold is reported as a different finding, and a gate that
 * called that "unchanged" would be lying about an escalation.
 */

/** The rules `harness check-perf` reports, and how to recognise each one. */
const RULES = [
  { rule: 'file-length', re: /^File has \d+ lines/ },
  { rule: 'import-count', re: /^File has \d+ imports/ },
  { rule: 'coupling', re: /^Coupling ratio is/ },
  {
    rule: 'complexity',
    re: /^Function "(.+)" has cyclomatic complexity of \d+ \((error|warning) threshold/,
  },
  { rule: 'function-length', re: /^Function "(.+)" is \d+ lines long/ },
  { rule: 'nesting-depth', re: /^Function "(.+)" has nesting depth of \d+/ },
];

/** Every rule name an allowance may legally name. */
const KNOWN_RULES = RULES.map((r) => r.rule);

/**
 * Classify one finding message into `{ rule, subject }`, or `null` when it
 * matches no known rule. An unclassifiable message makes the whole report
 * incompletely parsed, which DOWNGRADES the comparison rather than guessing.
 */
function classify(message) {
  for (const { rule, re } of RULES) {
    const m = re.exec(message);
    if (!m) continue;
    // The subject distinguishes findings sharing a file and a rule: the
    // function name, plus the severity band for complexity.
    const subject = [m[1] ?? '', m[2] ?? ''].filter(Boolean).join('@');
    return { rule, subject };
  }
  return null;
}

/**
 * Pull structured findings out of a report body.
 *
 * The shape is a `  * <absolute path>` line followed by an indented message:
 *
 *     * /repo/ts/src/cli.ts
 *       Coupling ratio is 1.00 (threshold: 0.7)
 *
 * Returns `null` when any finding fails to classify, so the caller can fall
 * back to counting instead of comparing a set it does not fully understand.
 */
function parseFindings(text) {
  const lines = text.split('\n');
  const findings = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^\s{2}\*\s+(\S.*?)\s*$/.exec(lines[i]);
    if (!m) continue;
    const message = (lines[i + 1] ?? '').trim();
    if (!message) continue;
    const classified = classify(message);
    if (classified === null) return null;
    findings.push({ file: m[1], message, ...classified });
  }
  return findings;
}

/** Strip a scan root so the same file reads the same in both reports. */
function relativize(file, root) {
  if (root && file.startsWith(`${root}/`)) return file.slice(root.length + 1);
  return file;
}

/**
 * `(file, rule, subject)` — the identity the delta rule compares. NUL-joined
 * because a path may contain a space, and a delimiter that can occur inside a
 * component is a collision waiting to happen.
 */
function identity(f) {
  return [f.path, f.rule, f.subject].join('\u0000');
}

/**
 * Validate the allowance list, and refuse one that cannot be reviewed.
 *
 * A list that can grow by one unexplained line is how a gate rots, so `why` is
 * mandatory. An unknown `rule` is a config ERROR rather than an entry that
 * silently matches nothing — a typo'd rule name would otherwise look exactly
 * like a working allowance until the day it was needed.
 */
function readAllowances(raw, baseline) {
  if (!Array.isArray(raw)) {
    fail(2, `perf-ratchet: ${baseline} has a non-array "deltaAllowances".`);
  }
  return raw.map((entry, i) => {
    const where = `deltaAllowances[${i}]`;
    if (typeof entry?.rule !== 'string' || typeof entry?.path !== 'string') {
      fail(2, `perf-ratchet: ${where} needs a string "rule" and "path".`);
    }
    if (typeof entry.why !== 'string' || entry.why.trim() === '') {
      fail(
        2,
        `perf-ratchet: ${where} has no "why". Every allowance must state why ` +
          'the finding is structural and not a regression, so the list stays ' +
          'reviewable instead of accumulating unexplained entries.',
      );
    }
    if (!KNOWN_RULES.includes(entry.rule)) {
      fail(
        2,
        `perf-ratchet: ${where} names unknown rule "${entry.rule}". ` +
          `Known rules: ${KNOWN_RULES.join(', ')}.`,
      );
    }
    return { ...entry, matched: 0 };
  });
}

/**
 * Compile a path glob. `**` crosses directories, `*` does not, and the pattern
 * is anchored to the END of the path so it matches whether or not the scan
 * root was stripped.
 */
function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      re += '.*';
      i += 1;
      if (glob[i + 1] === '/') i += 1;
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^(?:.*/)?${re}$`);
}

/** The first allowance covering this finding, or `null`. */
function allowanceFor(finding, allowances) {
  for (const a of allowances) {
    if (a.rule !== finding.rule) continue;
    if (!globToRegExp(a.path).test(finding.path)) continue;
    a.matched += 1;
    return a;
  }
  return null;
}

/**
 * Name every allowance that covers no finding in the tree, so the list can be
 * pruned instead of accumulating forever.
 *
 * Deliberately judged against ALL head findings, not just the new ones an
 * allowance actually suppressed. Most pull requests introduce no new finding
 * at all, so "did it apply on this run?" would report every allowance as
 * unused on nearly every run — noise that trains people to skip the line. "Is
 * there still anything of this shape in the tree?" is stable, and only goes
 * quiet when the allowance is genuinely obsolete.
 */
function reportUnusedAllowances(allowances, headFindings) {
  for (const a of allowances) {
    const re = globToRegExp(a.path);
    const covers = headFindings.some(
      (f) => f.rule === a.rule && re.test(f.path),
    );
    if (covers) continue;
    console.log(
      `perf-ratchet: allowance ${a.rule} ${a.path} covers no finding in this ` +
        'tree — prune it if the shape it covered is gone.',
    );
  }
}

/**
 * Compare finding identities between the base and the head.
 *
 * Returns `null` when the comparison cannot be made honestly, so the caller
 * falls back to the count rule instead of reporting a conclusion drawn from a
 * set that is not the set that was measured.
 */
function diffFindings(headText, baseText, headCount, baseCount, roots) {
  const head = parseFindings(headText);
  const base = parseFindings(baseText);
  if (head === null || base === null) return null;
  // The header carries the denominator. A body that does not account for it
  // means findings were missed, and every identity conclusion below would rest
  // on a partial set.
  if (head.length !== headCount || base.length !== baseCount) return null;

  for (const f of head) f.path = relativize(f.file, roots.head);
  for (const f of base) f.path = relativize(f.file, roots.base);

  const headFiles = new Set(head.map((f) => f.path));
  const baseFiles = new Set(base.map((f) => f.path));
  // Non-empty on both sides with zero overlap means the roots did not align.
  // "Everything is new" there is a false RED built on a bad parse, and the
  // count rule would call the same tree unchanged — a false GREEN. Neither is
  // reportable, so this abstains.
  if (headFiles.size > 0 && baseFiles.size > 0) {
    const shared = [...headFiles].some((f) => baseFiles.has(f));
    if (!shared) return 'unaligned';
  }
  // A MULTISET, not a set. One file legitimately carries the same identity more
  // than once — `ts/src/core/migrator.ts` has three `for` function-length
  // findings — so 236 findings collapse to 230 distinct identities. Deduping
  // would let a branch add a fourth `for` and have it swallowed by the third,
  // which is the exact false green this gate exists to catch.
  const baseCounts = new Map();
  for (const f of base) {
    const k = identity(f);
    baseCounts.set(k, (baseCounts.get(k) ?? 0) + 1);
  }
  const seen = new Map();
  const added = [];
  for (const f of head) {
    const k = identity(f);
    const nth = (seen.get(k) ?? 0) + 1;
    seen.set(k, nth);
    if (nth > (baseCounts.get(k) ?? 0)) added.push(f);
  }
  return { head, added };
}

/**
 * The merge-base delta rule.
 *
 * Prefers an IDENTITY diff, which is what lets a reviewed allowance exempt a
 * structural finding (#850). Falls back to the original COUNT comparison when
 * either report cannot be parsed completely — allowances do not apply there,
 * because a partial set cannot be reasoned about honestly, and the downgrade
 * is announced rather than assumed. Abstains (exit 3) when the two reports
 * cannot be aligned at all.
 */
function requireNoDelta(baseReport, violations, maxViolations, opts) {
  const base = readViolations(baseReport, maxViolations, 'merge-base');
  const diff = diffFindings(
    readReportText(opts.report, 'head'),
    readReportText(baseReport, 'merge-base'),
    violations,
    base,
    opts.roots,
  );

  if (diff === 'unaligned') {
    fail(
      3,
      'perf-ratchet: ABSTAINED — the head and merge-base reports share no ' +
        'file, so their paths could not be aligned. The two scans run under ' +
        'different roots by design (the base worktree lives outside the ' +
        'checkout), so pass --report-root and --base-report-root. Reporting ' +
        'a delta from unaligned sets would be a made-up number in either ' +
        'direction.',
    );
  }

  if (diff === null) {
    // The body did not account for the header on one side or the other, so
    // fall back to the rule that needs no per-finding detail.
    const delta = violations - base;
    if (delta > 0) {
      fail(
        1,
        `perf-ratchet: FAILED — this branch introduces ${delta} performance ` +
          `violation(s): ${base} at the merge base, ${violations} here.\n` +
          'Compared by COUNT: a report did not parse into per-finding detail, ' +
          'so structural allowances did not apply. Fix the new violations or ' +
          'split the file that grew.',
      );
    }
    console.log(
      `perf-ratchet: delta OK by count — ${violations} here against ${base} ` +
        `at the merge base (${delta >= 0 ? '+' : ''}${delta}). Per-finding ` +
        'detail was unavailable, so no allowance was applied.',
    );
    return;
  }

  const { head: headFindings, added } = diff;
  const blocking = [];
  for (const f of added) {
    const allowance = allowanceFor(f, opts.allowances);
    // An applied allowance is NAMED, never silent. A suppressed finding that
    // nobody can see is the false green the allowance list must not become.
    if (allowance) {
      console.log(
        `perf-ratchet: allowed — ${f.path}: ${f.message}\n` +
          `  by allowance ${allowance.rule} ${allowance.path}: ${allowance.why}`,
      );
    } else blocking.push(f);
  }
  reportUnusedAllowances(opts.allowances, headFindings);

  if (blocking.length > 0) {
    const listed = blocking
      .map((f) => `  * ${f.path}\n    ${f.message}`)
      .join('\n');
    fail(
      1,
      `perf-ratchet: FAILED — this branch introduces ${blocking.length} ` +
        `performance violation(s) its merge base did not have:\n${listed}\n\n` +
        'This is the delta YOUR diff added, measured against the commit you ' +
        'branched from, so it is not affected by what else merged in the ' +
        'meantime. Fix them, or split the file that grew. If a finding is ' +
        'structural — a CLI wiring module trips the coupling rule by ' +
        'definition — add a reviewed "deltaAllowances" entry with a "why".',
    );
  }

  const allowed = added.length - blocking.length;
  console.log(
    `perf-ratchet: delta OK — ${added.length} new finding(s) against the ` +
      `merge base, ${allowed} allowed, 0 blocking ` +
      `(${violations} here, ${base} at the base).`,
  );
}

/** Compare the measurement to the ceiling and report. Exits 1 when it fires. */
function applyRatchet(violations, maxViolations, baseline) {
  if (violations > maxViolations) {
    fail(
      1,
      `perf-ratchet: FAILED (absolute backstop) — ${violations} performance ` +
        `violations, baseline is ${maxViolations} ` +
        `(+${violations - maxViolations}).\n` +
        'Either fix the new violations (complexity, nesting depth, function ' +
        'and file length, coupling ratio, import count) or split the file ' +
        'that grew. Raising "maxViolations" is the one move that is never right.',
    );
  }

  const headroom = maxViolations - violations;
  console.log(
    `perf-ratchet: OK — ${violations} violations, baseline ${maxViolations} ` +
      `(${headroom} of headroom).`,
  );
  if (headroom > NUDGE_SLACK) {
    console.log(
      `perf-ratchet: violations are ${headroom} under the baseline. Please ` +
        `lower "maxViolations" in ${baseline} to ${violations} so the gate ` +
        'keeps its teeth.',
    );
  }
}

function main() {
  const {
    report,
    baseReport,
    baseline,
    cliVersion,
    reportRoot,
    baseReportRoot,
  } = parseArgs(process.argv.slice(2));
  if (!report) fail(2, 'perf-ratchet: --report <file> is required.');

  const { maxViolations, harnessCli, allowances } = readBaseline(baseline);
  const violations = readViolations(report, maxViolations, 'head');
  requireMatchingInstrument(harnessCli, cliVersion, maxViolations);
  if (baseReport !== null)
    requireNoDelta(baseReport, violations, maxViolations, {
      report,
      allowances,
      roots: { head: reportRoot, base: baseReportRoot },
    });
  applyRatchet(violations, maxViolations, baseline);
}

main();
