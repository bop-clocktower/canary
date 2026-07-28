#!/usr/bin/env node
// Restore docs/roadmap.md's markdownlint-disable comment block if missing.
//
// harness roadmap tooling's `promote` action regenerates docs/roadmap.md and
// silently drops the hand-placed comment block right after the `# Roadmap`
// heading (upstream harness-engineering bug, tracked at
// bop-clocktower/canary#273 — the serializer doesn't round-trip leading HTML
// comments the way it does YAML frontmatter). Without the disable comment,
// markdownlint's MD013 line-length rule fails on the long single-line-per-field
// feature summaries the roadmap schema requires.
//
// Run with no arguments; the pre-commit hook invokes this before the
// markdownlint step so a dropped comment never surfaces as a confusing lint
// failure. Idempotent — a no-op if the comment is already present.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROADMAP = resolve(REPO_ROOT, 'docs', 'roadmap.md');

const DISABLE_COMMENT = '<!-- markdownlint-disable-file MD013 -->';
const COMMENT_BLOCK =
  `${DISABLE_COMMENT}\n` +
  '<!-- Machine-managed by harness roadmap tooling: each feature field is a single\n' +
  '     line by schema contract, so the 80-column line-length rule does not apply.\n' +
  '     Completed work lives in docs/roadmap-archive.md (run: harness roadmap groom). -->\n';

const HEADING_PATTERN = /^# Roadmap\n\n/m;

function main() {
  if (!existsSync(ROADMAP)) return 0;

  const text = readFileSync(ROADMAP, 'utf-8');
  if (text.includes(DISABLE_COMMENT)) return 0;

  const match = HEADING_PATTERN.exec(text);
  if (!match) return 0;

  const insertAt = match.index + match[0].length;
  const newText =
    text.slice(0, insertAt) + COMMENT_BLOCK + '\n' + text.slice(insertAt);
  writeFileSync(ROADMAP, newText);
  process.stdout.write(
    '[roadmap-comment-guard] restored markdownlint-disable comment block (canary#273)\n',
  );
  return 0;
}

process.exit(main());
