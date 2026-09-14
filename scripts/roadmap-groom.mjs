#!/usr/bin/env node
// Move completed roadmap rows into the archive (#595).
//
// `docs/roadmap.md`, `docs/roadmap-archive.md`, and `roadmap_comment_guard.mjs`
// all tell the reader to run `harness roadmap groom`. That subcommand does not
// exist — the CLI ships migrate, shard, unshard, regen, reconcile, and sync.
// Grooming has therefore always been a hand edit against a file whose own header
// says it is automated, which is how ten `done` rows accumulated in the live
// roadmap alongside active work.
//
// A stale `done` row is not cosmetic. `harness roadmap sync` reads any row
// lacking an `External-ID` as a row needing a tracker issue, so every completed
// row left here is one duplicate issue waiting for someone to pass `--apply`.
//
//   node scripts/roadmap-groom.mjs                 # dry run (the default)
//   node scripts/roadmap-groom.mjs --apply
//   node scripts/roadmap-groom.mjs --roadmap a.md --archive b.md
//
// Exit codes follow the gate convention (#508):
//   0  examined rows and reported (or wrote) a result
//   2  error — missing file, or an archive with no `## Shipped` section
//   3  ZERO DENOMINATOR — parsed no rows at all. An abstention, never a pass:
//      "nothing to groom" and "the parser broke" must not look identical.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ARCHIVE_SECTION = '## Shipped';

function parseArgs(argv) {
  const opts = {
    roadmap: resolve(REPO_ROOT, 'docs', 'roadmap.md'),
    archive: resolve(REPO_ROOT, 'docs', 'roadmap-archive.md'),
    apply: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = FLAGS[argv[i]];
    if (flag) i += flag(opts, argv[i + 1]);
  }
  return opts;
}

// Each handler returns how many extra argv entries it consumed.
const FLAGS = {
  '--apply': (o) => ((o.apply = true), 0),
  '--roadmap': (o, v) => ((o.roadmap = resolve(v)), 1),
  '--archive': (o, v) => ((o.archive = resolve(v)), 1),
  '--issue-states': (o, v) => ((o.issueStates = resolve(v)), 1),
  '--check-issues': (o) => ((o.checkIssues = true), 0),
};

const EXTERNAL_ID_RE =
  /^- \*\*External-ID:\*\*\s*github:([\w.-]+\/[\w.-]+)#(\d+)\s*$/;

/** Parsed JSON from a `gh` call, or null when gh could not answer. */
function ghJson(args) {
  const r = spawnSync('gh', args, { encoding: 'utf8', timeout: 30_000 });
  return r.status === 0 ? JSON.parse(r.stdout) : null;
}

/**
 * Only a CLOSING reference counts. A bare `#n` mention is noise: measured on
 * this roadmap, roadmap and doc PRs (#596, #597, #859) cite dozens of issues
 * they did not resolve, and counting mentions flagged 44 of 53 rows stale.
 */
function closingPrs(prs, n) {
  const closes = new RegExp(
    `\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s+#${n}(?!\\d)`,
    'i',
  );
  return prs.filter((p) => closes.test(p.body ?? '')).map((p) => p.number);
}

/**
 * Ask GitHub for one issue's state and the merged PRs that close it. Returns
 * null when gh cannot answer, so an outage reads as "not checked", never "open".
 */
function liveIssueState(repo, n) {
  const issue = ghJson(['issue', 'view', n, '--repo', repo, '--json', 'state']);
  const search = ['--search', `${n} in:body`, '--json', 'number,body'];
  const prs = ghJson([
    'pr',
    'list',
    '--repo',
    repo,
    '--state',
    'merged',
    ...search,
  ]);
  if (!issue || !prs) return null;
  return { state: issue.state, mergedPrs: closingPrs(prs, n) };
}

/** Where issue states come from: a fixture file, live gh, or nowhere. */
function trackerLookup(opts) {
  if (opts.issueStates) {
    const fixture = JSON.parse(readFileSync(opts.issueStates, 'utf-8'));
    return (_repo, n) => fixture[n] ?? null;
  }
  return opts.checkIssues ? liveIssueState : null;
}

/** Why a row is stale, or an empty list when its tracker says it is live. */
function staleReasons(state) {
  const why =
    String(state.state).toUpperCase() === 'CLOSED' ? ['issue closed'] : [];
  return why.concat(
    (state.mergedPrs ?? []).map((pr) => `merged PR #${pr} closes it`),
  );
}

/** Classify one not-done row into the tally; returns nothing. */
function checkRow(row, lookup, tally) {
  const id = row.lines.map((l) => EXTERNAL_ID_RE.exec(l)).find(Boolean);
  if (!id) return void (tally.unlinked += 1);
  tally.linked += 1;
  const [, repo, n] = id;
  const state = lookup(repo, n);
  if (!state) return void (tally.unknown += 1);
  const why = staleReasons(state);
  if (why.length > 0)
    tally.stale.push(`${row.name} — ${repo}#${n}: ${why.join('; ')}`);
}

/**
 * Surface not-done rows whose tracker issue is closed or already has a merged
 * PR closing it (#879). The groom never looked at GitHub, so shipped work sat
 * as `backlog` and got ranked into build batches. This REPORTS only:
 * reconciling a row is a human call, so nothing here writes, with or without
 * --apply.
 */
function reportStaleRows(roadmap, opts) {
  const lookup = trackerLookup(opts);
  if (!lookup) {
    console.log(
      'i Tracker not checked — pass --check-issues (live gh) or ' +
        '--issue-states <file> to flag rows whose issue already closed or merged.',
    );
    return;
  }
  const tally = { linked: 0, unlinked: 0, unknown: 0, stale: [] };
  const rows = roadmap.sections
    .flatMap((s) => s.rows)
    .filter((r) => !isDone(r));
  for (const row of rows) checkRow(row, lookup, tally);

  console.log(
    `i Checked ${tally.linked} linked row(s): ${tally.stale.length} stale; ` +
      `${tally.unknown} linked row(s) not checked (no tracker answer); ` +
      `${tally.unlinked} row(s) with no External-ID.`,
  );
  for (const line of tally.stale) console.log(`! ${line}`);
  if (tally.stale.length > 0) {
    console.log(
      'i Stale rows are reported, not moved — reconcile them by hand.',
    );
  }
}

/**
 * Split a roadmap document into `{ preamble, sections }`.
 *
 * A section is a `## ` heading plus the `### ` rows under it. Row text is kept
 * verbatim — grooming must never reformat a summary on its way past, or the
 * archive stops being a faithful record of what shipped.
 */
function parseDocument(text) {
  const lines = text.split('\n');
  const preamble = [];
  const sections = [];

  let section = null;
  let row = null;

  const closeRow = () => {
    if (row) section.rows.push(row);
    row = null;
  };

  for (const line of lines) {
    if (line.startsWith('## ')) {
      closeRow();
      section = { heading: line, rows: [] };
      sections.push(section);
    } else if (line.startsWith('### ') && section) {
      closeRow();
      row = { name: line.slice(4).trim(), lines: [line] };
    } else if (row) {
      row.lines.push(line);
    } else if (section) {
      // Prose between a heading and its first row is rare but must survive.
      section.heading += `\n${line}`;
    } else {
      preamble.push(line);
    }
  }
  closeRow();

  return { preamble, sections };
}

const rowText = (row) => row.lines.join('\n').trimEnd();

const isDone = (row) =>
  row.lines.some((l) => /^- \*\*Status:\*\*\s*done\s*$/.test(l));

/** Re-emit a document, normalising to one blank line between blocks. */
function serialize({ preamble, sections }) {
  const blocks = [preamble.join('\n').trimEnd()];
  for (const section of sections) {
    blocks.push(section.heading.trimEnd());
    for (const row of section.rows) blocks.push(rowText(row));
  }
  return `${blocks.filter((b) => b.length > 0).join('\n\n')}\n`;
}

function fail(message) {
  console.error(`x ${message}`);
  process.exit(2);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));

  for (const [label, path] of [
    ['roadmap', opts.roadmap],
    ['archive', opts.archive],
  ]) {
    if (!existsSync(path)) fail(`${label} not found: ${path}`);
  }

  const roadmap = parseDocument(readFileSync(opts.roadmap, 'utf-8'));
  const archive = parseDocument(readFileSync(opts.archive, 'utf-8'));

  const examined = roadmap.sections.reduce((n, s) => n + s.rows.length, 0);
  if (examined === 0) {
    console.error(
      'x ZERO DENOMINATOR: parsed no rows from the roadmap — abstaining rather ' +
        'than reporting "nothing to groom". Check the file, not the result.',
    );
    process.exit(3);
  }

  const shipped = archive.sections.find(
    (s) => s.heading.split('\n')[0].trim() === ARCHIVE_SECTION,
  );
  if (!shipped)
    fail(`archive has no \`${ARCHIVE_SECTION}\` section to append to`);

  const moved = [];
  for (const section of roadmap.sections) {
    const keep = [];
    for (const row of section.rows) {
      if (isDone(row)) moved.push(row);
      else keep.push(row);
    }
    // The heading stays even when it empties: removing it would silently
    // reparent whatever row is added next.
    section.rows = keep;
  }

  console.log(
    `i Examined ${examined} row(s); ${moved.length} row(s) moved to ` +
      `${ARCHIVE_SECTION}${opts.apply ? '' : ' [dry-run]'}.`,
  );
  for (const row of moved) console.log(`  ${row.name}`);

  reportStaleRows(roadmap, opts);

  if (!opts.apply) {
    console.log('i Dry run — nothing written. Re-run with --apply.');
    return;
  }

  shipped.rows.push(...moved);
  writeFileSync(opts.roadmap, serialize(roadmap));
  writeFileSync(opts.archive, serialize(archive));
}

main();
