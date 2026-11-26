// The pure half of `scripts/check_changelog_entry.mjs` (#1418): classify a PR
// title, read the opt-out line, locate `## [Unreleased]`, and decide. No git,
// no I/O; the CLI reads git and hands the results in through `read`, so every
// verdict is testable without a repository.

const USER_FACING = new Set(['feat', 'fix', 'perf']);
const EXEMPT = new Set([
  'chore',
  'docs',
  'test',
  'ci',
  'refactor',
  'style',
  'build',
]);
const TITLE = /^(?<type>[a-z]+)(?:\([^)]*\))?(?<bang>!)?:\s*\S/;

/**
 * The PR title's Conventional Commit type, and whether it needs an entry.
 *
 * @param {unknown} title
 * @returns {{kind: 'user-facing'|'exempt'|'unknown', type: string|null}}
 */
export function classifyTitle(title) {
  const m = TITLE.exec(String(title ?? '').trim());
  if (!m?.groups) return { kind: 'unknown', type: null };
  const { type, bang } = m.groups;
  const known = USER_FACING.has(type) || EXEMPT.has(type);
  if (!known) return { kind: 'unknown', type };
  const userFacing = USER_FACING.has(type) || Boolean(bang);
  return { kind: userFacing ? 'user-facing' : 'exempt', type };
}

/**
 * The body's prose lines: everything outside fenced code and HTML comments,
 * where a line is an example or a template hint, not the author's choice.
 *
 * A line scan, not a regex replace, so nothing is ever spliced back together:
 * any line touching a comment is dropped whole, and an unterminated `<!--`
 * hides the rest of the body, as it does when GitHub renders it.
 */
function proseLines(text) {
  const out = [];
  let fence = false;
  let comment = false;
  for (const line of text.split(/\r?\n/)) {
    if (comment) comment = !line.includes('-->');
    else if (/^\s*```/.test(line)) fence = !fence;
    else if (fence) continue;
    else if (line.includes('<!--'))
      comment = !line.slice(line.indexOf('<!--')).includes('-->');
    else out.push(line);
  }
  return out.join('\n');
}

const OPT_OUT = /^[ \t>*-]*changelog:[ \t]*none\b[ \t]*[—–:-]*[ \t]*(.*)$/im;

/**
 * The `Changelog: none — <reason>` opt-out, if the body has one.
 *
 * @param {unknown} body
 * @returns {{present: boolean, reason?: string|null}}
 */
export function parseOptOut(body) {
  const m = OPT_OUT.exec(proseLines(String(body ?? '')));
  if (!m) return { present: false };
  const reason = m[1].trim();
  const placeholder = /^<[^>]*>$/.test(reason);
  return { present: true, reason: reason && !placeholder ? reason : null };
}

/**
 * 1-based line span of `## [Unreleased]`: its heading through the line before
 * the next h2, or the end of the file.
 *
 * @param {string} text
 * @returns {{start: number, end: number} | null}
 */
export function findUnreleasedSection(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^##\s+\[Unreleased\]/i.test(l));
  if (start === -1) return null;
  const next = lines.findIndex((l, i) => i > start && /^##\s/.test(l));
  return { start: start + 1, end: next === -1 ? lines.length : next };
}

const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * Added lines of a one-file unified diff, numbered on the new side.
 *
 * @param {string} diff
 * @returns {{line: number, text: string}[]}
 */
export function addedLines(diff) {
  const out = [];
  let next = null;
  for (const line of diff.split('\n')) {
    const hunk = HUNK.exec(line);
    if (hunk) next = Number(hunk[1]);
    else if (next !== null && line.startsWith('+'))
      out.push({ line: next++, text: line.slice(1) });
    else if (next !== null && line.startsWith(' ')) next++;
  }
  return out;
}

/** Added lines that are real entries inside `section`. */
function entriesIn(added, section) {
  return added.filter(
    (a) =>
      a.line > section.start &&
      a.line <= section.end &&
      a.text.trim() !== '' &&
      !a.text.trimStart().startsWith('#'),
  );
}

/** Why the git inputs cannot answer the question, or null when they can. */
function unreadable(inputs) {
  const errors = inputs.errors ?? {};
  if (inputs.changedFiles === null)
    return `cannot list the PR's changed files (${errors.changedFiles})`;
  if (inputs.changedFiles.length === 0)
    return 'the diff lists 0 changed files, so there is nothing to check';
  if (inputs.changelog === null)
    return `cannot read CHANGELOG.md at the PR head (${errors.changelog})`;
  if (inputs.diff === null)
    return `cannot read the CHANGELOG.md diff (${errors.diff})`;
  return null;
}

/** The verdict once the title says an entry is needed. */
function assessEntry(type, body, inputs) {
  const blind = unreadable(inputs);
  if (blind) return { verdict: 'abstain', reason: blind, type };
  const section = findUnreleasedSection(inputs.changelog);
  if (!section)
    return {
      verdict: 'abstain',
      reason: 'CHANGELOG.md at the PR head has no ## [Unreleased] heading',
      type,
    };
  const checked = inputs.changedFiles.length;
  const added = entriesIn(addedLines(inputs.diff), section).length;
  if (added > 0) return { verdict: 'ok', reason: '', type, added, checked };
  return { ...noEntry(type, parseOptOut(body)), checked };
}

/** A user-facing PR with no entry: opted out, or a finding. */
function noEntry(type, optOut) {
  if (optOut.present && optOut.reason)
    return { verdict: 'opted-out', reason: optOut.reason, type };
  const why = optOut.present
    ? ' The PR body says `Changelog: none` but gives no reason; an opt-out must say why.'
    : '';
  return {
    verdict: 'missing',
    reason: `This ${type} PR adds no line under ## [Unreleased] in CHANGELOG.md.${why}`,
    type,
  };
}

/**
 * The verdict for one PR. `read` is only called when the title says an entry
 * is needed, so an exempt PR never depends on git.
 *
 * @param {{title: unknown, body: unknown, read: () => any}} args
 */
export function assess({ title, body, read }) {
  const { kind, type } = classifyTitle(title);
  if (kind === 'unknown')
    return {
      verdict: 'abstain',
      reason: `the PR title ${JSON.stringify(String(title ?? ''))} is not a Conventional Commit of a known type, so the check cannot tell whether it is user-facing`,
      type,
    };
  if (kind === 'exempt')
    return { verdict: 'exempt', reason: `a ${type} PR needs no entry`, type };
  return assessEntry(type, body, read());
}
