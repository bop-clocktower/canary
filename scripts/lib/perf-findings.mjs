/**
 * Finding identities for the performance ratchet (#850).
 *
 * ## Why identities, and not counts
 *
 * The merge-base delta rule compared two SCALAR counts, and that blindness had
 * a direction. `check-perf` flags a coupling ratio of 1.00 — which is the
 * DEFINITION of a CLI wiring module, since it imports many things and is
 * imported by few — so all five of this repo's CLI modules already carry one.
 * Adding a subcommand in a NEW module cost +2 findings and failed the delta
 * rule; adding the same subcommand to `ts/src/cli.ts`, already past the
 * 300-line threshold and already flagged for both rules, cost +0, because a
 * file already flagged for a rule is not flagged twice. The gate was cheapest
 * to satisfy by making an oversized file more oversized (#851 paid the honest
 * price instead, retiring six findings to buy room for two).
 *
 * Comparing IDENTITIES lets a REVIEWED allowance exempt the findings that a
 * legitimate module shape causes.
 *
 * Identity is `(file, rule, subject)` and deliberately EXCLUDES magnitude: a
 * file going 377 -> 900 lines is the same identity and still passes. That is
 * the second half of #850, tracked as #854 and pinned by a test. Severity IS
 * part of identity, because a function crossing from the warning to the error
 * threshold is reported as a different finding, and a gate that called that
 * "unchanged" would be lying about an escalation.
 *
 * This module lives apart from `perf-ratchet.mjs` because that script tripped
 * its own size and complexity thresholds once this logic landed in it — the
 * gate caught its own change, which is the outcome #850 was arguing for.
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
export const KNOWN_RULES = RULES.map((r) => r.rule);

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
 * Compile a path glob. `**` crosses directories, `*` does not, and the pattern
 * is anchored to the END of the path so it matches whether or not the scan
 * root was stripped.
 */
export function globToRegExp(glob) {
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
export function allowanceFor(finding, allowances) {
  for (const a of allowances) {
    if (a.rule !== finding.rule) continue;
    if (!globToRegExp(a.path).test(finding.path)) continue;
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
export function reportUnusedAllowances(allowances, headFindings) {
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
 * Do the two reports describe the same tree?
 *
 * The head scan runs in the checkout and the merge-base scan in a worktree
 * deliberately outside it, so the same file appears under different absolute
 * roots. Non-empty on both sides with zero overlap means the roots did not
 * align: "everything is new" would be a false RED, and the count rule would
 * call the same tree unchanged — a false GREEN. Neither is reportable.
 */
function aligned(head, base) {
  if (head.length === 0 || base.length === 0) return true;
  const baseFiles = new Set(base.map((f) => f.path));
  return head.some((f) => baseFiles.has(f.path));
}

/**
 * The head findings whose identity the base did not already carry.
 *
 * A MULTISET, not a set. One file legitimately carries the same identity more
 * than once — `ts/src/core/migrator.ts` has three `for` function-length
 * findings, so 236 findings collapse to 230 distinct identities. Deduping
 * would let a branch add a fourth `for` and have it swallowed by the third,
 * which is the exact false green this gate exists to catch.
 */
function addedFindings(head, base) {
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
  return added;
}

/**
 * Parse both reports, or return `null` when either cannot be trusted.
 *
 * The header carries the denominator. A body that does not account for it
 * means findings were missed, and every identity conclusion would rest on a
 * partial set.
 */
function parseBoth(headText, baseText, headCount, baseCount) {
  const head = parseFindings(headText);
  const base = parseFindings(baseText);
  if (head === null || base === null) return null;
  if (head.length !== headCount || base.length !== baseCount) return null;
  return { head, base };
}

/**
 * Compare finding identities between the base and the head.
 *
 * Returns `null` when the comparison cannot be made honestly (so the caller
 * falls back to the count rule), the string `'unaligned'` when the two reports
 * describe different trees, or `{ head, added }`.
 */
export function diffFindings(headText, baseText, headCount, baseCount, roots) {
  const parsed = parseBoth(headText, baseText, headCount, baseCount);
  if (parsed === null) return null;
  const { head, base } = parsed;
  for (const f of head) f.path = relativize(f.file, roots.head);
  for (const f of base) f.path = relativize(f.file, roots.base);
  if (!aligned(head, base)) return 'unaligned';
  return { head, added: addedFindings(head, base) };
}
