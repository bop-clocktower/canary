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
// value printed goes through escape.mjs.

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

function checkGate(gate) {
  if (!gate) return 'argument --gate: required';
  return GATE_RE.test(gate)
    ? null
    : 'argument --gate: lower-case letters, digits and -, at most 40';
}

function checkBy(by, required) {
  if (!by) return required ? 'argument --by: required' : null;
  if (by === 'derived') return 'argument --by: "derived" is reserved';
  return BY_RE.test(by) ? null : 'argument --by: letters, digits and ._@+-';
}

/** The provenance time: `--at` (ISO 8601) or now. */
function timeOf(opts, deps) {
  if (opts.at == null) return { at: deps.now().toISOString() };
  const ms = Date.parse(opts.at);
  if (!ISO_RE.test(opts.at) || Number.isNaN(ms)) {
    return { usage: 'argument --at: expected an ISO 8601 timestamp' };
  }
  return { at: new Date(ms).toISOString() };
}

function checkEvidence(opts) {
  if (!opts.evidence) return 'argument --evidence: required';
  return null;
}

/** Load the ledger, or print why it cannot be used. */
function open(opts) {
  const led = loadLedger(opts.repo, opts.ledger);
  if (led.notRead) return { err: fail(`ledger not read: ${led.notRead}`) };
  return { led };
}

function append(opts, led, records) {
  const err = appendRecords(opts.repo, opts.ledger, records, led.endsClean);
  return err ? fail(`ledger ${err}`, EXIT_WRITE) : null;
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
    source: clean(meta.source, 300),
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
  const usage =
    checkGate(opts.gate) ??
    (opts.from ? null : 'argument --from: required') ??
    (opts.pr == null || opts.pr > 0
      ? null
      : 'argument --pr: must be 1 or more') ??
    checkBy(opts.by, false);
  const time = timeOf(opts, deps);
  if (usage || time.usage) return { usage: usage ?? time.usage };
  const parsed = readRun(opts.repo, opts.from, opts.gate);
  if (parsed.error) return fail(parsed.error);
  const { led, err } = open(opts);
  if (err) return err;
  const meta = { ...opts, at: time.at, source: parsed.source };
  const run = runRecord(led.state, parsed, meta);
  const derived = deriveLabels({
    state: led.state,
    run,
    at: time.at,
    repo: opts.repo,
  });
  const fresh = newFindings(led.state, parsed.findings);
  const failed = append(opts, led, [...fresh, run, ...derived.labels]);
  if (failed) return failed;
  console.log(
    clean(recordSummary(run, fresh.length, derived, parsed.notRead), 400),
  );
  return { code: 0 };
}

function labelRecord(fields) {
  return {
    v: 1,
    kind: 'label',
    rule: 'explicit',
    ...fields,
    evidence: clean(fields.evidence, MAX_EVIDENCE),
    note: fields.note ? clean(fields.note, MAX_NOTE) : null,
  };
}

function labelUsage(opts, id) {
  if (!id) return 'label: expected one finding id';
  if (!LABEL_OUTCOMES.includes(opts.outcome)) {
    return `argument --outcome: one of ${LABEL_OUTCOMES.join(', ')}`;
  }
  return checkBy(opts.by, true) ?? checkEvidence(opts);
}

/** `label <finding-id> --outcome O --by WHO --evidence REF [--note T] [--at ISO]` */
export function addLabel(opts, deps) {
  const id = opts.args[1];
  const usage =
    labelUsage(opts, id) ??
    (opts.args.length > 2 ? 'label: one finding id only' : null);
  const time = timeOf(opts, deps);
  if (usage || time.usage) return { usage: usage ?? time.usage };
  const { led, err } = open(opts);
  if (err) return err;
  const finding = ID_RE.test(id) ? led.state.findings.get(id) : undefined;
  if (!finding) {
    return fail(
      `unknown finding id ${id}: record the gate run that produced it first`,
    );
  }
  const rec = labelRecord({
    finding: id,
    gate: finding.gate,
    outcome: opts.outcome,
    by: opts.by,
    at: time.at,
    evidence: opts.evidence,
    note: opts.note,
  });
  const failed = append(opts, led, [rec]);
  if (failed) return failed;
  console.log(clean(`labelled ${id} (${finding.gate}) ${opts.outcome}`));
  return { code: 0 };
}

/** `escape --gate G --by WHO --evidence REF [--note T] [--at ISO]` */
export function addEscape(opts, deps) {
  const usage =
    checkGate(opts.gate) ??
    checkBy(opts.by, true) ??
    checkEvidence(opts) ??
    (opts.args.length > 1 ? 'escape: takes no finding id' : null);
  const time = timeOf(opts, deps);
  if (usage || time.usage) return { usage: usage ?? time.usage };
  const { led, err } = open(opts);
  if (err) return err;
  const rec = labelRecord({
    finding: null,
    gate: opts.gate,
    outcome: 'escape',
    by: opts.by,
    at: time.at,
    evidence: opts.evidence,
    note: opts.note,
  });
  const failed = append(opts, led, [rec]);
  if (failed) return failed;
  console.log(clean(`recorded an escape for ${opts.gate}`));
  return { code: 0 };
}
