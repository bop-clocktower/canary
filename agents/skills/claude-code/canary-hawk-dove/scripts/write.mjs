// write -- the three commands that append to the ledger (#618).
//
//   record  take a gate's JSON in as a run; new findings get ids; derived
//           labels (guardian only) are appended with the rule that made them
//   label   one explicit outcome for a KNOWN finding id; unknown ids are
//           rejected, never stored
//   escape  one explicit "the gate missed this", with gate and evidence and
//           no finding id -- a gate cannot have an id for what it never saw
//
// Each returns `{code}` or `{usage}` (the CLI formats usage errors). Every
// value printed goes through escape.mjs. Validation is a table of checks per
// command, so no command function branches on its options itself.

import { appendRecords, loadLedger } from './ledger.mjs';
import { readRun } from './ingest.mjs';
import { deriveLabels } from './derive.mjs';
import { clean } from './escape.mjs';

const PREFIX = 'canary-hawk-dove:';
const EXIT_WRITE = 1;
const EXIT_REJECTED = 2;

const GATE_RE = /^[a-z][a-z0-9-]{0,39}$/;
const BY_RE = /^[A-Za-z0-9][A-Za-z0-9._@+-]{0,63}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const ID_RE = /^hd1-[0-9a-f]{16}$/;
const LABEL_OUTCOMES = ['real', 'noise', 'intentional'];

const MAX_EVIDENCE = 300;
const MAX_NOTE = 500;

const fail = (msg, code = EXIT_REJECTED) => {
  console.error(`${PREFIX} ${clean(msg, 400)}`);
  return { code };
};

function checkGate({ gate }) {
  if (!gate) return 'argument --gate: required';
  return GATE_RE.test(gate)
    ? null
    : 'argument --gate: lower-case letters, digits and -, at most 40';
}

/** `--by` is the provenance "who"; `derived` is reserved for derived rules. */
function checkBy(by, required) {
  if (!by) return required ? 'argument --by: required' : null;
  if (by === 'derived') return 'argument --by: "derived" is reserved';
  return BY_RE.test(by) ? null : 'argument --by: letters, digits and ._@+-';
}

const need = (key, flag) => (opts) =>
  opts[key] ? null : `argument ${flag}: required`;

const CHECKS = {
  record: [
    checkGate,
    need('from', '--from'),
    ({ pr }) =>
      pr == null || pr > 0 ? null : 'argument --pr: must be 1 or more',
    ({ by }) => checkBy(by, false),
  ],
  label: [
    ({ args }) => (args.length === 2 ? null : 'label: expected one finding id'),
    ({ outcome }) =>
      LABEL_OUTCOMES.includes(outcome)
        ? null
        : `argument --outcome: one of ${LABEL_OUTCOMES.join(', ')}`,
    ({ by }) => checkBy(by, true),
    need('evidence', '--evidence'),
  ],
  escape: [
    ({ args }) => (args.length === 1 ? null : 'escape: takes no finding id'),
    checkGate,
    ({ by }) => checkBy(by, true),
    need('evidence', '--evidence'),
  ],
};

/** The provenance time: `--at` (ISO 8601) or now. */
function timeOf(opts, deps) {
  if (opts.at == null) return { at: deps.now().toISOString() };
  const ms = Date.parse(opts.at);
  if (!ISO_RE.test(opts.at) || Number.isNaN(ms)) {
    return { usage: 'argument --at: expected an ISO 8601 timestamp' };
  }
  return { at: new Date(ms).toISOString() };
}

/** `{usage}` for the first failing check, else `{at}`. */
function validate(command, opts, deps) {
  for (const check of CHECKS[command]) {
    const usage = check(opts);
    if (usage) return { usage };
  }
  return timeOf(opts, deps);
}

/** Load the ledger, or print why it cannot be used. */
function open(opts) {
  const led = loadLedger(opts.repo, opts.ledger);
  if (led.notRead) return { err: fail(`ledger not read: ${led.notRead}`) };
  return { led };
}

/** Append, then print `done` -- or the reason the ledger was not written. */
function commit(opts, led, records, done) {
  const err = appendRecords(opts.repo, opts.ledger, records, led.endsClean);
  if (err) return fail(`ledger ${err}`, EXIT_WRITE);
  console.log(clean(done, 400));
  return { code: 0 };
}

function newFindings(state, findings) {
  return findings
    .filter((f) => !state.findings.has(f.id))
    .map(({ id, gate, file, rule, anchor, fidelity }) => {
      const rec = { v: 1, kind: 'finding', id, gate, file, rule, anchor };
      return { ...rec, fidelity };
    });
}

function runRecord(state, parsed, meta) {
  return {
    v: 1,
    kind: 'run',
    run: `run-${state.runs.length + 1}`,
    ...parsed.run,
    pr: meta.pr ?? null,
    at: meta.at,
    by: meta.by ?? null,
    source: clean(parsed.source, 300),
    findings: parsed.findings.map(({ id, suppressed, reason }) => ({
      id,
      suppressed,
      reason,
    })),
  };
}

function recordSummary(run, fresh, derived, notRead) {
  const pr = run.pr === null ? '' : `, PR ${run.pr}`;
  return (
    `recorded ${run.run} (${run.gate}${pr}): ${run.findings.length} finding(s), ` +
    `${fresh} new; ${derived.labels.length} derived label(s), ` +
    `${derived.ambiguous} ambiguous, ${derived.unresolved} unresolved; ` +
    `${notRead} entr(ies) not read`
  );
}

/** `record --gate G --from FILE [--pr N] [--by WHO] [--at ISO]` */
export function record(opts, deps) {
  const time = validate('record', opts, deps);
  if (time.usage) return time;
  const parsed = readRun(opts.repo, opts.from, opts.gate);
  if (parsed.error) return fail(parsed.error);
  const { led, err } = open(opts);
  if (err) return err;
  const run = runRecord(led.state, parsed, { ...opts, at: time.at });
  const at = time.at;
  const derived = deriveLabels({ state: led.state, run, at, repo: opts.repo });
  const fresh = newFindings(led.state, parsed.findings);
  const summary = recordSummary(run, fresh.length, derived, parsed.notRead);
  return commit(opts, led, [...fresh, run, ...derived.labels], summary);
}

/** One explicit label record; evidence and note are cleaned and clamped. */
function labelRecord(opts, at, finding, gate, outcome) {
  return {
    v: 1,
    kind: 'label',
    rule: 'explicit',
    finding,
    gate,
    outcome,
    by: opts.by,
    at,
    evidence: clean(opts.evidence, MAX_EVIDENCE),
    note: opts.note ? clean(opts.note, MAX_NOTE) : null,
  };
}

/** `label <finding-id> --outcome O --by WHO --evidence REF [--note T] [--at ISO]` */
export function addLabel(opts, deps) {
  const time = validate('label', opts, deps);
  if (time.usage) return time;
  const { led, err } = open(opts);
  if (err) return err;
  const id = opts.args[1];
  const finding = ID_RE.test(id) ? led.state.findings.get(id) : undefined;
  if (!finding) {
    return fail(
      `unknown finding id ${id}: record the gate run that produced it first`,
    );
  }
  const rec = labelRecord(opts, time.at, id, finding.gate, opts.outcome);
  return commit(
    opts,
    led,
    [rec],
    `labelled ${id} (${finding.gate}) ${opts.outcome}`,
  );
}

/** `escape --gate G --by WHO --evidence REF [--note T] [--at ISO]` */
export function addEscape(opts, deps) {
  const time = validate('escape', opts, deps);
  if (time.usage) return time;
  const { led, err } = open(opts);
  if (err) return err;
  const rec = labelRecord(opts, time.at, null, opts.gate, 'escape');
  return commit(opts, led, [rec], `recorded an escape for ${opts.gate}`);
}
