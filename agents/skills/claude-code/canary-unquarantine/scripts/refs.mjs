// refs -- find the tracker references a quarantine is waiting on.
//
// A reference is either a GitHub issue (`#12`, `owner/repo#12`, an issue or
// pull URL) or a Jira ticket (`ABC-123`, or a `/browse/ABC-123` URL).
//
// Bare Jira-shaped keys are the hard case. Test ids look exactly like them --
// `CASE-065` is a case id in a title, not a ticket -- so a bare key is only
// believed when the context says it is a ticket:
//
//   - it follows a blocker phrase ("quarantined against UP-1", "filed as
//     **UP-1**"), or
//   - its project is one company.json lists in `jira_projects`.
//
// Any key that also appears in the row's own test title is an identifier of
// the test, never its blocker, whatever the context.

const GH_URL =
  /https?:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(?:issues|pull)\/(\d+)/g;
const GH_QUALIFIED = /\b([\w.-]+\/[\w.-]+)#(\d+)\b/g;
const GH_SHORT = /(^|[^\w/&#])#(\d+)\b/g;
const JIRA_URL = /(https?:\/\/[^\s/)\]>"']+)\/browse\/([A-Z][A-Z0-9_]+-\d+)/g;
const JIRA_KEY = /\b([A-Z][A-Z0-9_]{1,9})-(\d+)\b/g;

/**
 * Words that, just before a reference, say "this is what the test waits on".
 * Matched against the text between the previous sentence break and the ref.
 */
const BLOCKER_PHRASE =
  /\b(?:against|blocked\s+(?:by|on)|waiting\s+on|parked\s+(?:on|there)|tracked\s+(?:in|by|as)|filed\s+(?:as|in|upstream)|(?:re-?)?filed\s+by\s+@?[\w-]+\s+as|raised\s+as|moved\s+to)\W{0,6}$/i;

/**
 * @typedef {{tracker: string, id: string, index: number, text: string,
 *            anchored?: boolean, repo?: string|null, number?: number,
 *            key?: string, project?: string, base?: string|null}} Ref
 */

/** Title tokens shaped like Jira keys (test case ids), never blockers. */
export function idTokens(title) {
  return new Set([...String(title ?? '').matchAll(JIRA_KEY)].map((m) => m[0]));
}

const ghRef = (repo, number, index, text) => ({
  tracker: 'github',
  repo,
  number: Number(number),
  id: repo ? `${repo}#${number}` : `#${number}`,
  index,
  text,
});

/** A Jira key's project: everything before its last dash. */
export const jiraProject = (key) =>
  String(key).slice(0, String(key).lastIndexOf('-'));

/** What a later step needs to reach a Jira ticket again: key, project, site. Empty for other trackers. */
export const jiraReach = (ref) =>
  ref.tracker === 'jira'
    ? { key: ref.key, project: ref.project, base: ref.base ?? null }
    : {};

const jiraRef = (key, base, index, text) => ({
  tracker: 'jira',
  key,
  project: jiraProject(key),
  base,
  id: key,
  index,
  text,
});

/** Blank out a matched span so a shorter pattern cannot match inside it. */
function blank(s, start, end) {
  return s.slice(0, start) + ' '.repeat(end - start) + s.slice(end);
}

/** Does a blocker phrase sit right before `index` in the same sentence? */
function anchored(text, index) {
  const before = text.slice(Math.max(0, index - 60), index);
  const sentence = before.split(/[.\n;]\s/).pop() ?? before;
  return BLOCKER_PHRASE.test(sentence.replace(/[*_`]/g, ''));
}

/**
 * Every reference in `text`, in order of appearance.
 *
 * @param {string} text
 * @returns {Ref[]}
 * @param {{jiraProjects?: string[], exclude?: Set<string>,
 *          anyBareJira?: boolean}} [opts]
 *   `anyBareJira` believes every bare key (used on hand-off lines, whose
 *   whole subject is a filing); otherwise a bare key needs an anchor or a
 *   configured project.
 */
export function extractRefs(text, opts = {}) {
  const src = String(text ?? '');
  const projects = new Set(opts.jiraProjects ?? []);
  const exclude = opts.exclude ?? new Set();
  const refs = [];
  let rest = src;

  for (const m of src.matchAll(GH_URL)) {
    refs.push({
      ...ghRef(m[1], m[2], m.index, m[0]),
      anchored: anchored(src, m.index),
    });
    rest = blank(rest, m.index, m.index + m[0].length);
  }
  for (const m of src.matchAll(JIRA_URL)) {
    refs.push({ ...jiraRef(m[2], m[1], m.index, m[0]), anchored: true });
    rest = blank(rest, m.index, m.index + m[0].length);
  }
  for (const m of rest.matchAll(GH_QUALIFIED)) {
    refs.push({
      ...ghRef(m[1], m[2], m.index, m[0]),
      anchored: anchored(src, m.index),
    });
    rest = blank(rest, m.index, m.index + m[0].length);
  }
  for (const m of rest.matchAll(GH_SHORT)) {
    const at = m.index + m[1].length;
    refs.push({
      ...ghRef(null, m[2], at, `#${m[2]}`),
      anchored: anchored(src, at),
    });
  }
  for (const m of rest.matchAll(JIRA_KEY)) {
    const key = m[0];
    if (exclude.has(key)) continue;
    const isAnchored = anchored(src, m.index);
    const believed =
      isAnchored ||
      opts.anyBareJira ||
      projects.has(key.slice(0, key.lastIndexOf('-')));
    if (believed)
      refs.push({ ...jiraRef(key, null, m.index, key), anchored: isAnchored });
  }
  return dedupe(
    refs.filter((r) => !(r.tracker === 'jira' && exclude.has(r.key))),
  ).sort((a, b) => a.index - b.index);
}

/** One ref per id; a Jira URL (it carries the base) wins over a bare key. */
function dedupe(refs) {
  const byId = new Map();
  for (const r of refs) {
    const prev = byId.get(r.id);
    if (!prev) byId.set(r.id, r);
    else if (!prev.base && r.base)
      byId.set(r.id, {
        ...r,
        index: prev.index,
        anchored: prev.anchored || r.anchored,
      });
    else if (r.anchored && !prev.anchored)
      byId.set(r.id, { ...prev, anchored: true });
  }
  return [...byId.values()];
}

/** Which sentence of `text` offset `index` falls in (breaks: `. ` / `! ` / `? ` / newline). */
const sentenceOf = (text, index) =>
  (
    String(text)
      .slice(0, index)
      .match(/[.!?](?=\s)|\n/g) ?? []
  ).length;

/**
 * The blocker named by one source of text: every anchored reference in the
 * first sentence that carries one ("quarantined against #12; also blocked by
 * UP-7" waits on both), otherwise every reference the text carries.
 *
 * @returns {{refs: Ref[], anchored: boolean}}
 */
export function pickBlocker(text, opts = {}) {
  const refs = extractRefs(text, opts);
  const first = refs.find((r) => r.anchored);
  if (!first) return { refs, anchored: false };
  const s = sentenceOf(text, first.index);
  return {
    refs: refs.filter((r) => r.anchored && sentenceOf(text, r.index) === s),
    anchored: true,
  };
}

/**
 * Words on a line of a CLOSED issue that say the work moved somewhere else
 * rather than being fixed: "Filed as UP-1", "CASE-065 is parked there",
 * "superseded by #9", "moves the rows to #12".
 */
const HANDOFF_LINE =
  /\b(?:(?:re-?)?filed|raised|tracked|mov(?:e|ed|es|ing)|superseded|duplicate|parked|continu(?:e|es|ed)|follow[- ]?up|carried|split\s+into|replaced\s+by)\b/i;

/**
 * Comment authors whose hand-off lines are not believed: anyone can comment on
 * a public issue, and a stranger's "Moved to #9" must not re-route a blocker.
 * A comment with no association recorded is read as trusted.
 */
const UNTRUSTED = new Set([
  'NONE',
  'FIRST_TIMER',
  'FIRST_TIME_CONTRIBUTOR',
  'CONTRIBUTOR',
]);

/** A hand-off whose target this audit has no way to read: it abstains. */
const unreadable = (line) => ({
  tracker: 'unreadable',
  id: `hand-off "${line.trim().slice(0, 60)}"`,
  why: `hand-off line names a target this audit cannot read: "${line.trim()}"`,
  index: 0,
  text: line,
});

/**
 * The hand-off lines in one text, each with the refs it names. Every key on a
 * hand-off line is believed (`anyBareJira`): the line's whole subject is a
 * filing. A line ending in `:` takes its target from the next line ("Filed
 * upstream:\nUP-1"); a hand-off line that names nothing readable (a foreign
 * tracker URL, a key with no project) is kept as an unreadable ref.
 */
function handoffLines(text, ids, ctx) {
  const lines = String(text).split('\n');
  const read = (s) =>
    extractRefs(s, {
      jiraProjects: ctx.jiraProjects,
      exclude: ids,
      anyBareJira: true,
    }).filter((r) => r.id !== ctx.self);
  return lines.flatMap((line, i) => {
    if (!HANDOFF_LINE.test(line)) return [];
    let refs = read(line);
    if (!refs.length && /:\s*$/.test(line))
      refs = read(lines.slice(i + 1).find((l) => l.trim()) ?? '');
    return [{ line, refs: refs.length ? refs : [unreadable(line)] }];
  });
}

/**
 * Hand-off targets in a closed issue's body and every trusted comment. Every
 * hand-off line counts, not only the newest comment's: merging leans toward
 * blocked, where newest-wins let any later hand-off-shaped comment erase a
 * real filing.
 *
 * When some hand-off lines name one of the row's own test ids (`CASE-065`),
 * only those lines count -- a closing comment that routes five cases to five
 * issues must not make every row wait on all five.
 *
 * @param {{body?: string, comments?: {body: string, author_association?: string}[]}} issue
 * @param {{title?: string, self?: string, jiraProjects?: string[]}} ctx
 * @returns {Ref[]} refs (empty: no hand-off, the issue was simply closed)
 */
export function handoffRefs(issue, ctx = {}) {
  const ids = idTokens(ctx.title);
  const texts = [
    issue.body ?? '',
    ...(issue.comments ?? [])
      .filter((c) => !UNTRUSTED.has(c.author_association))
      .map((c) => c.body ?? ''),
  ];
  const lines = texts.flatMap((t) => handoffLines(t, ids, ctx));
  const named = lines.filter((l) => [...ids].some((id) => l.line.includes(id)));
  return dedupe((named.length ? named : lines).flatMap((l) => l.refs));
}
