// report -- the audit as text for a person and JSON for a pipeline.
//
// The denominator line is printed on every run, first, so "nothing to
// release" can never be read without the number of rows it was said about.

// Same greppable wording as the engine's gateOutcome (#508); U+26A0 / U+2014
// as escapes so this source stays ASCII.
export const ABSTAINED_LINE =
  '\u{26A0} Abstained \u{2014} verified zero items; this is not a pass.';

const CLEAR_LINE = (n) =>
  `All ${n} quarantined test(s) are blocked on an open ticket \u{2014} nothing to release.`;

const ORDER = [
  'candidate',
  'blocked',
  'abstain',
  'stale',
  'unlinked',
  'removed',
];

const HEADINGS = {
  candidate: 'Candidates (blocker resolved \u{2014} ready for a trial release)',
  blocked: 'Blocked (blocker open)',
  abstain: 'Abstained (tracker could not be read \u{2014} NOT clear)',
  stale: 'Stale (ledger row, no marker in code)',
  unlinked: 'Unlinked (no blocker named anywhere)',
  removed: 'Removed (deletion records, nothing to lift)',
};

function denominatorLine(den) {
  return (
    `Denominator: ${den.rows_read} ledger row(s) read \u{b7} ${den.resolved} resolved by a tracker ` +
    `\u{b7} ${den.abstained} abstained \u{b7} ${den.not_tracker_questions} answered from the code alone ` +
    `(stale/unlinked/removed)`
  );
}

/** The unledgered scan's own denominator; nothing when the scan was off. */
function scanLine(files) {
  if (files === null || files === undefined) return [];
  if (files === 0)
    return [
      '\u{26A0} Unledgered scan read 0 test files \u{2014} markers with no ledger row could not be looked for.',
    ];
  return [`Unledgered scan: ${files} test file(s) read.`];
}

function rowLine(r) {
  const at = r.line ? `${r.file}:${r.markerLine || r.line}` : r.file;
  const dup =
    r.duplicateOf !== undefined ? ` [duplicate of row ${r.duplicateOf}]` : '';
  return `  - ${r.test}\n      ${at} (${r.marker || r.kind})${dup}\n      ${r.why}`;
}

/** Human text. */
export function renderText(result, { ledger }) {
  const { rows, unledgered, counts, denominator, verdict } = result;
  const out = [
    `canary-unquarantine: audit of ${ledger}`,
    '',
    denominatorLine(denominator),
    ...scanLine(result.scannedFiles),
  ];
  for (const cls of ORDER) {
    const group = rows.filter((r) => r.class === cls);
    if (!group.length) continue;
    out.push('', `${HEADINGS[cls]}: ${counts[cls]}`, ...group.map(rowLine));
  }
  if (unledgered.length) {
    out.push(
      '',
      `Unledgered markers (switched off in code, no ledger row): ${unledgered.length}`,
    );
    for (const m of unledgered) {
      const names = m.names.length
        ? ` \u{2014} names ${m.names.join(', ')}`
        : ' \u{2014} names no ticket';
      out.push(
        `  - ${m.test}\n      ${m.file}:${m.markerLine} (${m.marker})${names}`,
      );
    }
  }
  out.push('', ...verdictLines(result));
  return out.join('\n');
}

function verdictLines({ verdict, denominator, counts }) {
  if (verdict.status === 'abstained' && denominator.rows_read === 0) {
    return [
      `${ABSTAINED_LINE} No ledger rows were read, so no quarantine could be checked.`,
    ];
  }
  if (verdict.status === 'abstained') {
    return [
      `\u{26A0} Abstained on ${denominator.abstained} of ${denominator.rows_read} row(s) \u{2014} their blockers could not be read, so this audit is not clear.`,
      ...(verdict.actionable
        ? [`${verdict.actionable} other item(s) need action (see above).`]
        : []),
    ];
  }
  if (verdict.status === 'action') {
    return [
      `${verdict.actionable} item(s) need action: ${counts.candidate} candidate(s), ${counts.stale} stale, ${counts.unlinked} unlinked row(s), plus any unledgered markers above.`,
    ];
  }
  return [CLEAR_LINE(counts.blocked)];
}

/** The --json document. `checked` and `abstained` follow the family contract. */
export function jsonPayload(result, { ledger, githubRepo }) {
  return {
    schema_version: 1,
    ledger,
    github_repo: githubRepo ?? null,
    checked: result.denominator.rows_read,
    abstained: result.verdict.status === 'abstained',
    verdict: result.verdict,
    denominator: result.denominator,
    counts: result.counts,
    // Test files the unledgered scan read; null when --no-scan.
    scanned_files: result.scannedFiles,
    rows: result.rows,
    unledgered: result.unledgered,
  };
}

// --- trial and verdict -----------------------------------------------------

const notLiftable = (refused) =>
  refused.map((r) => `  not liftable: ${r.test} (${r.file}): ${r.why}`);

/** The trial's dry run: what --yes would lift, and what it could not. */
export function renderTrialPlan({ lifts, refused }) {
  return [
    `Trial plan: lift ${lifts.length} quarantined test(s) in one draft PR, so CI runs them live.`,
    ...lifts.map((l) => `  - ${l.file}:${l.markerLine} ${l.test} [${l.class}]`),
    ...notLiftable(refused),
    '',
    'Nothing has been written. Re-run with --yes to open the draft PR.',
  ].join('\n');
}

/** A trial with nothing to lift is an abstention, never "nothing to do". */
export function renderTrialAbstained(why, refused) {
  return [
    `\u{26A0} Abstained \u{2014} nothing to trial: ${why}.`,
    ...notLiftable(refused),
  ].join('\n');
}

const ACTION = {
  pass: 'release: marker stays lifted, ledger row dropped',
  fail: 're-quarantine: marker restored, row re-pointed, ticket told',
  flaky: 're-quarantine: marker restored; hand to canary-flake-hunter',
  missing: 'not in the run: marker restored, nothing else changed',
  skipped: 'still skipped in the run: marker restored, nothing else changed',
};

const noteLine = (n) =>
  n.commented
    ? `  told ${n.target}: ${n.test} still fails`
    : `  NOT told ${n.target ?? '(no ticket)'}: ${n.why}`;

/** The verdict: one line per lifted test, the flake hand-off, and what was (not) written. */
export function renderVerdict(doc) {
  const out = [
    `Trial verdict for PR ${doc.pr}: ${doc.tests.length} lifted test(s), ${doc.cases} case(s) read from ${doc.documents} result document(s).`,
    ...doc.tests.map(
      (t) =>
        `  [${t.outcome}] ${t.file} \u{2014} ${t.test}\n      ${ACTION[t.outcome]}`,
    ),
  ];
  if (doc.flake_hunter.length) {
    out.push(
      '',
      'Hand to canary-flake-hunter (passed only on retry):',
      ...doc.flake_hunter.map((f) => `  - ${f.test} (${f.file})`),
    );
  }
  out.push(...doc.comments.map(noteLine));
  if (doc.abstained) {
    const n = doc.tests.length - doc.checked;
    out.push(
      '',
      `\u{26A0} Abstained on ${n} lifted test(s) the run did not exercise \u{2014} they prove nothing either way.`,
    );
  }
  out.push(
    '',
    doc.applied
      ? 'Applied to the trial PR.'
      : 'Nothing has been written. Re-run with --apply to rewrite the trial PR and comment on failing tickets.',
  );
  return out.join('\n');
}

/** The --json verdict document. */
export function verdictDoc(args, plan, comments) {
  const { judged } = plan;
  const unrun = judged.filter(
    (j) => j.outcome === 'missing' || j.outcome === 'skipped',
  ).length;
  return {
    command: 'verdict',
    pr: args.pr,
    applied: Boolean(args.apply),
    checked: judged.length - unrun,
    abstained: unrun > 0,
    documents: plan.documents,
    cases: plan.cases,
    tests: judged.map(({ test, file, outcome, cases }) => ({
      test,
      file,
      outcome,
      cases,
    })),
    flake_hunter: judged
      .filter((j) => j.outcome === 'flaky')
      .map(({ test, file }) => ({ test, file })),
    comments,
  };
}
