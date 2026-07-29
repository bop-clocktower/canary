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

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

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

const PROPRIETARY_EXCLUDED_DIRS = new Set([
  '.git',
  '.venv',
  'node_modules',
  '__pycache__',
  'docs/archive',
  'tests/generated',
  '.remember',
]);
const PROPRIETARY_SUFFIXES = new Set([
  '.md',
  '.py',
  '.json',
  '.svg',
  '.html',
  '.yml',
  '.yaml',
  '.txt',
  '.toml',
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

const SCANNED_SUFFIXES = new Set(['.md', '.py']);
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
  return relative(REPO_ROOT, absPath).split('\\').join('/');
}

function inScope(absPath) {
  const rel = relPosix(absPath);
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

function checkRemovedSymbols() {
  const patterns = REMOVED_SYMBOLS.map(compile);
  const violations = [];
  const candidates = new Set();
  for (const inc of INCLUDE_PATHS) {
    const p = resolve(REPO_ROOT, inc);
    if (!existsSync(p)) continue;
    const st = statSync(p);
    if (st.isFile()) candidates.add(p);
    else if (st.isDirectory()) {
      for (const q of walkFiles(p)) {
        if (SCANNED_SUFFIXES.has(suffixOf(q))) candidates.add(q);
      }
    }
  }

  for (const path of [...candidates].sort()) {
    if (!SCANNED_SUFFIXES.has(suffixOf(path)) || !inScope(path)) continue;
    const text = readFileSync(path, 'utf-8');
    if (isRemovalNoteDoc(text)) continue;
    const rel = relPosix(path);
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const low = line.toLowerCase();
      if (ALLOWED_CONTEXT_SUBSTRINGS.some((ctx) => low.includes(ctx))) continue;
      for (const [rx, reason] of patterns) {
        if (rx.test(line)) {
          violations.push(`${rel}:${i + 1}: ${line.trim()}\n    → ${reason}`);
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
      cwd: REPO_ROOT,
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

function loadDenylist() {
  const terms = new Set();
  const f = resolve(REPO_ROOT, DENYLIST_FILE);
  if (existsSync(f)) {
    for (const line of readFileSync(f, 'utf-8').split('\n')) {
      const s = line.trim();
      if (s && !s.startsWith('#')) terms.add(s);
    }
  }
  for (const raw of (process.env[DENYLIST_ENV] ?? '').split(',')) {
    const s = raw.trim();
    if (s) terms.add(s);
  }
  const reason =
    'company/proprietary identifier (from denylist) — keep it in the ' +
    'private overlay; use a neutral placeholder (e.g. ACME) in public examples';
  return [...terms]
    .sort()
    .map((t) => [new RegExp(`\\b${reEscape(t)}\\b`, 'i'), reason]);
}

function checkProprietary() {
  const patterns =
    GENERIC_PROPRIETARY_PATTERNS.map(compile).concat(loadDenylist());
  const violations = [];
  for (const rel of trackedFiles().sort()) {
    if (rel === SELF) continue;
    const path = resolve(REPO_ROOT, rel);
    if (
      !PROPRIETARY_SUFFIXES.has(suffixOf(rel)) ||
      !existsSync(path) ||
      !statSync(path).isFile() ||
      propExcluded(rel)
    ) {
      continue;
    }
    const lines = readFileSync(path, 'utf-8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      for (const [rx, reason] of patterns) {
        if (rx.test(lines[i])) {
          violations.push(
            `${rel}:${i + 1}: ${lines[i].trim()}\n    → ${reason}`,
          );
        }
      }
    }
  }
  return violations;
}

function main() {
  const removed = checkRemovedSymbols();
  const proprietary = checkProprietary();

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

  if (removed.length || proprietary.length) return 1;

  process.stdout.write(
    'check_removed_symbols: clean — no removed-symbol or proprietary leaks.\n',
  );
  return 0;
}

process.exit(main());
