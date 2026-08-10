#!/usr/bin/env node
// Restore docs/roadmap.md's header comment block if the harness roadmap
// tooling has stripped it.
//
// The defect is upstream, in `@harness-engineering/cli`, and shows up on more
// than one subcommand: `roadmap promote` (tracked here as #273) and a
// `roadmap shard` + `roadmap regen` round-trip (#629, reproduced on v10.2.0 and
// v11.1.1). `shard` persists the block into neither a shard nor `_meta.md`, so
// `regen` rebuilds the aggregate without it — exit 0, no warning. Reported
// upstream as Intense-Visions/harness-engineering#1328. Nothing in this repo
// can fix the serializer, so this script repairs the damage instead.
//
// Both halves of the block matter, for different reasons:
//   - the MD013 directive silences markdownlint on the long single-line-per-
//     field summaries the roadmap schema requires; losing it fails the required
//     docs-lint check loudly.
//   - the note below it is the only in-file record of *why* the file is
//     prettier-exempt and must not be reflowed; losing it fails nothing at all.
// So detection keys off both. Keying off the directive alone would report a
// healthy header after a partial strip, and the directive is exactly the line
// someone chasing a lint failure would paste back by hand.
//
// Usage: `node scripts/roadmap_comment_guard.mjs [--roadmap <path>]`. The
// pre-commit hook invokes it before the markdownlint step. Idempotent — a
// byte-for-byte no-op when the block is already intact.
//
// Exit codes follow the repo's gate convention (#508):
//   0 = block present, or restored
//   2 = error (the roadmap file is not there at all)
//   3 = ZERO DENOMINATOR — no `# Roadmap` heading, so there is no insertion
//       point and nothing was checked. An abstention, never a pass.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_ROADMAP = resolve(REPO_ROOT, 'docs', 'roadmap.md');

const DISABLE_COMMENT = '<!-- markdownlint-disable-file MD013 -->';
const NOTE_MARKER = 'Machine-managed by harness roadmap tooling';
const COMMENT_BLOCK =
  `${DISABLE_COMMENT}\n` +
  '<!-- Machine-managed by harness roadmap tooling: each feature field is a single\n' +
  '     line by schema contract, so the 80-column line-length rule does not apply.\n' +
  '     Completed work lives in docs/roadmap-archive.md — move it there with\n' +
  '     `node scripts/roadmap-groom.mjs --apply`. There is no `harness roadmap\n' +
  '     groom`; this comment claimed one for months while ten done rows piled up\n' +
  '     here (#595). -->\n';

const HEADING_PATTERN = /^# Roadmap\n\n/m;
/** The run of HTML comments immediately below the heading, if any. */
const LEADING_COMMENTS = /^(?:<!--[\s\S]*?-->\n)+/;

/** `--roadmap <path>`, else the repo's own roadmap. */
function roadmapPath(argv) {
  const flag = argv.indexOf('--roadmap');
  return flag === -1 || flag === argv.length - 1
    ? DEFAULT_ROADMAP
    : resolve(argv[flag + 1]);
}

function main(argv) {
  const roadmap = roadmapPath(argv);

  if (!existsSync(roadmap)) {
    process.stdout.write(
      `[roadmap-comment-guard] no such file: ${roadmap} — checked nothing\n`,
    );
    return 2;
  }

  const text = readFileSync(roadmap, 'utf-8');
  const match = HEADING_PATTERN.exec(text);
  if (match === null) {
    process.stdout.write(
      '[roadmap-comment-guard] ZERO DENOMINATOR: no `# Roadmap` heading in ' +
        `${roadmap} — no insertion point, so nothing was checked\n`,
    );
    return 3;
  }

  const insertAt = match.index + match[0].length;
  const rest = text.slice(insertAt);
  const found = LEADING_COMMENTS.exec(rest);
  const existing = found === null ? '' : found[0];

  // Intact means both markers survived. Anything a human added alongside them
  // is left untouched; a strip is repaired by replacing the remnant wholesale,
  // which is also what keeps a partial strip from duplicating the directive.
  if (existing.includes(DISABLE_COMMENT) && existing.includes(NOTE_MARKER)) {
    return 0;
  }

  const restored =
    text.slice(0, insertAt) +
    COMMENT_BLOCK +
    (existing === '' ? '\n' : '') +
    rest.slice(existing.length);
  writeFileSync(roadmap, restored);
  process.stdout.write(
    '[roadmap-comment-guard] restored the header comment block ' +
      '(upstream strip: harness-engineering#1328)\n',
  );
  return 0;
}

process.exit(main(process.argv.slice(2)));
