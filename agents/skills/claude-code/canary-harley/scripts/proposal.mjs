/**
 * canary-harley -- the proposal: what was read from one source file, what was
 * skipped and why, and the ranked candidates.
 *
 * A proposal with nothing to offer carries the reason in `abstained`, so
 * "no candidates" can never read as a clean result.
 */
import { createHash } from 'node:crypto';

import { BOUNDARY, boundarySkip } from './cues.mjs';
import { deriveCandidates } from './invariants.mjs';
import { safe, safeView } from './safe.mjs';
import { langOf, readSignatures } from './signatures.mjs';

const SCHEMA = 'canary.harley-proposal/1';

// The engine's extractor returns at most this many names.
const EXTRACTOR_CAP = 20;

/** Names outside the CRUD/UI boundary are skipped before they are read. */
function partition(names) {
  const reasons = names.map((name) => ({ name, reason: boundarySkip(name) }));
  return {
    kept: reasons.filter((row) => row.reason === null).map((row) => row.name),
    skipped: reasons.filter((row) => row.reason !== null),
  };
}

function read(source, lang, names) {
  if (lang === null) return { signatures: [], skipped: [] };
  return readSignatures(source, lang, names);
}

function filterOnly(candidates, only) {
  if (only === null) return candidates;
  return candidates.filter((candidate) => candidate.functions.includes(only));
}

// Checked in order; the first match is the reason the proposal abstains.
const ABSTENTIONS = [
  [
    (parts) => parts.lang === null,
    (parts) =>
      `unsupported file type: ${parts.path} ` +
      '(TypeScript, JavaScript and Python files are read)',
  ],
  [(parts) => parts.names.length === 0, () => 'no functions found'],
  [
    (parts) => parts.kept.length === 0,
    () => 'only CRUD- or UI-shaped functions, which property tests do not suit',
  ],
  [
    (parts) => parts.only !== null && !parts.names.includes(parts.only),
    (parts) => `no function named '${parts.only}'`,
  ],
  [
    (parts) => parts.candidates.length === 0 && parts.only !== null,
    (parts) => `no candidates for '${parts.only}'`,
  ],
  [
    (parts) => parts.candidates.length === 0,
    () => 'no candidates: no function with parameters could be read',
  ],
];

function abstention(parts) {
  const hit = ABSTENTIONS.find(([applies]) => applies(parts));
  // The reason holds the path and the --function text. It is made one inert
  // line here, so the JSON field and the stderr line are covered as well.
  return hit ? safe(hit[1](parts)) : null;
}

/**
 * @param {object} input
 * @param {string} input.path the path to print for the source file
 * @param {string} input.source the file's text
 * @param {string[]} input.names the functions the engine's extractor found
 * @param {string} [input.only] keep only this function's candidates
 * @returns {object} a `canary.harley-proposal/1` object
 */
export function buildProposal(input) {
  const only = input.only ?? null;
  const lang = langOf(input.path);
  const split = partition(input.names);
  const result = read(input.source, lang, split.kept);
  const candidates = filterOnly(deriveCandidates(result.signatures), only);
  const sha256 = createHash('sha256').update(input.source).digest('hex');
  return {
    schema: SCHEMA,
    source: { path: input.path, sha256 },
    functions: input.names,
    signatures: result.signatures,
    skipped: [...split.skipped, ...result.skipped],
    candidates,
    boundary: BOUNDARY,
    abstained: abstention({
      path: input.path,
      names: input.names,
      kept: split.kept,
      lang,
      only,
      candidates,
    }),
    capped: input.names.length >= EXTRACTOR_CAP,
  };
}

/**
 * @param {object} proposal
 * @returns {string} the proposal as JSON, ending with one newline
 */
export function renderJson(proposal) {
  return `${JSON.stringify(proposal, null, 2)}\n`;
}

function header(proposal) {
  const capNote = proposal.capped
    ? [
        `The function list may be cut short at ${EXTRACTOR_CAP}: the ` +
          'extractor returns no more names than that.',
        '',
      ]
    : [];
  return [
    `# canary-harley proposal: ${proposal.source.path}`,
    '',
    `- sha256: ${proposal.source.sha256}`,
    `- functions seen: ${proposal.functions.length}`,
    `- signatures read: ${proposal.signatures.length}`,
    `- skipped: ${proposal.skipped.length}`,
    '',
    // Fixed prose comes from the constant, whole.
    BOUNDARY,
    '',
    'Scores are heuristic: a fixed prior per kind, raised by a name cue. ' +
      'Nothing here measures whether an invariant holds.',
    '',
    ...capNote,
  ];
}

function emittableLine(candidate) {
  if (candidate.emittable) return '   - emittable: yes';
  return `   - emittable: no (${candidate.blocked.join('; ')})`;
}

function candidateBlock(candidate, index) {
  const score = candidate.score.toFixed(2);
  return [
    `${index + 1}. [${candidate.tier} ${score}] ` +
      `${candidate.kind}: ${candidate.statement}`,
    `   - id: ${candidate.id}`,
    `   - evidence: ${candidate.evidence.join('; ')}`,
    `   - fails when: ${candidate.failsWhen}`,
    emittableLine(candidate),
  ];
}

/** The ranked list, or the reason there is none. */
function candidateLines(proposal) {
  if (proposal.abstained !== null) {
    return [`Abstained: ${proposal.abstained}`, ''];
  }
  return [
    '## Candidates',
    '',
    ...proposal.candidates.flatMap(candidateBlock),
    '',
  ];
}

function skippedLines(proposal) {
  if (proposal.skipped.length === 0) return [];
  const rows = proposal.skipped.map((skip) => `- ${skip.name}: ${skip.reason}`);
  return ['## Skipped', '', ...rows, ''];
}

function nextLines(proposal) {
  if (proposal.abstained !== null) return ['Nothing was generated.'];
  return [
    'Nothing was generated. Confirm the invariants that are true of the ' +
      'code, then run:',
    '',
    `    canary-harley emit ${proposal.source.path} --confirm <id>[,<id>...]`,
  ];
}

/**
 * @param {object} proposal
 * @returns {string} the proposal as markdown, ending with one newline
 */
export function renderMarkdown(proposal) {
  // An agent reads this text. Every line below is built from the sanitized
  // view and never from `proposal`, so no value taken from the analysed
  // file, its path or the command line can start a line or a block.
  const view = safeView(proposal);
  const lines = [
    ...header(view),
    ...candidateLines(view),
    ...skippedLines(view),
    ...nextLines(view),
  ];
  return `${lines.join('\n')}\n`;
}
