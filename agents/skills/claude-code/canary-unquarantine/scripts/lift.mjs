// lift -- switch a quarantined test back on as a text edit that touches only
// the marker, and the trial plan (manifest) that records those edits.
//
// Every edit is computed from the audit's `markerLine`, applied to the line
// it names, and checked: if the line no longer looks like the marker the
// audit saw, the edit is refused rather than guessed. A restore is never an
// "undo" of a lift: the verdict rebuilds each file from the trial's base
// commit plus the lifts that passed, so a failed test's marker comes back byte
// for byte however many other lifts share its file.

import { pyLine } from './python.mjs';

/**
 * `test.skip(` -> `test(`, `test.describe.skip(` -> `test.describe(`, `xit(` ->
 * `it(`, `it.skipIf(cond)(` -> `it(`.
 */
const STATIC_LIFT = [
  [
    /\b((?:test|it|describe|context)(?:\.describe)?)\.(?:skip|fixme)\s*\(/,
    '$1(',
  ],
  [/\bx(it|test|describe)\s*\(/, '$1('],
  [/\b(test|it|describe)\.(?:skipIf|runIf)\([^)]*\)\s*\(/, '$1('],
];

const PYTEST_SKIP =
  /^\s*@(?:(?:pytest\.)?mark\.(?:skip|skipif|xfail)|unittest\.(?:skip|skipIf|skipUnless|expectedFailure))\b/;
const PY_DEF_LINE = /^\s*(?:async\s+)?def\s/;
const DETAILS_TAG = /\{[^}]*\btag\s*:/;

/** An eslint directive that exists only to permit the skip being lifted. */
const SKIP_DIRECTIVE =
  /^\s*\/\/\s*eslint-disable-next-line\b.*(?:skip|disabled-tests)/;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Every pytest skip decorator in the stack starting at line `n`, each with
 * all the lines its wrapped arguments span. Blank and comment lines inside
 * the stack are kept, as the reader keeps them.
 */
function liftPytest(lines, n) {
  const edits = [];
  for (let i = n - 1; i < lines.length && !PY_DEF_LINE.test(lines[i]); i += 1) {
    if (!pyLine(lines[i]).code.trim()) continue;
    if (!/^\s*@/.test(lines[i])) break;
    const skip = PYTEST_SKIP.test(lines[i]);
    let depth = pyLine(lines[i]).depth;
    if (skip) edits.push({ line: i + 1, before: lines[i], after: null });
    while (depth > 0 && i + 1 < lines.length) {
      i += 1;
      depth += pyLine(lines[i]).depth;
      if (skip) edits.push({ line: i + 1, before: lines[i], after: null });
    }
  }
  return edits;
}

/** A `.skip` / `.fixme` / `x` call, plus the eslint directive that only permitted it. */
function liftStatic(lines, n) {
  const at = lines[n - 1];
  const rule = STATIC_LIFT.find(([re]) => re.test(at));
  if (!rule) return null;
  const edits = [{ line: n, before: at, after: at.replace(rule[0], rule[1]) }];
  const above = lines[n - 2];
  if (above !== undefined && SKIP_DIRECTIVE.test(above))
    edits.unshift({ line: n - 1, before: above, after: null });
  return edits;
}

/** A quarantine tag in the title. */
function liftTag(at, n, tags) {
  const tag = tags.find((t) => at.includes(t));
  if (!tag) return null;
  return [
    {
      line: n,
      before: at,
      after: at.replace(new RegExp(`\\s*${escapeRe(tag)}`), ''),
    },
  ];
}

/** Why a marker on line `at` must be lifted by a person, or ''. */
function needsPerson(at, tags) {
  if (PY_DEF_LINE.test(at))
    return 'skipped through its class decorator, not its own: lift the class by hand, or every method under it is released';
  if (DETAILS_TAG.test(at) && tags.some((t) => at.includes(t)))
    return 'the tag is in a Playwright details object; removing it leaves an empty or malformed tag, so lift it by hand';
  return '';
}

/**
 * Plan the edits that lift one marker, or say why it cannot be lifted. A
 * runtime guard is never lifted: it skips on a condition about the
 * environment, and deleting the call would change what the test means rather
 * than switch it back on.
 *
 * @param {string[]} lines file lines
 * @param {{markerLine: number, marker: string, test: string, runtime?: boolean}} row
 * @param {string[]} tags
 * @returns {{edits: {line: number, before: string, after: string|null}[]} | {why: string}}
 */
export function planLift(lines, row, tags = []) {
  const n = row.markerLine;
  const at = lines[n - 1];
  if (row.runtime) {
    return {
      why: 'a runtime guard: it skips on a condition and lifts itself when the condition clears, so there is no marker to edit',
    };
  }
  if (at === undefined) return { why: `line ${n} is past the end of the file` };
  const byHand = needsPerson(at, tags);
  if (byHand) return { why: byHand };
  const edits = PYTEST_SKIP.test(at)
    ? liftPytest(lines, n)
    : (liftStatic(lines, n) ?? liftTag(at, n, tags));
  if (edits) return { edits };
  return {
    why: `line ${n} no longer carries the ${row.marker || 'quarantine'} marker the audit saw`,
  };
}

/**
 * Apply edits to `lines`, last line first so earlier line numbers stay valid.
 * Each edit is checked against its `before`; a mismatch throws.
 */
export function applyEdits(lines, edits) {
  const out = [...lines];
  for (const e of [...edits].sort((a, b) => b.line - a.line)) {
    if (out[e.line - 1] !== e.before) {
      throw new Error(
        `line ${e.line} changed since the plan was made; refusing to edit it`,
      );
    }
    if (e.after === null) out.splice(e.line - 1, 1);
    else out[e.line - 1] = e.after;
  }
  return out;
}

// --- the reverse: switching a test off --------------------------------------

/** Plain declarations a `.skip` can be added to; anything else is refused. */
const SKIPPABLE = /\b((?:test|it|describe|context)(?:\.describe)?)\s*\(/;

const indentOf = (line) => /^\s*/.exec(line)[0];

/** The katana spelling of a JS skip marker: the last segment plus `.skip`. */
const skipMarker = (callee) => `${callee.split('.').pop()}.skip`;

/**
 * Plan the edits that switch the test declared on `line` off, with a comment
 * above naming why. Returns `{edits, marker}` (the marker as the ledger
 * records it) or `{why}`.
 *
 * @param {string[]} lines
 * @param {{line: number, title: string, lang: string}} decl
 * @param {{note: string, tag?: string}} opts `tag` quarantines by title tag
 */
export function planQuarantine(lines, decl, { note, tag }) {
  const at = lines[decl.line - 1];
  const pad = indentOf(at);
  if (decl.lang === 'py') {
    const after = `${pad}# ${note}\n${pad}@pytest.mark.skip(reason=${JSON.stringify(note)})\n${at}`;
    return {
      marker: 'pytest.mark.skip',
      edits: [{ line: decl.line, before: at, after }],
    };
  }
  const comment = `${pad}// ${note}\n`;
  if (tag) {
    const title = new RegExp(`${escapeRe(decl.title)}(?=['"\`])`);
    if (!title.test(at))
      return {
        why: 'the title is not on the declaration line, so a tag cannot be added to it',
      };
    return {
      marker: tag,
      edits: [
        {
          line: decl.line,
          before: at,
          after: comment + at.replace(title, `${decl.title} ${tag}`),
        },
      ],
    };
  }
  const m = SKIPPABLE.exec(at);
  if (!m)
    return {
      why: 'the declaration is not a plain test/it/describe call; quarantine it with a tag instead',
    };
  return {
    marker: skipMarker(m[1]),
    edits: [
      {
        line: decl.line,
        before: at,
        after: comment + at.replace(SKIPPABLE, `$1.skip(`),
      },
    ],
  };
}

// --- the trial plan, carried in the trial PR's body --------------------------

const MANIFEST_TAG = 'canary-unquarantine-trial';
const MANIFEST_RE = new RegExp(`<!-- ${MANIFEST_TAG}\\n([\\s\\S]*?)\\n-->`);

/** The plan as an HTML comment. `--` cannot appear inside one, so it is escaped. */
export function embedManifest(manifest) {
  const json = JSON.stringify(manifest, null, 1).replace(/--/g, '-\\u002d');
  return `<!-- ${MANIFEST_TAG}\n${json}\n-->`;
}

/** The plan from a PR body, or null when no trial opened this PR. */
export function readManifest(body) {
  const m = MANIFEST_RE.exec(body ?? '');
  return m ? JSON.parse(m[1]) : null;
}
