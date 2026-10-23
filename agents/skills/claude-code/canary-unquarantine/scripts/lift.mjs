// lift -- switch a quarantined test back on as a text edit that touches only
// the marker, and the trial plan (manifest) that records those edits.
//
// Every edit is computed from the audit's `markerLine`, applied to the line
// it names, and checked: if the line no longer looks like the marker the
// audit saw, the edit is refused rather than guessed. A restore is never an
// "undo" of a lift: the verdict rebuilds each file from the trial's base
// commit plus the lifts that passed, so a failed test's marker comes back byte
// for byte however many other lifts share its file.

/** `test.skip(` -> `test(`, `test.describe.skip(` -> `test.describe(`, `xit(` -> `it(`. */
const STATIC_LIFT = [
  [
    /\b((?:test|it|describe|context)(?:\.describe)?)\.(?:skip|fixme)\s*\(/,
    '$1(',
  ],
  [/\bx(it|test|describe)\s*\(/, '$1('],
];

const PYTEST_SKIP = /^\s*@pytest\.mark\.(?:skip|skipif|xfail)\b/;

/** An eslint directive that exists only to permit the skip being lifted. */
const SKIP_DIRECTIVE =
  /^\s*\/\/\s*eslint-disable-next-line\b.*(?:skip|disabled-tests)/;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Every pytest skip decorator in the stack starting at line `n`. */
function liftPytest(lines, n) {
  const edits = [];
  for (let i = n - 1; i < lines.length && /^\s*@/.test(lines[i]); i += 1) {
    if (PYTEST_SKIP.test(lines[i]))
      edits.push({ line: i + 1, before: lines[i], after: null });
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
