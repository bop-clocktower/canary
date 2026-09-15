#!/usr/bin/env node
// Fail if live docs/examples reference surfaces that were removed in a refactor.
//
// The v3.0 rollout deleted the LLM provider layer, the in-process orchestrator,
// and the keyed `generate` CLI command — but the docs kept referencing them for
// months. This guard makes that class of drift a hard CI failure: when a
// command, module, or env var is removed, its name must stop appearing in
// user-facing docs and examples in the same change.
//
// It also fails on proprietary/company identifiers leaking into this public
// repo: generic structural patterns (named here) plus a private denylist loaded
// at runtime from CANARY_PROPRIETARY_DENYLIST and/or a gitignored
// `.proprietary-denylist` (never committed, so the actual names stay private).
//
// Exit 0 when clean; exit 1 (listing offenders) otherwise.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  checkAuthorship,
  renderAbstention,
  renderDenominator,
  renderViolations,
} from './lib/authorship-scan.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Test seam (#578). The gate reads a real git working tree, so its suite needs
// to point it at a throwaway fixture repo. That same knob could quietly neuter
// the gate in CI — an empty directory scans clean and exits 0 — so an
// overridden run announces itself loudly rather than letting its green be read
// as a statement about this repository.
const SCAN_ROOT_ENV = 'CANARY_LEAK_SCAN_ROOT';
const scanOverride = (process.env[SCAN_ROOT_ENV] ?? '').trim();
const SCAN_ROOT = scanOverride ? resolve(scanOverride) : REPO_ROOT;
const SCAN_ROOT_IS_OVERRIDDEN = SCAN_ROOT !== REPO_ROOT;

// [regex-source, human reason] — surfaces removed in v3.0. A leading (?i) marks
// a case-insensitive pattern (JS has no inline flag, so it is stripped here).
const REMOVED_SYMBOLS = [
  [
    '\\bcanary generate\\b',
    'the `generate` CLI command was removed in v3.0 — use the /canary-write-test plugin command',
  ],
  [
    '\\boracle generate\\b',
    'the `generate` CLI command was removed in v3.0 — use the /canary-write-test plugin command',
  ],
  [
    '\\b(CANARY|ORACLE)_LLM_PROVIDER\\b',
    'the LLM provider layer (agent/llm/) was removed in v3.0 — no provider env var exists',
  ],
  ['\\bProviderFactory\\b', 'the LLM provider layer was removed in v3.0'],
  [
    '\\bset your API key\\b',
    'no API key is required — LLM work runs through the Claude Code session',
  ],
  [
    '\\bagent/(core|cli|mcp_server|guardian|history|analysis|frameworks|ui|llm)\\b',
    'the Python engine (agent/) was retired in the v6 cutover — the engine is now TypeScript under ts/src/ (registry data at ts/src/data/frameworks/)',
  ],
  [
    '\\bagent\\.(cli|mcp_server|core|guardian)\\b',
    'the Python engine module (agent.*) was retired in the v6 cutover — reference the TypeScript engine under ts/src/ instead',
  ],
  [
    '\\bhooks/[\\w-]+\\.py\\b',
    'the plugin hooks were ported to Node ESM in v6.1.0 (hooks/*.mjs) and guardian_precommit.py was deleted as dead code (#449) — reference the .mjs hook, or .githooks/pre-commit for the repo git hook',
  ],
];

const INCLUDE_PATHS = [
  'README.md',
  'AGENTS.md',
  'CLAUDE.md',
  'docs/wiki',
  'docs/guides',
  'examples',
  'agents',
  'agent',
];

const GENERIC_PROPRIETARY_PATTERNS = [
  [
    '(?i)\\b[\\w-]+\\.internal\\b',
    'internal hostname — internal infra references must not appear in public source',
  ],
  [
    '(?i)\\bCONFIDENTIAL\\b',
    "'confidential' marker — proprietary content does not belong in the public repo",
  ],
];

const DENYLIST_FILE = '.proprietary-denylist';
const DENYLIST_ENV = 'CANARY_PROPRIETARY_DENYLIST';
const DENYLIST_FILE_ENV_OVERRIDE = 'CANARY_DENYLIST_FILE';

const PROPRIETARY_EXCLUDED_DIRS = new Set([
  '.git',
  '.venv',
  'node_modules',
  '__pycache__',
  'docs/archive',
  'tests/generated',
  '.remember',
]);
// The language the repo is actually written in. Both halves of this file were
// blind to it until #578: the v6 cutover moved the engine from `agent/` (.py)
// to `ts/src/` and neither suffix set followed, so the gate kept reporting a
// confident green over a denominator that excluded the codebase. PR #577
// leaked a consumer identifier into two `ts/test/*.ts` files and passed.
const CODE_SUFFIXES = ['.ts', '.tsx', '.js', '.mjs', '.cjs'];
const DATA_SUFFIXES = ['.json', '.yml', '.yaml'];

const PROPRIETARY_SUFFIXES = new Set([
  '.md',
  '.py',
  '.svg',
  '.html',
  '.txt',
  '.toml',
  ...CODE_SUFFIXES,
  ...DATA_SUFFIXES,
]);

const ALLOWED_CONTEXT_SUBSTRINGS = [
  'removed in v3',
  'was removed',
  'no longer exists',
  'has been deleted',
  'deleted in v3',
  'predates v3',
  'out of date',
  'vestigial',
  'not currently wired',
  'removal note',
  'no api key',
  'no provider',
];

const SCANNED_SUFFIXES = new Set([
  '.md',
  '.py',
  ...CODE_SUFFIXES,
  ...DATA_SUFFIXES,
]);
const SELF = 'scripts/check_removed_symbols.mjs';

/** Compile a [source, reason] pair, honoring a leading (?i) as the 'i' flag. */
function compile([src, reason]) {
  if (src.startsWith('(?i)')) return [new RegExp(src.slice(4), 'i'), reason];
  return [new RegExp(src), reason];
}

function suffixOf(p) {
  const base = p.slice(p.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot) : '';
}

function relPosix(absPath) {
  return relative(SCAN_ROOT, absPath).split('\\').join('/');
}

// Tree mode (#843, ADR 0023). Under `pull_request_target` the checkout is the
// BASE branch, so scanning the working tree would report a verdict about the
// wrong tree. Instead the PR head commit is read straight from the object
// store: `git ls-tree` + `git cat-file --batch`. Head files are never written
// to disk, never followed through a symlink, and never executed.
const SCAN_TREE_ENV = 'CANARY_LEAK_SCAN_TREE';
/** A pull_request_target log is public to the (possibly fork) PR author. */
const FORK_VISIBLE_LOG =
  (process.env.GITHUB_EVENT_NAME ?? '').trim() === 'pull_request_target';
const FULL_SHA = /^[0-9a-f]{40}$/;
const REGULAR_BLOB_MODES = new Set(['100644', '100755']);

function gitData(args, input) {
  return execFileSync('git', args, {
    cwd: SCAN_ROOT,
    input,
    maxBuffer: 1024 * 1024 * 1024,
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  });
}

/**
 * Every regular file of `sha` whose suffix either half scans, as rel → text.
 * Returns `{ error }` rather than an empty map when the commit cannot be read,
 * so the caller abstains instead of passing over zero files.
 */
function treeSource(sha) {
  if (!FULL_SHA.test(sha)) {
    return {
      error: `${SCAN_TREE_ENV} must be a full 40-hex commit SHA, got ${JSON.stringify(sha)}`,
    };
  }
  let listing;
  try {
    gitData(['cat-file', '-e', `${sha}^{commit}`]);
    listing = gitData(['ls-tree', '-r', '-z', '--full-tree', sha]).toString(
      'utf-8',
    );
  } catch (err) {
    const detail = String(err?.stderr ?? '')
      .trim()
      .split('\n')[0];
    return {
      error: `commit ${sha} is not readable here${detail ? ` — ${detail}` : ''}`,
    };
  }
  const wanted = scannableBlobs(listing);
  try {
    return { sha, files: readBlobs(wanted) };
  } catch (err) {
    return { error: `commit ${sha}: ${err.message}` };
  }
}

/** `ls-tree -r -z` entries worth reading, as [rel, objectId]. */
function scannableBlobs(listing) {
  const wanted = [];
  for (const entry of listing.split('\0')) {
    const tab = entry.indexOf('\t');
    if (tab < 0) continue;
    const [mode, type, object] = entry.slice(0, tab).split(' ');
    const rel = entry.slice(tab + 1);
    // Symlinks (120000) and gitlinks (160000) are skipped: a symlink's target
    // is not content this commit publishes, and following one would read
    // whatever the runner has at that path.
    if (type !== 'blob' || !REGULAR_BLOB_MODES.has(mode)) continue;
    const suffix = suffixOf(rel);
    if (PROPRIETARY_SUFFIXES.has(suffix) || SCANNED_SUFFIXES.has(suffix)) {
      wanted.push([rel, object]);
    }
  }
  return wanted;
}

const BATCH_HEADER = /^[0-9a-f]{40} blob (\d+)$/;

/** Read blobs in one `cat-file --batch`; throws on any unexpected header. */
function readBlobs(wanted) {
  const files = new Map();
  if (wanted.length === 0) return files;
  const out = gitData(
    ['cat-file', '--batch'],
    wanted.map(([, o]) => o).join('\n') + '\n',
  );
  let pos = 0;
  for (const [rel] of wanted) {
    const nl = out.indexOf(0x0a, pos);
    const header = out.subarray(pos, nl < 0 ? pos : nl).toString('utf-8');
    const m = BATCH_HEADER.exec(header);
    // `<oid> missing` (or a truncated stream) would otherwise parse as NaN
    // and silently misalign every later file.
    if (!m) throw new Error(`unreadable blob for ${rel} (${header})`);
    const size = Number(m[1]);
    files.set(rel, out.subarray(nl + 1, nl + 1 + size).toString('utf-8'));
    pos = nl + 1 + size + 1;
  }
  return files;
}

/** The file source for this run: the working tree, or a commit's blobs. */
let source = { sha: null, files: null };

function readRel(rel) {
  return source.files
    ? (source.files.get(rel) ?? '')
    : readFileSync(resolve(SCAN_ROOT, rel), 'utf-8');
}

function inScopeRel(rel) {
  if (rel.includes('__pycache__')) return false;
  return INCLUDE_PATHS.some((inc) => rel === inc || rel.startsWith(inc + '/'));
}

function isRemovalNoteDoc(text) {
  const head = text.split('\n').slice(0, 8).join('\n').toLowerCase();
  return head.includes('removed in v3');
}

function walkFiles(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...walkFiles(full));
    else if (e.isFile()) out.push(full);
  }
  return out;
}

/** Files the removed-symbol half reads, as repo-relative paths. */
function removedCandidates() {
  if (source.files) return [...source.files.keys()];
  const candidates = new Set();
  for (const inc of INCLUDE_PATHS) {
    const p = resolve(SCAN_ROOT, inc);
    if (!existsSync(p)) continue;
    const st = statSync(p);
    if (st.isFile()) candidates.add(relPosix(p));
    if (!st.isDirectory()) continue;
    for (const q of walkFiles(p)) {
      if (SCANNED_SUFFIXES.has(suffixOf(q))) candidates.add(relPosix(q));
    }
  }
  return [...candidates];
}

function checkRemovedSymbols() {
  const patterns = REMOVED_SYMBOLS.map(compile);
  const violations = [];
  for (const rel of removedCandidates().sort()) {
    if (!SCANNED_SUFFIXES.has(suffixOf(rel)) || !inScopeRel(rel)) continue;
    const text = readRel(rel);
    if (isRemovalNoteDoc(text)) continue;
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const low = line.toLowerCase();
      if (ALLOWED_CONTEXT_SUBSTRINGS.some((ctx) => low.includes(ctx))) continue;
      for (const [rx, reason] of patterns) {
        if (rx.test(line)) {
          violations.push(
            indent(
              `${inert(rel)}:${i + 1}: ${inert(line.trim())}\n    → ${reason}`,
            ),
          );
        }
      }
    }
  }
  return violations;
}

function propExcluded(rel) {
  return [...PROPRIETARY_EXCLUDED_DIRS].some(
    (d) => rel === d || rel.startsWith(d + '/'),
  );
}

function trackedFiles() {
  try {
    const out = execFileSync('git', ['ls-files'], {
      cwd: SCAN_ROOT,
      encoding: 'utf-8',
    });
    return out.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function reEscape(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Where the denylist file lives for this run, and how we found it.
 *
 * The file is gitignored by design — it names the company, and this repo is
 * public — so `git worktree add` does not copy it. Every worktree therefore
 * started with the proprietary half of this gate dark, and said nothing about
 * it. That is the #725 shape exactly: a gate whose coverage depended on where
 * the tree happened to be created. The remedy is the one #725 already
 * established for markdownlint — the common git dir points at the main
 * checkout unconditionally, worktree or not, so its copy is the one file this
 * script can always name.
 *
 * Resolution order: the fixture seam, then this tree, then the main checkout.
 * Probed in that order because a tree carrying its own denylist should use it.
 */
function resolveDenylistFile() {
  // Resolution is anchored on REPO_ROOT, not SCAN_ROOT, and deliberately so:
  // the denylist is the gate's own configuration, not part of the tree being
  // scanned. A fixture root must not be able to supply its own (empty)
  // denylist and scan itself clean.
  //
  // The seam is narrow for the same reason: honoured ONLY when the scan root
  // is already overridden, i.e. a fixture run that has announced itself
  // loudly, so a real CI run cannot reach it. Without it, the no-denylist
  // tests would pass only on machines that happen to lack the private overlay
  // — green in CI, red on the maintainer's laptop, which is how the assertion
  // guarding the dark-gate disclosure would get loosened.
  //
  // An announced fixture run resolves to exactly what it asked for, with no
  // main-checkout fallback: falling back there would let the real denylist
  // into a fixture scan and silently invalidate those same cases.
  const seam = (process.env[DENYLIST_FILE_ENV_OVERRIDE] ?? '').trim();
  if (SCAN_ROOT_IS_OVERRIDDEN && seam) {
    return { file: resolve(seam), source: 'seam' };
  }

  const local = resolve(REPO_ROOT, DENYLIST_FILE);
  if (existsSync(local)) return { file: local, source: 'local' };

  try {
    const commonGitDir = execFileSync(
      'git',
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      {
        cwd: REPO_ROOT,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    ).trim();
    if (commonGitDir) {
      const shared = resolve(dirname(commonGitDir), DENYLIST_FILE);
      if (existsSync(shared)) return { file: shared, source: 'main-checkout' };
    }
  } catch {
    // Not a git tree, or no git binary. Nothing to fall back to; the caller
    // discloses the resulting gap rather than passing quietly.
  }

  return { file: null, source: 'none' };
}

/** Memoized: loadDenylist runs per-half, and resolution shells out to git. */
let denylistCache = null;

function denylistState() {
  if (denylistCache) return denylistCache;
  const { file, source } = resolveDenylistFile();
  const fileTerms =
    file && existsSync(file)
      ? readFileSync(file, 'utf-8')
          .split('\n')
          .map((l) => l.trim())
          .filter((s) => s && !s.startsWith('#'))
      : [];
  const envTerms = (process.env[DENYLIST_ENV] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  denylistCache = {
    file,
    source: fileTerms.length ? source : 'none',
    fileTerms,
    envTerms,
    // The gate's proprietary half has nothing company-specific to match on.
    // Structural patterns still run, which is why this cannot be read off the
    // exit code alone -- it looks exactly like a clean run.
    degraded: fileTerms.length === 0 && envTerms.length === 0,
  };
  return denylistCache;
}

function loadDenylist() {
  const terms = new Set();
  const state = denylistState();
  for (const s of state.fileTerms) terms.add(s);
  for (const s of state.envTerms) terms.add(s);
  const reason =
    'company/proprietary identifier (from denylist) — keep it in the ' +
    'private overlay; use a neutral placeholder (e.g. ACME) in public examples';
  return [...terms]
    .sort()
    .map((t) => [new RegExp(`\\b${reEscape(t)}\\b`, 'i'), reason]);
}

function isProprietaryTarget(rel) {
  if (rel === SELF) return false;
  if (!PROPRIETARY_SUFFIXES.has(suffixOf(rel)) || propExcluded(rel)) {
    return false;
  }
  if (source.files) return true;
  const path = resolve(SCAN_ROOT, rel);
  return existsSync(path) && statSync(path).isFile();
}

function checkProprietary() {
  const patterns =
    GENERIC_PROPRIETARY_PATTERNS.map(compile).concat(loadDenylist());
  const violations = [];
  const listed = source.files ? [...source.files.keys()] : trackedFiles();
  for (const rel of listed.sort().filter(isProprietaryTarget)) {
    violations.push(...matchLines(readRel(rel), patterns, rel));
  }
  // The Actions log of a pull_request_target run is readable by the fork
  // author, and the denylist is a secret. Naming the matched line, or even
  // the file, lets a fork plant one guessed name per file and read back which
  // ones hit. So the fork-visible log says only that this half failed; a
  // maintainer reruns locally for detail.
  if (FORK_VISIBLE_LOG && violations.length) {
    return [indent('proprietary match(es) found (details withheld)')];
  }
  return violations;
}

function matchLines(text, patterns, rel) {
  const hits = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    for (const [rx, reason] of patterns) {
      if (rx.test(lines[i])) {
        hits.push(
          indent(
            `${inert(rel)}:${i + 1}: ${inert(lines[i].trim())}\n    → ${reason}`,
          ),
        );
      }
    }
  }
  return hits;
}

/**
 * Pick the file source for this run. Returns an abstention reason, or null.
 * Under pull_request_target a missing tree is an abstention, never a fallback
 * to the working tree: that tree is BASE, and its green would be about the
 * wrong code.
 */
function resolveSource() {
  const treeSha = (process.env[SCAN_TREE_ENV] ?? '').trim();
  if (!treeSha) {
    return FORK_VISIBLE_LOG
      ? `pull_request_target checks out the BASE branch, and ${SCAN_TREE_ENV} ` +
          'does not name the PR head commit, so a scan here would describe ' +
          'the wrong tree'
      : null;
  }
  source = treeSource(treeSha);
  if (source.error) return source.error;
  if (source.files.size === 0)
    return `commit ${treeSha} has no scannable files`;
  process.stdout.write(
    `check_removed_symbols: scanned commit ${treeSha}: ` +
      `${source.files.size} files (blobs only, working tree not read).\n`,
  );
  return null;
}

/**
 * Keep a matched line's own text from starting a runner workflow command
 * (`::error`, `::stop-commands::`): head content is attacker-controlled.
 */
function indent(line) {
  return `  ${line}`;
}

/**
 * Make head-controlled text (a path or a matched line) unable to form a runner
 * workflow command. Indenting alone is not a guard: the runner may honour an
 * indented `::cmd`, and `ls-tree -z` allows a newline inside a path, which
 * would put attacker text at the start of its own log line (#948 review).
 * Line breaks become visible escapes and every `::` is split.
 */
function inert(text) {
  return String(text)
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/::/g, ': :');
}

function main() {
  if (SCAN_ROOT_IS_OVERRIDDEN) {
    process.stdout.write(
      `check_removed_symbols: ${SCAN_ROOT_ENV} is set — scanning ${SCAN_ROOT}\n` +
        'This run does not gate the repository; its result says nothing about ' +
        'the tree in git. Unset the variable for the real gate.\n\n',
    );
  }
  const sourceError = resolveSource();
  if (sourceError) {
    process.stdout.write(
      `check_removed_symbols: ABSTAIN — ${sourceError}. Nothing was ` +
        'verified; this is not a pass.\n',
    );
    return 1;
  }

  const denylist = denylistState();
  if (denylist.source === 'main-checkout') {
    process.stdout.write(
      `check_removed_symbols: denylist resolved from the main checkout ` +
        `(${denylist.file}) — this tree has none of its own.\n`,
    );
  }

  const removed = checkRemovedSymbols();
  const proprietary = checkProprietary();
  const authorship = checkAuthorship({
    denylist: loadDenylist(),
    scanRoot: SCAN_ROOT,
    scanRootOverridden: SCAN_ROOT_IS_OVERRIDDEN,
  });

  if (removed.length) {
    process.stdout.write(
      'Removed-symbol references found on live surfaces:\n\n',
    );
    process.stdout.write(removed.join('\n') + '\n');
    process.stdout.write(
      '\nEach line references something deleted in a refactor. Update it ' +
        'to the current surface, or — if the line explains the removal — ' +
        "phrase it as a removal note (e.g. 'removed in v3').\n",
    );
  }
  if (proprietary.length) {
    process.stdout.write(
      '\nProprietary/company identifiers found in the public repo:\n\n',
    );
    process.stdout.write(proprietary.join('\n') + '\n');
    process.stdout.write(
      '\nThis repo is public/open-source. Company-specific content belongs ' +
        'in a PRIVATE overlay (discovered at runtime via .canary/skills/), ' +
        'never upstream. Use a neutral placeholder (e.g. ACME) in examples.\n',
    );
  }

  if (FORK_VISIBLE_LOG && authorship.violations?.length) {
    // Same denylist oracle as file contents: the identity text is withheld.
    authorship.violations = [
      indent('commit identity match(es) found (details withheld)'),
    ];
  }
  process.stdout.write(renderViolations(authorship));

  // A gate that could not resolve what to scan has not passed; it has not run.
  if (authorship.unresolved) {
    process.stdout.write(renderAbstention(authorship));
    return 1;
  }

  if (removed.length || proprietary.length || authorship.violations?.length) {
    return 1;
  }

  if (denylist.degraded) {
    process.stdout.write(
      `\ncheck_removed_symbols: DEGRADED — structural patterns only. No ` +
        `denylist file and no ${DENYLIST_ENV}, so company identifiers were ` +
        `NOT checked here. This is not a clean proprietary scan.\n` +
        `Provide ${DENYLIST_FILE} in this tree or the main checkout, or set ` +
        `${DENYLIST_ENV}.\nCI still gates the real one.\n` +
        // The authorship half reports its own denominator on the clean line
        // this branch replaces. Dropping it here would trade one silence for
        // another: the same no-denylist condition degrades both halves, and
        // both have to say so.
        `${renderDenominator(authorship)}.\n`,
    );
    return 0;
  }

  process.stdout.write(
    'check_removed_symbols: clean — no removed-symbol or proprietary ' +
      `leaks; ${renderDenominator(authorship)}.\n`,
  );
  return 0;
}

process.exit(main());
