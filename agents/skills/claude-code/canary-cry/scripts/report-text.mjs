// canary-cry report text -- PURE (#608 P5; spec "Outputs"). The report
// `cry report` writes, as data (`canary.cry-report/1`, what --json prints) and
// as report.md. report.mjs does the reading and checking; this module never
// touches a file, so the same findings.json always renders byte-identically.
//
// Ranking is by fidelity: a state-verified breach, an observed signal, a
// verified clean, then what could not be measured (abstain), then by score.
// The run's own text (findings.mjs) lists abstentions above clean; a report
// puts them last. A verdict's replay command is derived from its scenario id
// (report.mjs has checked the id's shape), never read from the file.

import { fileStem } from './codegen.mjs';
import { exitCode } from './findings.mjs';
import { ABSTAINED_LINE } from './render.mjs';

const REPORT_FORMAT = 'canary.cry-report/1';
const REPLAY = 'npx playwright test -c playwright.config.mjs';
const RANK = { corrupted: 0, symptom: 1, clean: 2, abstain: 3 };
const SHELL_SAFE = /^[A-Za-z0-9_./:@%+=,-]+$/;

/** The spec a scenario's replay runs, relative to its run dir. */
export const specOf = (id) => `specs/${fileStem(id)}.spec.mjs`;

const byRank = (a, b) =>
  RANK[a.verdict] - RANK[b.verdict] ||
  b.score - a.score ||
  (a.id < b.id ? -1 : 1);

function countsOf(scenarios) {
  const counts = { corrupted: 0, symptom: 0, clean: 0, abstain: 0 };
  for (const s of scenarios) counts[s.verdict] += 1;
  return counts;
}

/** The report as data: what --json prints and report.md renders. */
function buildReport(doc, dir, file) {
  const ranked = [...doc.scenarios].sort(byRank).map((s, i) => ({
    rank: i + 1,
    id: s.id,
    verdict: s.verdict,
    fidelity: s.fidelity ?? null,
    reason: s.reason ?? null,
    score: s.score,
    fingerprints: s.fingerprints,
    invariants: s.invariants,
    replay: `${REPLAY} ${specOf(s.id)}`,
  }));
  return {
    format: REPORT_FORMAT,
    run: doc.run,
    status: doc.status,
    reason: doc.reason ?? null,
    counts: countsOf(doc.scenarios),
    stop: doc.stop ?? null,
    blockedEgress: doc.blockedEgress,
    dir,
    report: file,
    ranked,
  };
}

const shellArg = (text) =>
  SHELL_SAFE.test(text) ? text : `'${text.replaceAll("'", `'\\''`)}'`;

// Every string below but the replay command is untrusted: a probe error is
// the target's HTTP or shell output, and findings.json can be hand-edited.
// `inert` is the ONE way such a string reaches report.md: no backtick (so a
// code span cannot close early), no control or line-separator character (so
// it cannot start a new line, a `##` heading or a forged `- replay:`), and
// at most MAX_SHOWN characters. The replay command never passes through it:
// it is built from the checked scenario id alone.
const MAX_SHOWN = 300;
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029`]/g;
function inert(value) {
  const flat = String(value).replace(UNSAFE, ' ');
  return flat.length > MAX_SHOWN ? `${flat.slice(0, MAX_SHOWN)}...` : flat;
}
const json = (v) => inert(JSON.stringify(v));

function statusLines(r) {
  if (r.status === 'abstained') {
    return [`- status: ABSTAINED: ${inert(r.reason)}`, '', ABSTAINED_LINE];
  }
  if (r.status === 'partial') return [`- status: ${inert(r.reason)}`];
  return ['- status: ok', ...(r.stop?.line ? [`- ${inert(r.stop.line)}`] : [])];
}

function headerLines(r) {
  const { run, counts: c } = r;
  const egress = r.blockedEgress.length
    ? [`- blocked egress (aborted): ${r.blockedEgress.map(inert).join(', ')}`]
    : [];
  return [
    `# canary-cry report: ${run.id}`,
    '',
    `- target: \`${inert(run.target)}\` (${inert(run.environment)}) ${inert(run.baseURL)}`,
    `- amplitude ${inert(run.amplitude)}, seed ${inert(run.seed)}, manifest-sha ${inert(run.manifestSha)}`,
    `- corrupted ${c.corrupted}, symptom ${c.symptom}, clean ${c.clean}, abstain ${c.abstain}`,
    ...egress,
    ...statusLines(r),
    '',
  ];
}

const invariantLine = (inv) =>
  inv.error !== undefined
    ? `- ${inert(inv.id)}: probe failed: ${inert(inv.error)}`
    : `- ${inert(inv.id)}: before ${json(inv.before)} -> after ${json(inv.after)} ` +
      `(expect ${json(inv.expect)})`;

function entryLines(e) {
  const label =
    e.verdict === 'abstain'
      ? `abstain: ${inert(e.reason)}`
      : `${e.verdict}${e.fidelity ? ` (${inert(e.fidelity)})` : ''}`;
  return [
    `## ${e.rank}. ${label}: \`${e.id}\``,
    '',
    `- score ${e.score}`,
    ...e.fingerprints.map((fp) => `- fingerprint \`${inert(fp)}\``),
    ...e.invariants
      .filter((inv) => inv.breached === true || inv.error !== undefined)
      .map(invariantLine),
    `- replay: \`${e.replay}\``,
    '',
  ];
}

/** report.md: deterministic, a trailing newline, ranked as `ranked` is. */
function renderReport(r) {
  const body = r.ranked.length
    ? [
        `Replay a scenario from its run dir (\`cd ${shellArg(r.dir)}\`), on ` +
          "the target project's Playwright:",
        '',
        ...r.ranked.flatMap(entryLines),
      ]
    : ['No scenario ran.', ''];
  return [...headerLines(r), ...body].join('\n');
}

/**
 * The report of a checked findings.json: the document, report.md's text, and
 * the exit code. --strict is findings.mjs's `exitCode`, the function the
 * confirmed run exited with, so report and run never disagree.
 * @param {object} doc a findings.json report.mjs has checked
 * @param {{dir: string, file: string, strict: boolean}} where the run dir,
 *   the report.md path, and --strict
 */
export function reportOf(doc, { dir, file, strict }) {
  const report = buildReport(doc, dir, file);
  return { report, md: renderReport(report), exit: exitCode(report, strict) };
}
