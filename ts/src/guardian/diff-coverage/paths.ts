/**
 * Path predicates shared by the graph and heuristic tiers, and by the finding
 * filters downstream: what is a test, what is test *support*, and what is
 * hand-authored program source at all.
 */

import { basename, extname } from 'node:path';

const TEST_PATH_RE =
  /(^|\/)tests?\/|(^|\/)test_[^/]*\.py$|\.test\.[^/]+$|\.spec\.[^/]+$/;

/**
 * True if `path` looks like a test file (`tests/**`, `test_*.py`, `*.test.*`,
 * `*.spec.*`).
 */
export function isTestPath(path: string): boolean {
  return TEST_PATH_RE.test(path);
}

/**
 * Split a basename's stem into `-`/`_`/`.`-separated components (#565).
 *
 * `playwright-fixture.ts` → `['playwright', 'fixture']`;
 * `user.fixtures.ts` → `['user', 'fixtures']`. The final extension is dropped
 * first so it never appears as a component.
 */
function basenameComponents(path: string): string[] {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  return stem.split(/[-_.]/).filter((part) => part.length > 0);
}

/** Basename components that mark a file as test *support* rather than source. */
const FIXTURE_COMPONENTS: ReadonlySet<string> = new Set([
  'fixture',
  'fixtures',
]);

/**
 * True if `path` is test *infrastructure* identified by filename idiom (#565).
 *
 * {@link isTestPath} recognises tests by directory (`tests/**`) or by the
 * `*.test.*` / `*.spec.*` / `test_*.py` naming rules, and the skip layer
 * recognises fixtures by the `fixtures/` *directory* convention. Neither
 * catches a file that is test support by **name** while sitting in an ordinary
 * source directory — the measured cases being a pytest `conftest_otel.py` and a
 * Playwright `playwright-fixture.ts`, both under `scripts/otel_bootstrap/`.
 *
 * Such a file cannot host a test in the sense a coverage finding means: it *is*
 * the harness the tests run inside. Asking it for a covering test inverts the
 * relationship, so a reviewer's only correct response is 👎 — the precision
 * cost #413 and #562 both describe.
 *
 * Two deliberate narrowings:
 *
 *   - **Components, not substrings.** `conftestimonial.py` and
 *     `prefixtures.ts` are ordinary source and must survive. Matching on
 *     `-`/`_`/`.`-separated components is what pytest's own name-based
 *     resolution and the `*.fixtures.ts` idiom actually mean.
 *   - **`conftest` is Python-only.** It is pytest's resolution rule
 *     specifically; a `conftest.js` carries no framework meaning and is left as
 *     source.
 *
 * Known over-match, accepted: a production module genuinely named
 * `fixture-generator.ts` is suppressed. That trade is deliberate — a missed
 * finding on a file named after fixtures costs far less than a finding no
 * reviewer can ever act on, which is what drags `precision = TP / (TP + FP)`
 * below the promotion bar.
 *
 * Kept separate from {@link isTestPath} on purpose: that predicate also decides
 * what *confers* graph coverage, so widening it would let a conftest mark every
 * module it imports as tested — a false negative in place of a false positive.
 */
export function isTestSupportPath(path: string): boolean {
  const components = basenameComponents(path);
  if (path.endsWith('.py') && components.includes('conftest')) return true;
  return components.some((part) => FIXTURE_COMPONENTS.has(part));
}

/**
 * Extensions that denote hand-authored, executable program source (#413).
 *
 * The membership rule is deliberately simple and defensible: **a programming
 * language belongs; data, config, markup, and style do not.** `.sh` is in (it is
 * executable logic — bats/shunit2 exist); `.json`, `.yaml`, `.sql`, `.css`, and
 * `.html` are out (nothing a naming heuristic could meaningfully judge).
 *
 * A repo that disagrees at the margins tunes the glob layer
 * (`canary.guardian.pr.heuristicExclude`) rather than this list.
 */
const SOURCE_EXTENSIONS: ReadonlySet<string> = new Set([
  // TS/JS + component dialects.
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.vue',
  '.svelte',
  '.astro',
  // Python / Ruby / PHP / Perl / Lua.
  '.py',
  '.pyi',
  '.rb',
  '.php',
  '.pl',
  '.pm',
  '.lua',
  // JVM + .NET.
  '.java',
  '.kt',
  '.kts',
  '.scala',
  '.groovy',
  '.clj',
  '.cljs',
  '.cs',
  '.fs',
  '.vb',
  // Systems.
  '.go',
  '.rs',
  '.c',
  '.h',
  '.cc',
  '.cpp',
  '.cxx',
  '.hpp',
  '.hh',
  '.m',
  '.mm',
  '.swift',
  // Functional / scientific / other.
  '.ex',
  '.exs',
  '.erl',
  '.dart',
  '.r',
  '.jl',
  // Shell.
  '.sh',
  '.bash',
  '.zsh',
  '.ps1',
  '.psm1',
]);

/**
 * True if `path` looks like hand-authored program source (#413).
 *
 * Used to gate the Tier-3 naming heuristic. That heuristic asks "does any test
 * file reference this file's stem or a top-level symbol?" — for a config
 * dotfile, a lockfile, or a data blob there are no symbols and no test will
 * ever name it, so the verdict is structurally always "uncovered": a guaranteed
 * false positive rather than a signal. An extension-less file (`Makefile`,
 * `Dockerfile`) and a bare dotfile (`.eslintrc`) are both non-source.
 */
export function isSourcePath(path: string): boolean {
  const base = basename(path);
  // `.eslintrc` — `extname` calls this '' already, but a dotfile WITH a real
  // extension (`.eslintrc.json`) must be judged on that extension, which the
  // normal path handles.
  const ext = extname(base).toLowerCase();
  if (!ext) return false;
  return SOURCE_EXTENSIONS.has(ext);
}
