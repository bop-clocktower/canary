// ingest -- turn one gate run's JSON into a run record plus findings (#618).
//
// Two shapes are read. `--gate guardian` reads `canary guardian pr-check
// --json`: identity is (path, kind, unit), and the run keeps what the ADR 0025
// rules need -- fidelity, the suppression and its reason, whether the run can
// vouch for an absence, and its diff endpoints. Every other gate supplies the
// scan-baseline identity directly: `{"findings": [{"file", "rule", "anchor"}]}`.
//
// A finding id is the line-free scan-baseline identity (#1322) hashed with
// its gate, so a moved or re-indented line keeps its id and two gates never
// share one. An id names an identity, not an occurrence: a repeat in one run
// collapses into the first.

import crypto from 'node:crypto';

import { identityOf } from '../../../lib/scan-baseline.mjs';
import { clean } from './escape.mjs';
import { readInside } from './files.mjs';

/** A gate JSON over this size is reported as not read, never read in part. */
const MAX_INPUT_BYTES = 5 * 1024 * 1024;

/** Findings read from one input; the rest are counted as not read. */
export const MAX_FINDINGS = 5000;

/** Stored strings are clamped so one hostile input cannot bloat the ledger. */
const MAX_STORED = 1000;

/** `hd1-` + 16 hex of SHA-256 over NUL-separated gate and identity. */
export function findingId(gate, identity) {
  const { file, rule, anchor } = identityOf(identity, '/');
  const digest = crypto
    .createHash('sha256')
    .update([gate, file, rule, anchor].join('\u0000'))
    .digest('hex');
  return `hd1-${digest.slice(0, 16)}`;
}

/** The bounded error for unparseable input: a name and a position, no bytes. */
function parseError(text, name) {
  try {
    return { doc: JSON.parse(text) };
  } catch (exc) {
    const at = /at position (\d+)/.exec(String(exc?.message ?? ''));
    const where = at ? ` at position ${at[1]}` : '';
    return { error: `invalid JSON in ${clean(name)}${where}` };
  }
}

const str = (v) => (typeof v === 'string' ? v : null);

/** One raw entry as an identity, or null when it cannot be one. */
function identityFrom(entry, gate) {
  if (entry === null || typeof entry !== 'object') return null;
  const file = str(gate === 'guardian' ? entry.path : entry.file);
  if (!file) return null;
  const rule = gate === 'guardian' ? entry.kind : entry.rule;
  const anchor = gate === 'guardian' ? entry.unit : entry.anchor;
  return { file, rule: str(rule) ?? '', anchor: str(anchor) ?? '' };
}

/** One stored finding: id from the raw identity, display fields clamped. */
function toFinding(entry, gate, root) {
  const raw = identityFrom(entry, gate);
  if (!raw) return null;
  const identity = identityOf(raw, root);
  const reason = str(entry.suppression_reason);
  return {
    id: findingId(gate, identity),
    gate,
    file: clean(identity.file, MAX_STORED),
    rule: clean(identity.rule, MAX_STORED),
    anchor: clean(identity.anchor, MAX_STORED),
    fidelity: gate === 'guardian' ? str(entry.fidelity) : null,
    suppressed: entry.suppressed === true,
    reason: reason === null ? null : clean(reason, MAX_STORED),
  };
}

/** The guardian can vouch for an absence only from a fully covered run. */
function vouches(doc, gate) {
  if (gate !== 'guardian') return false;
  return (
    doc.coverage?.status === 'verified' &&
    !doc.degraded_notice &&
    doc.abstained !== true
  );
}

/** The run's diff endpoints, when it names them. */
function endpoints(doc) {
  const p = doc.provenance ?? {};
  return { base: str(p.base), head: str(p.head) };
}

/** Collapse repeated ids, cap the count, and tally what was not read. */
function collect(entries, gate, root) {
  const seen = new Map();
  let notRead = 0;
  for (const entry of entries) {
    const finding = toFinding(entry, gate, root);
    if (!finding) notRead += 1;
    else if (seen.has(finding.id)) continue;
    else if (seen.size >= MAX_FINDINGS) notRead += 1;
    else seen.set(finding.id, finding);
  }
  return { findings: [...seen.values()], notRead };
}

/**
 * @param {string} text the input's bytes
 * @param {{gate: string, name: string, root: string}} opts
 * @returns {{error: string} | {run: object, findings: object[], notRead: number}}
 */
export function parseRun(text, { gate, name, root }) {
  const parsed = parseError(text, name);
  if (parsed.error) return parsed;
  const doc = parsed.doc;
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.findings)) {
    return { error: `${clean(name)} has no findings array` };
  }
  const { findings, notRead } = collect(doc.findings, gate, root);
  return {
    run: { gate, vouches: vouches(doc, gate), ...endpoints(doc) },
    findings,
    notRead,
  };
}

/**
 * Read `rel` (inside `root`, a regular `.json` file, under the size cap) and
 * parse it. A refusal names the input and the reason, never its bytes.
 *
 * @returns {{error: string} | {run, findings, notRead, source: string}}
 */
export function readRun(root, rel, gate) {
  const read = readInside(root, rel, {
    ext: '.json',
    maxBytes: MAX_INPUT_BYTES,
  });
  if (read.notRead) return { error: `${clean(rel)} not read: ${read.notRead}` };
  const parsed = parseRun(read.text, { gate, name: read.rel, root });
  return parsed.error ? parsed : { ...parsed, source: read.rel };
}
