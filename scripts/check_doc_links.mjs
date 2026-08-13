#!/usr/bin/env node
// Dead-link checker for the repository's Markdown (#686).
//
// This duplicates a capability harness already claims to provide, and it
// exists because that implementation cannot deliver it on this repo. Measured
// on `@harness-engineering/cli` 11.1.1, `harness ci check` reports 27
// structural doc-drift findings here and **all 27 are detector defects**:
//
//   Class A (24) — `extractFileLinks` has no fence awareness. It scans raw
//   file content, so a link quoted inside a ```markdown fence is resolved
//   relative to the quoting file rather than the file being quoted. Every
//   plan doc under `docs/changes/` embeds the README it creates that way, so
//   the links are correct for a reader and dead for the detector.
//
//   Class B (3) — `slugifyHeading` runs `.trim()` before hyphenating, so the
//   heading `## 📖 Usage` slugs to `usage`. GitHub strips the emoji and turns
//   the orphaned leading space into a hyphen: `#-usage`. The three links in
//   `agents/skills/README.md` work in a browser and are reported broken.
//
// Both are filed upstream. Until they ship, the 27 stand (ADR 0012), and a
// standing floor of 27 is the real cost: finding #28 — an actually dead link,
// the thing #676 opened to remove — is indistinguishable from the noise.
//
// The tempting local mute is `entropy.drift.docPaths`. It is an **allowlist**.
// Narrowing it to drop `docs/changes/` and `docs/plans/` also drops
// `docs/knowledge/`, `docs/runbooks/`, and every directory added after the
// list was written — and `docs/changes/` is exactly where #676 found real dead
// links. That trade buys quiet by shrinking the denominator, which is the
// false-green shape ADR 0012 exists to prevent. So this script takes no path
// allowlist at all: it walks everything that is not a build or dependency
// directory, and it abstains rather than passing when it scanned nothing.
//
// Usage:
//   node scripts/check_doc_links.mjs [--root <dir>] [--json]
//
// Exit codes follow the repo's gate convention (#508) and ADR 0009:
//   0 = verified — every link resolves
//   1 = findings — at least one dead link or missing anchor
//   2 = error — the scan root is unreadable
//   3 = ABSTENTION — zero Markdown files scanned, so nothing was measured

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Build output, dependencies, and VCS internals. Deliberately short: every
// entry here is a directory that contains no authored documentation, and
// anything not on this list is scanned. Adding a content directory here would
// be the allowlist mistake wearing a different hat.
const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  'test-results',
  'playwright-report',
  '__pycache__',
  '.venv',
  'venv',
  '.pytest_cache',
  'worktrees',
]);

const FENCE_RE = /^(\s*)(`{3,}|~{3,})(.*)$/;

/**
 * Strip fenced code blocks, replacing their lines with empty ones so every
 * surviving line keeps its original number.
 *
 * A fence closes only on a bare fence of at least the opener's length, which
 * is what lets ````markdown legitimately wrap ``` blocks — the shape the plan
 * docs use, and the one a naive open/close toggle gets wrong by re-opening on
 * the inner fence and exposing the second half of the quoted file.
 */
function blankFencedLines(lines) {
  const out = [];
  let openWith = null;
  for (const line of lines) {
    const m = FENCE_RE.exec(line);
    if (openWith === null) {
      if (m) openWith = m[2];
      out.push(m ? '' : line);
      continue;
    }
    // Inside a fence: only a bare fence of the same character, at least as
    // long as the opener, closes it.
    if (
      m &&
      m[2][0] === openWith[0] &&
      m[2].length >= openWith.length &&
      !m[3].trim()
    ) {
      openWith = null;
    }
    out.push('');
  }
  return out;
}

/** Blank out inline code spans so `[text](./nope.md)` in prose is not a link. */
function blankCodeSpans(line) {
  return line.replace(/(`+)([^`]|[^`][\s\S]*?)\1/g, (m) =>
    ' '.repeat(m.length),
  );
}

/**
 * GitHub's heading slugger.
 *
 * Lowercase, drop everything that is not a letter, number, space, hyphen, or
 * underscore, then map each remaining whitespace character to a hyphen. The
 * order matters and is the whole of defect Class B: there is **no trim**, so a
 * heading whose only leading character was an emoji keeps the space the emoji
 * left behind and slugs to `-usage`, not `usage`. Repeated slugs get GitHub's
 * `-1`, `-2` … disambiguating suffix.
 */
function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

/** Every anchor GitHub would generate for a Markdown file's headings. */
function headingSlugs(content) {
  const slugs = new Set();
  const seen = new Map();
  const lines = blankFencedLines(content.split('\n'));
  for (const line of lines) {
    const m = /^ {0,3}#{1,6}[ \t]+(.+?)[ \t]*#*\s*$/.exec(line);
    if (!m) continue;
    // Heading text is inline Markdown: `## [Foo](x)` anchors on "Foo".
    const text = m[1]
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/[*_`]/g, '');
    const base = slugify(text);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    slugs.add(n === 0 ? base : `${base}-${n}`);
  }
  return slugs;
}

function unbracket(target) {
  return target.startsWith('<') && target.endsWith('>')
    ? target.slice(1, -1)
    : target;
}

/**
 * Every link target in a document: inline `[text](target)` **and**
 * reference-style `[label]: target` definitions. Fenced blocks and inline code
 * spans are excluded.
 *
 * Reference definitions are not an edge case here — this repo carries 21, and
 * one of them (`docs/plans/host-llm-migration.md` → `../adr/…`) was left dead
 * by the `docs/adr/` → `docs/knowledge/decisions/` move. A checker that reads
 * only the inline form would have reported a confident zero over it.
 */
function extractLinks(content) {
  const links = [];
  const lines = blankFencedLines(content.split('\n'));
  const inlineRe =
    /\[[^\]]*\]\(\s*(<[^>]*>|[^)\s]+)(?:\s+"[^"]*"|\s+'[^']*')?\s*\)/g;
  const defRe =
    /^ {0,3}\[[^\]]+\]:\s+(<[^>]*>|\S+)(?:\s+("[^"]*"|'[^']*'|\([^)]*\)))?\s*$/;

  for (let i = 0; i < lines.length; i += 1) {
    const line = blankCodeSpans(lines[i]);

    const def = defRe.exec(line);
    if (def) {
      links.push({ target: unbracket(def[1]), line: i + 1 });
      continue;
    }

    let m;
    while ((m = inlineRe.exec(line)) !== null) {
      links.push({ target: unbracket(m[1]), line: i + 1 });
    }
  }
  return links;
}

/** Links this checker has no business resolving on the filesystem. */
function isExternal(target) {
  if (!target) return true;
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return true; // http:, mailto:, tel:, …
  if (target.startsWith('//')) return true;
  if (target.startsWith('#')) return true; // in-page anchor
  if (target.includes('<') || target.includes('{')) return true; // placeholder
  return false;
}

function walk(dir, acc) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') && e.name !== '.github') continue;
    if (SKIP_DIRS.has(e.name)) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full, acc);
    else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) acc.push(full);
  }
  return acc;
}

function decode(p) {
  try {
    return decodeURIComponent(p);
  } catch {
    return p;
  }
}

/**
 * Files stamped by a generator ("Do not edit"). Their links are the
 * generator's output, not this repo's prose — `harness
 * generate-agent-definitions` emits 30 links to `references/*.md` files it
 * never writes, which is a third upstream defect and not one a commit here can
 * repair. They are counted and reported separately rather than excluded by
 * path, so the day one of these trees becomes hand-authored it re-enters the
 * gate on its own. `docs-lint.yml` already draws the same line for
 * markdownlint (`--ignore agents/agents --ignore agents/commands`).
 */
const GENERATED_RE = /generated by [^\n]*do not edit/i;

function check(root) {
  const files = walk(root, []);
  const findings = [];
  const generated = [];
  const slugCache = new Map();
  let generatedFiles = 0;

  for (const file of files) {
    const content = readFileSync(file, 'utf8');
    const isGenerated = GENERATED_RE.test(content);
    if (isGenerated) generatedFiles += 1;
    const sink = isGenerated ? generated : findings;
    for (const { target, line } of extractLinks(content)) {
      if (isExternal(target)) continue;

      const hash = target.indexOf('#');
      const pathPart = decode(hash === -1 ? target : target.slice(0, hash));
      const anchor =
        hash === -1 ? null : decode(target.slice(hash + 1)).toLowerCase();
      if (!pathPart) continue;

      const resolved = resolve(dirname(file), pathPart);
      if (!existsSync(resolved)) {
        sink.push({
          kind: 'file',
          file: relative(root, file),
          line,
          target,
          detail: `"${pathPart}" does not exist`,
        });
        continue;
      }

      if (!anchor || !resolved.toLowerCase().endsWith('.md')) continue;
      if (!statSync(resolved).isFile()) continue;

      let slugs = slugCache.get(resolved);
      if (!slugs) {
        slugs = headingSlugs(readFileSync(resolved, 'utf8'));
        slugCache.set(resolved, slugs);
      }
      // An empty heading set means the target carries no headings at all;
      // treating that as "anchor missing" would flag on a file we failed to
      // parse, so stay quiet — same conservatism the upstream detector uses.
      if (slugs.size === 0) continue;
      if (!slugs.has(anchor)) {
        sink.push({
          kind: 'anchor',
          file: relative(root, file),
          line,
          target,
          detail: `"#${anchor}" is not a heading in "${pathPart}"`,
        });
      }
    }
  }

  return {
    filesScanned: files.length,
    generatedFiles,
    findings,
    generatedFindings: generated,
  };
}

function main() {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  const rootIdx = argv.indexOf('--root');
  const root = rootIdx === -1 ? REPO_ROOT : resolve(argv[rootIdx + 1] ?? '');

  let report;
  try {
    report = check(root);
  } catch (err) {
    console.error(`check_doc_links: cannot scan ${root}: ${err.message}`);
    process.exit(2);
  }

  const contract = JSON.stringify({
    findings: report.findings,
    generatedFindings: report.generatedFindings,
    filesScanned: report.filesScanned,
    generatedFiles: report.generatedFiles,
    v: 1,
    check: 'doc-links',
  });

  if (report.filesScanned === 0) {
    if (json) console.log(contract);
    console.error(
      `check_doc_links: ABSTAINED — no Markdown files found under ${root}. ` +
        'Zero scanned is not zero dead links; the walk found nothing to measure.',
    );
    process.exit(3);
  }

  // Say what was set aside and why. An exclusion nobody can see is the same
  // thing as a shrunken denominator.
  if (report.generatedFiles > 0) {
    console.log(
      `check_doc_links: ${report.generatedFindings.length} dead link(s) in ` +
        `${report.generatedFiles} generator-stamped file(s) — reported, not gated ` +
        '(regenerate the source, or fix the generator).',
    );
  }

  if (report.findings.length > 0) {
    for (const f of report.findings) {
      console.error(`  ${f.file}:${f.line}  ${f.target}  — ${f.detail}`);
    }
    console.error(
      `check_doc_links: ${report.findings.length} dead link(s) across ` +
        `${report.filesScanned} Markdown file(s).`,
    );
    if (json) console.log(contract);
    process.exit(1);
  }

  console.log(
    `check_doc_links: ${report.filesScanned} Markdown file(s) scanned, no dead links.`,
  );
  if (json) console.log(contract);
}

main();
