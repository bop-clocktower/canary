#!/usr/bin/env node
// Fail when a Markdown code fence is closed with a language tag.
//
// A fence is opened with ```lang and MUST be closed with a bare fence of at
// least the same length. Writing ```text again to "close" it instead opens a
// NEW block, so everything after it renders as code until the next fence or
// EOF. That corrupted `canary-critical-areas/SKILL.md` (~100 lines of its
// scoring methodology, including the harness-primitive instructions, were
// swallowed) and three other shipped skill docs before this guard existed.
//
// markdownlint does not catch it: an unterminated fence closed by a later fence
// is technically valid Markdown. Neither does a parity check -- two malformed
// closers in one file produce an EVEN fence count with every pair inverted,
// which is how `canary-edge-case-discovery` hid.
//
// Nesting is handled properly: a longer fence may legitimately wrap shorter
// ones (```` around ```), which is how a doc shows Markdown output that itself
// contains code blocks. `canary-test-reporter/SKILL.md` does exactly that and
// must not be flagged.
//
// Exit 0 when clean; exit 1 (listing offenders) otherwise.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Authored Markdown only. Third-party READMEs are not ours to fix.
const SCAN_ROOTS = ['agents/skills', 'docs', 'README.md', 'AGENTS.md'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'archive']);

const FENCE_RE = /^(\s*)(`{3,}|~{3,})(.*)$/;

function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full));
    else if (e.isFile() && e.name.endsWith('.md')) out.push(full);
  }
  return out;
}

function collectFiles() {
  const files = [];
  for (const root of SCAN_ROOTS) {
    const p = resolve(REPO_ROOT, root);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isFile()) files.push(p);
    else files.push(...walk(p));
  }
  return files.sort();
}

/**
 * Scan one file's fences with a marker stack.
 *
 * A line only CLOSES the open block when its marker is the same character and
 * at least as long as the opener's, and carries no info string. A shorter or
 * differently-charactered fence inside an open block is content, not structure.
 */
function checkFile(path) {
  const problems = [];
  const lines = readFileSync(path, 'utf-8').split('\n');
  const stack = [];

  lines.forEach((line, i) => {
    const m = FENCE_RE.exec(line);
    if (m === null) return;
    const marker = m[2];
    const info = m[3].trim();
    const open = stack[stack.length - 1];

    if (open !== undefined) {
      const sameChar = marker[0] === open.marker[0];
      const longEnough = marker.length >= open.marker.length;
      if (sameChar && longEnough) {
        if (info !== '') {
          // The corruption: a closer carrying a language tag.
          problems.push({
            line: i + 1,
            text: line.trim(),
            openedAt: open.line,
          });
          // Treat it as the close it was meant to be, so one mistake does not
          // cascade into every later fence being reported.
        }
        stack.pop();
        return;
      }
      return; // shorter/other fence inside an open block is content
    }
    stack.push({ marker, line: i + 1 });
  });

  if (stack.length > 0) {
    for (const open of stack) {
      problems.push({
        line: open.line,
        text: 'unterminated fence',
        openedAt: 0,
      });
    }
  }
  return problems;
}

const offenders = [];
for (const file of collectFiles()) {
  for (const p of checkFile(file)) {
    const rel = relative(REPO_ROOT, file).split('\\').join('/');
    offenders.push(
      p.openedAt === 0
        ? `${rel}:${p.line}: fence opened here is never closed`
        : `${rel}:${p.line}: closing fence carries a language tag ` +
            `(\`${p.text}\`) — opened at line ${p.openedAt}. Close with a bare fence.`,
    );
  }
}

if (offenders.length > 0) {
  console.error('Malformed Markdown code fences:\n');
  for (const o of offenders) console.error(`  ${o}`);
  console.error(
    '\nA fence closed with a language tag opens a NEW block, so the rest of ' +
      'the\ndocument renders as code. Close with a bare ``` instead.\n',
  );
  process.exit(1);
}

console.log(
  'check_doc_fences: clean — all code fences open and close correctly.',
);
