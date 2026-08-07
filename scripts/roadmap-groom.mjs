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
    if (argv[i] === '--apply') opts.apply = true;
    else if (argv[i] === '--roadmap') opts.roadmap = resolve(argv[++i]);
    else if (argv[i] === '--archive') opts.archive = resolve(argv[++i]);
  }
  return opts;
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
  if (!shipped) fail(`archive has no \`${ARCHIVE_SECTION}\` section to append to`);

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

  if (!opts.apply) {
    console.log('i Dry run — nothing written. Re-run with --apply.');
    return;
  }

  shipped.rows.push(...moved);
  writeFileSync(opts.roadmap, serialize(roadmap));
  writeFileSync(opts.archive, serialize(archive));
}

main();
