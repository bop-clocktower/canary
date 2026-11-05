# Plan: Deterministic `canary critical-areas` (#1529)

**Date:** 2026-11-03 | **Spec:**
docs/changes/1529-critical-areas-cli/proposal.md | **Tasks:** 11 | **Time:** ~50
min | **Integration Tier:** medium

## Goal

`canary critical-areas` deterministically writes a ranked
`.canary/critical-areas.json` that katana and the three engine readers accept,
and katana's degraded line names how to produce it.

## Observable Truths (Acceptance Criteria)

Numbered as the spec's success criteria.

1. When `canary critical-areas` runs in a git repository with ranked source
   files, the system shall write `.canary/critical-areas.json` and exit 0.
   (Task 4)
2. When `--out <path>` is given, the system shall write there and create missing
   parent directories. (Task 4)
3. When no coverage report is present, the system shall write
   `coverage_pct: null` for every area and record `coverage` as absent with a
   reason. (Tasks 1, 5)
4. If a report is present but does not list a file, then the system shall not
   write `coverage_pct: 0` for that file. (Task 5)
5. When generated output is given to katana's `--critical-areas`, katana shall
   not print the degraded line, and shall alarm when a diff removes the last
   test covering a listed area. (Task 7)
6. When generated output is read by `parseCriticalAreas`, `loadAreas` and
   `readRankIndex`, each shall return the listed paths and scores. (Task 7)
7. If there is nothing to rank, then the system shall exit 3, and shall not
   create or replace the output file. (Tasks 4, 6)
8. If the clone is shallow, then the system shall write `churn_commits: null`,
   record why, and rank on importers. (Tasks 1, 2, 4)
9. When the existing file declares `symbols` for a path still in HEAD, the
   system shall keep them, even for an area outside the top 25. (Tasks 1, 6)
10. When run twice on one commit, the system shall write documents differing
    only in `generated`. (Task 4)
11. `commands/canary-critical-areas.md` shall not name an agent that does not
    exist under `agents/agents/claude-code/`. (Task 9)
12. When katana runs without usable critical-area data, its degraded line shall
    name `canary critical-areas`. (Task 8)

## Uncertainties

Decisions D1-D17 are settled and not reopened. These are the gaps left under
them.

- [ASSUMPTION] D9 says a shallow clone's score "falls back to importers". This
  plan gives importers the full weight (`score = importers`), not 0.5. D3's own
  reason applies: at 0.5 the maximum is 0.65 and katana's `CRITICAL_RISK = 0.7`
  is unreachable. If wrong, change one line in `baseScore` (Task 1).
- [ASSUMPTION] A relative `--out` or `--coverage` resolves against the current
  directory, as any path flag does. D16's top level anchors only the default
  output and the discovered report names.
- [ASSUMPTION] The explicit-report check runs before the git check, so a typo'd
  flag exits 2 even outside a repository.
- [ASSUMPTION] A kept-`symbols` path that is in HEAD but not a candidate (for
  example a test file) is listed with its real churn and `importers: 0`. It does
  not move the normalization maxima, because those are "in scope" candidates.
- [ASSUMPTION] Importers read the working tree, not blobs at HEAD. Running
  `git show` per file would be slow, and a clean checkout is the same content. A
  dirty tree can shift counts, so criterion 10 holds for one commit and one
  tree. The guide states this.
- [ASSUMPTION] `coverage_pct` is on a 0-100 scale, one decimal, matching the
  spec's "under 50%" rule. `risk_score` rounds to 2 decimals, as the skill does.
- [ASSUMPTION] The measured-coverage shape is
  `{ "status": "measured", "report": "<top-relative path>", "files_matched": n }`.
  The spec shows only the absent shape.
- [DEFERRABLE] Exact wording of abstention and reason strings beyond the
  asserted fragments.

## Evidence

- `ts/src/inventory/inventory-cli.ts:40-45` is the abstain-and-write-nothing
  shape. `ts/src/order/order-cli.ts:40-55` is the `git` and `usage` helper
  shape.
- `ts/src/guardian/diff-coverage/report-tier.ts:104` is `readReportIndex`;
  `ts/src/guardian/diff-coverage/report-anchor.ts:98` is `anchorIndex`;
  `ts/src/guardian/diff-coverage/types.ts:93,112,184` are `FileCoverage`,
  `recordedLines` and `matchFile`.
- `ts/src/core/inventory-checks.ts:103` reads `risk_score`;
  `ts/src/briefing/inputs.ts:83` reads `rank_score`.
- `agents/skills/claude-code/canary-katana/scripts/alarm.mjs:41` is the notice;
  `agents/skills/test/canary-katana.test.ts:768` pins it; lines 1735, 1751 and
  1792 use `toContain` with the constant and need no edit.
- `agents/skills/test/canary-katana.test.ts:785-800` shows the alarm fixture:
  `tests/test_points.py` on disk with a diff removing its named tests.

## File Map

- CREATE ts/src/critical-areas/scoring.ts
- CREATE ts/test/critical-areas-scoring.test.ts
- CREATE ts/src/critical-areas/git-signals.ts
- CREATE ts/test/critical-areas-git-signals.test.ts
- CREATE ts/src/critical-areas/importers.ts
- CREATE ts/test/critical-areas-importers.test.ts
- CREATE ts/src/critical-areas/critical-areas-cli.ts
- CREATE ts/test/critical-areas-cli.test.ts
- CREATE ts/test/critical-areas-consumers.test.ts
- CREATE docs/guides/critical-areas.md
- MODIFY ts/src/commands/audit/cli.ts (register after `buildOrderCommand`)
- MODIFY ts/test/cli-command-registry.test.ts (`'critical-areas'` after
  `'order'`)
- MODIFY ts/test/gate-conformance.test.ts (abstention row)
- MODIFY agents/skills/claude-code/canary-katana/scripts/alarm.mjs
- MODIFY agents/skills/test/canary-katana.test.ts
- MODIFY agents/skills/claude-code/canary-katana/SKILL.md
- MODIFY agents/skills/claude-code/canary-critical-areas/SKILL.md
- MODIFY commands/canary-critical-areas.md
- MODIFY README.md
- MODIFY docs/guides/index.md
- MODIFY harness.config.json (both `entryPoints` arrays)

Not touched: `agents/skills/lib/contracts/`, the unquarantine scripts,
`CHANGELOG.md`, `docs/roadmap.md`, `package.json`. `AGENTS.md` lists no sibling
producers (no `critical-areas` mention today), so it gets no line, per the spec.

## Skeleton

1. Pure scoring module (1 task, ~5 min)
2. Git signals and importers against real repos (2 tasks, ~10 min)
3. CLI, registry, coverage, symbols, abstention row (3 tasks, ~15 min)
4. Consumer proof (1 task, ~4 min)
5. Katana line and command fix (2 tasks, ~6 min)
6. Plant-the-regression proofs (1 task, ~5 min)
7. Docs, entry points, ratchets (1 task, ~5 min)

_Skeleton approval: waived. The caller ran this phase autonomously, no pauses._

## Shared test helper

Tasks 2, 4, 5, 6 and 7 need a real temporary repo. Each test file carries this
local helper, not a shared export, so no test module becomes a new dependency.
It strips `GIT_DIR`-style variables: inside a pre-commit hook they would point
git at this repository instead of the fixture.

```ts
function git(
  cwd: string,
  args: string[],
  date = '2020-06-01T00:00:00Z',
): string {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')),
  );
  return execFileSync(
    'git',
    [
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@example.invalid',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    {
      cwd,
      encoding: 'utf-8',
      env: { ...env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    },
  );
}

function commit(
  root: string,
  files: Record<string, string>,
  date?: string,
): void {
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body, 'utf-8');
  }
  git(root, ['add', '-A'], date);
  git(root, ['commit', '-m', 'c', '--allow-empty'], date);
}
```

Initialize with `git(root, ['init', '-q'])`.

## Tasks

All commands run from the worktree root unless a `cd ts` is shown. Tests run
with `cd ts && npx vitest run test/<file>`.

### Task 1: Pure document builder

**Depends on:** none | **Files:** ts/src/critical-areas/scoring.ts,
ts/test/critical-areas-scoring.test.ts

1. Write `ts/test/critical-areas-scoring.test.ts`, importing `buildDocument` and
   `MAX_AREAS`. Build input with a local `doc(files, symbols = new Map())` that
   passes fixed `generated`, `base` and `sources`. Assert:
   - Churn 10/importers 10 against maxima 10/10 scores 1; churn 5/importers 0
     scores 0.25 (D3).
   - All files `churn: null`: importers 4 of 4 scores 1, `churn_commits` is
     `null`, no `high_churn`, and the summary says `churn not measured` (D9).
   - Coverage 40 on a file with base 0.5 scores 0.59 (`0.5 + 0.15 * 0.6`) and
     carries `low_coverage`; coverage 50 has no `low_coverage` (D4).
   - Coverage 0 on a file with churn 0 and importers 0 scores 0 and is not
     listed (D4).
   - `coveragePct: null` writes `coverage_pct: null`, adds no boost, and the
     summary says `coverage not measured`.
   - A score that would exceed 1 is capped at exactly 1 (coverage 0, full base).
   - `high_churn` fires at exactly half the max and not just below it; same for
     `many_dependents`. `recommended_test_types` is `['unit','integration']`
     only with `many_dependents`.
   - 30 scored files list `MAX_AREAS` (25); ties sort by path ascending.
   - `risk_score === rank_score` on every area (D14).
   - A file ranked 26th with `symbols` is listed with them, and a 0-score file
     with symbols is listed (D5, D13). An area without symbols has no `symbols`
     key.
   - All-zero input returns `areas: []` (the CLI abstains on it).
   - An `extras` row is listed when it has symbols, and does not change another
     file's score (its churn is above the candidate maximum).
2. Run: `cd ts && npx vitest run test/critical-areas-scoring.test.ts`. Observe
   failure (module missing).
3. Create `ts/src/critical-areas/scoring.ts`:

   ```ts
   /**
    * Pure scoring for `canary critical-areas` (#1529): the skill's formula with
    * business_critical removed and redistributed, because at the skill's weights
    * the maximum is 0.70 and katana's CRITICAL_RISK would be all but unreachable.
    */
   export const MAX_AREAS = 25;
   export const CHURN_WINDOW_DAYS = 90;

   export interface FileSignals {
     path: string;
     /** `null` is unmeasured (a shallow clone), never "no commits". */
     churn: number | null;
     importers: number;
     /** 0-100; `null` is unmeasured, never 0%. */
     coveragePct: number | null;
   }

   export interface SignalSource {
     status: 'measured' | 'absent';
     reason?: string;
     window_days?: number;
     report?: string;
     files_matched?: number;
   }

   export interface DocumentInput {
     generated: string;
     base: string;
     /** Candidates: they alone set the maxima and count as analyzed. */
     files: FileSignals[];
     /** Kept-symbols paths in HEAD that are not candidates. */
     extras: FileSignals[];
     symbols: ReadonlyMap<string, string[]>;
     sources: Record<'churn' | 'importers' | 'coverage', SignalSource>;
   }

   interface Maxima {
     churn: number;
     importers: number;
   }

   const round = (n: number, places: number): number =>
     Math.round(n * 10 ** places) / 10 ** places;
   const ratio = (value: number, max: number): number =>
     max > 0 ? Math.min(1, value / max) : 0;
   const atLeastHalf = (value: number | null, max: number): boolean =>
     value !== null && value > 0 && value >= max / 2;

   function maximaOf(files: FileSignals[]): Maxima {
     return {
       churn: Math.max(0, ...files.map((f) => f.churn ?? 0)),
       importers: Math.max(0, ...files.map((f) => f.importers)),
     };
   }

   /** Shallow clones have no churn, so importers carry the whole weight (D9). */
   function baseScore(file: FileSignals, max: Maxima): number {
     const importers = ratio(file.importers, max.importers);
     if (file.churn === null) return importers;
     return 0.5 * ratio(file.churn, max.churn) + 0.5 * importers;
   }

   function riskScore(file: FileSignals, max: Maxima): number {
     const base = baseScore(file, max);
     // Untested alone is not critical: the boost needs another signal (D4).
     if (base === 0) return 0;
     const boost =
       file.coveragePct === null ? 0 : 0.15 * (1 - file.coveragePct / 100);
     return round(Math.min(1, base + boost), 2);
   }

   function signalsOf(file: FileSignals, max: Maxima): string[] {
     const signals: string[] = [];
     if (atLeastHalf(file.churn, max.churn)) signals.push('high_churn');
     if (atLeastHalf(file.importers, max.importers)) {
       signals.push('many_dependents');
     }
     if (file.coveragePct !== null && file.coveragePct < 50) {
       signals.push('low_coverage');
     }
     return signals;
   }

   function summaryOf(file: FileSignals): string {
     const churn =
       file.churn === null
         ? 'churn not measured'
         : `${file.churn} commits in ${CHURN_WINDOW_DAYS} days`;
     const coverage =
       file.coveragePct === null
         ? 'coverage not measured'
         : `coverage ${file.coveragePct}%`;
     return `${churn}, ${file.importers} importers, ${coverage}`;
   }

   function areaOf(
     file: FileSignals,
     max: Maxima,
     symbols: string[] | undefined,
   ) {
     const score = riskScore(file, max);
     const signals = signalsOf(file, max);
     return {
       path: file.path,
       risk_score: score,
       rank_score: score,
       signals,
       recommended_test_types: signals.includes('many_dependents')
         ? ['unit', 'integration']
         : ['unit'],
       summary: summaryOf(file),
       churn_commits: file.churn,
       importers: file.importers,
       coverage_pct: file.coveragePct,
       ...(symbols === undefined ? {} : { symbols }),
     };
   }

   export type Area = ReturnType<typeof areaOf>;

   const byRank = (a: Area, b: Area): number =>
     b.risk_score - a.risk_score || (a.path < b.path ? -1 : 1);

   /** The top scored areas, plus any path a person gave symbols to (D5, D13). */
   export function buildDocument(input: DocumentInput) {
     const { files, extras, symbols } = input;
     const max = maximaOf(files);
     const ranked = [...files, ...extras]
       .map((f) => areaOf(f, max, symbols.get(f.path)))
       .sort(byRank);
     const top = new Set(
       ranked
         .filter((a) => a.risk_score > 0)
         .slice(0, MAX_AREAS)
         .map((a) => a.path),
     );
     const scored = ranked.some((a) => a.risk_score > 0);
     return {
       generated: input.generated,
       base: input.base,
       generator: 'canary critical-areas',
       files_analyzed: files.length,
       signal_sources: input.sources,
       // No score means nothing to rank, so symbols alone do not make a map.
       areas: scored
         ? ranked.filter((a) => top.has(a.path) || a.symbols !== undefined)
         : [],
     };
   }
   ```

   The all-zero test asserts empty `areas` even when symbols are declared. Keep
   that case in the test list.

4. Run the test. Observe pass.
5. Run: `harness validate`
6. Commit: `feat(critical-areas): add the pure scoring document builder`

### Task 2: Git signals against a real repo

**Depends on:** Task 1 | **Files:** ts/src/critical-areas/git-signals.ts,
ts/test/critical-areas-git-signals.test.ts

1. Write the test with the shared helper, importing `readGitFacts`. Assert:
   - A non-repo returns `{ ok: false }` with a reason matching
     `/git repository/`; `git init` with no commit returns a reason matching
     `/no commit/`.
   - From a subdirectory, `top` is the realpath of the repo root (compare
     through `realpathSync`, since macOS tmp is a symlink) (D16), and `head` is
     the full 40-character SHA.
   - Candidate filter table with `it.each`, in: `src/a.ts`, `src/a.tsx`,
     `lib/b.mjs`, `app/c.py`, `web/d.php`. Out: `src/a.test.ts`,
     `src/a.spec.js`, `tests/x.py`, `test/x.ts`, `__tests__/x.js`, `test_x.py`,
     `x_test.py`, `conftest.py`, `FooTest.php`, `test/fixtures/y.ts`,
     `vendor/z.php`, `node_modules/z.js`, `dist/z.js`, `build/z.js`,
     `src/types.d.ts`, `src/a.min.js`, `README.md`. `tracked` still contains the
     excluded ones.
   - Window anchored to HEAD: commit `src/a.ts` at `2020-01-01` (over 90 days
     before), then at `2020-05-01`, then touch `src/b.ts` at `2020-06-01`. Churn
     is `a=1`, `b=1`. The 2020 dates prove the anchor: a wall-clock window would
     read 0.
   - A file name with a space survives (`src/a b.ts`), proving `-z` parsing.
   - Shallow: `git clone -q --depth 1 file://<root> <clone>`; `shallow` is
     `true` and `churn` is `null`.
2. Run: `cd ts && npx vitest run test/critical-areas-git-signals.test.ts`.
   Observe failure.
3. Create `ts/src/critical-areas/git-signals.ts`:

   ```ts
   /** Everything `canary critical-areas` asks git (#1529). All of it names HEAD. */
   import { execFileSync } from 'node:child_process';

   import { CHURN_WINDOW_DAYS } from './scoring.js';

   export interface GitFacts {
     ok: true;
     top: string;
     head: string;
     tracked: string[];
     candidates: string[];
     /** `null` in a shallow clone, where every file reads as one commit (D9). */
     churn: Map<string, number> | null;
   }

   export type GitRead = GitFacts | { ok: false; reason: string };

   const SOURCE = /\.(?:[cm]?[jt]sx?|py|php)$/;
   const EXCLUDED_DIR =
     /(?:^|\/)(?:node_modules|vendor|third_party|dist|build|out|coverage|fixtures?|__fixtures__|__mocks__|__tests__|tests?|specs?|e2e)\//;
   const EXCLUDED_FILE =
     /\.d\.[cm]?ts$|\.min\.js$|\.(?:test|spec)\.[^./]+$|(?:^|\/)test_[^/]+\.py$|_test\.py$|(?:^|\/)conftest\.py$|Test\.php$/;
   const MAX_BUFFER = 256 * 1024 * 1024;

   function git(cwd: string, args: string[]): string | null {
     try {
       return execFileSync('git', args, {
         cwd,
         encoding: 'utf-8',
         maxBuffer: MAX_BUFFER,
         stdio: ['ignore', 'pipe', 'ignore'],
       });
     } catch {
       return null;
     }
   }

   const isCandidate = (path: string): boolean =>
     SOURCE.test(path) && !EXCLUDED_DIR.test(path) && !EXCLUDED_FILE.test(path);

   const nulList = (text: string | null): string[] =>
     (text ?? '').split('\0').filter((p) => p !== '');

   /** Commits per path in the window ending at HEAD's commit time (D8). */
   function readChurn(top: string): Map<string, number> {
     const seconds = Number(git(top, ['show', '-s', '--format=%ct', 'HEAD']));
     const since = seconds - CHURN_WINDOW_DAYS * 86_400;
     const log = git(top, [
       'log',
       `--since=${new Date(since * 1000).toISOString()}`,
       '--format=',
       '--name-only',
       '--no-renames',
       '-z',
       'HEAD',
     ]);
     const churn = new Map<string, number>();
     for (const path of nulList(log)) {
       const name = path.trim();
       churn.set(name, (churn.get(name) ?? 0) + 1);
     }
     return churn;
   }

   export function readGitFacts(start: string): GitRead {
     const top = git(start, ['rev-parse', '--show-toplevel'])?.trim();
     if (top === undefined) {
       return { ok: false, reason: `${start} is not in a git repository` };
     }
     const head = git(top, [
       'rev-parse',
       '--verify',
       '-q',
       'HEAD^{commit}',
     ])?.trim();
     if (head === undefined) {
       return { ok: false, reason: `${top} has no commit` };
     }
     const shallow = git(top, ['rev-parse', '--is-shallow-repository'])?.trim();
     const tracked = nulList(
       git(top, ['ls-tree', '-r', '-z', '--name-only', 'HEAD']),
     );
     return {
       ok: true,
       top,
       head,
       tracked,
       candidates: tracked.filter(isCandidate),
       churn: shallow === 'true' ? null : readChurn(top),
     };
   }
   ```

   `name.trim()` strips the newline git leaves between commit groups under
   `--format= -z`. The space-in-name test guards an inner space. If a file name
   ever begins or ends in whitespace it reads as a different name, and its churn
   is a floor.

4. Run the test. Observe pass. Run `harness check-deps`.
5. Run: `harness validate`
6. Commit:
   `feat(critical-areas): read candidates and HEAD-anchored churn from git`

### Task 3: Importer counts for JS/TS, Python and PHP

**Depends on:** none | **Files:** ts/src/critical-areas/importers.ts,
ts/test/critical-areas-importers.test.ts

1. Write the test against files in `mkTmp()` (no git needed), importing
   `countImporters(root, files)`. A local `counts(tree)` writes the tree, passes
   `Object.keys(tree)` and returns the map. Assert with one `it` per row:
   - JS/TS: `import`, `export … from`, `require()`, `import()` of `./a.js` each
     count for `src/a.ts`; `./a` resolves to `a.ts`; `./dir` resolves to
     `dir/index.ts`.
   - Two imports from one file count once (unique importers).
   - A file importing itself counts 0.
   - Alias: `@/lib/a`, `~/lib/a` and `#/lib/a` count for `src/lib/a.ts` by
     suffix.
   - Ambiguous alias: `@/a` with `x/a.ts` and `y/a.ts` counts 0 for both.
   - Bare package `react` counts 0, even with `src/react.ts` present.
   - Python: `import a.b`, `from a.b import c`, `import x, a.b` count for
     `src/a/b.py`; `from .b import c` and `from ..a.b import c` resolve relative
     to the file; ambiguous suffix counts 0.
   - PHP: `require_once 'lib/x.php';`, relative to the file; `include('x.php')`;
     `use App\Billing\Charge;` counts for `src/App/Billing/Charge.php`.
   - No cross-language match: Python `import a` does not count for `a.ts`.
   - A listed file missing from disk is skipped, not thrown.
   - Every listed file has a key, with 0 when nothing imports it.
2. Run: `cd ts && npx vitest run test/critical-areas-importers.test.ts`. Observe
   failure.
3. Create `ts/src/critical-areas/importers.ts`:

   ```ts
   /**
    * Unique-importer counts (#1529). Read, not resolved, as in katana's
    * imports.mjs: an ambiguous suffix counts nothing, so the count is a floor.
    */
   import { readFileSync } from 'node:fs';
   import { join, posix } from 'node:path';

   type Lang = 'js' | 'py' | 'php';

   interface Scope {
     files: ReadonlySet<string>;
     /** `<lang>:<path suffix without extension>` to the paths ending so. */
     suffixes: ReadonlyMap<string, string[]>;
   }

   const JS_FILE = /\.[cm]?[jt]sx?$/;
   const JS_SPEC =
     /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"]([^'"\n]+)['"]/g;
   const JS_ALIAS = /^[@~#]\//;
   const JS_EXTS = [
     '.ts',
     '.tsx',
     '.mts',
     '.cts',
     '.js',
     '.jsx',
     '.mjs',
     '.cjs',
   ];
   const JS_MAPPED: Record<string, string[]> = {
     '.js': ['.ts', '.tsx'],
     '.jsx': ['.tsx'],
     '.mjs': ['.mts'],
     '.cjs': ['.cts'],
   };
   const PY_STMT =
     /^[ \t]*(?:from[ \t]+(\.*[\w.]*)[ \t]+import|import[ \t]+([\w., \t]+))/gm;
   const PHP_PATH =
     /\b(?:require|include)(?:_once)?\s*\(?\s*['"]([^'"\n]+)['"]/g;
   const PHP_USE = /^[ \t]*use[ \t]+\\?([\w\\]+)/gm;

   function langOf(path: string): Lang | null {
     if (path.endsWith('.py')) return 'py';
     if (path.endsWith('.php')) return 'php';
     return JS_FILE.test(path) ? 'js' : null;
   }

   function buildScope(files: string[]): Scope {
     const suffixes = new Map<string, string[]>();
     for (const file of files) {
       const lang = langOf(file);
       const parts = file.replace(/\.[^./]+$/, '').split('/');
       parts.forEach((_, i) => {
         const key = `${lang}:${parts.slice(i).join('/')}`;
         suffixes.set(key, [...(suffixes.get(key) ?? []), file]);
       });
     }
     return { files: new Set(files), suffixes };
   }

   const uniqueSuffix = (
     scope: Scope,
     lang: Lang,
     key: string,
   ): string | null => {
     const hits = scope.suffixes.get(`${lang}:${key}`) ?? [];
     return hits.length === 1 ? hits[0]! : null;
   };

   const firstFile = (scope: Scope, names: string[]): string | null =>
     names.find((n) => scope.files.has(n)) ?? null;

   function jsCandidates(base: string): string[] {
     const ext = posix.extname(base);
     const mapped = (JS_MAPPED[ext] ?? []).map(
       (e) => base.slice(0, -ext.length) + e,
     );
     return [
       base,
       ...mapped,
       ...JS_EXTS.map((e) => base + e),
       ...JS_EXTS.map((e) => `${base}/index${e}`),
     ];
   }

   function resolveJs(spec: string, from: string, scope: Scope): string | null {
     if (JS_ALIAS.test(spec)) {
       const key = spec.slice(2).replace(/\.[^./]+$/, '');
       return uniqueSuffix(scope, 'js', key);
     }
     if (!spec.startsWith('.')) return null;
     const base = posix.join(posix.dirname(from), spec);
     return firstFile(scope, jsCandidates(base));
   }

   function resolvePy(
     module: string,
     from: string,
     scope: Scope,
   ): string | null {
     const dots = /^\.*/.exec(module)![0].length;
     const key = module.slice(dots).replaceAll('.', '/');
     if (dots === 0) return uniqueSuffix(scope, 'py', key);
     const up = '../'.repeat(dots - 1);
     const base = posix.join(posix.dirname(from), up, key);
     return firstFile(scope, [`${base}.py`, `${base}/__init__.py`]);
   }

   function matchesOf(text: string, pattern: RegExp): string[][] {
     return [...text.matchAll(pattern)].map((m) => m.slice(1));
   }

   function jsTargets(text: string, from: string, scope: Scope) {
     return matchesOf(text, JS_SPEC).map(([spec]) =>
       resolveJs(spec!, from, scope),
     );
   }

   function pyTargets(text: string, from: string, scope: Scope) {
     return matchesOf(text, PY_STMT).flatMap(([fromModule, imported]) =>
       (fromModule !== undefined ? [fromModule] : imported!.split(','))
         .map((m) => m.trim().split(/\s/)[0]!)
         .map((m) => resolvePy(m, from, scope)),
     );
   }

   function phpTargets(text: string, from: string, scope: Scope) {
     const paths = matchesOf(text, PHP_PATH).map(([p]) =>
       firstFile(scope, [posix.join(posix.dirname(from), p!)]),
     );
     const uses = matchesOf(text, PHP_USE).map(([u]) =>
       uniqueSuffix(scope, 'php', u!.replaceAll('\\', '/')),
     );
     return [...paths, ...uses];
   }

   const TARGETS = { js: jsTargets, py: pyTargets, php: phpTargets };

   function readSource(path: string): string | null {
     try {
       return readFileSync(path, 'utf-8');
     } catch {
       return null;
     }
   }

   /** Unique non-self importers per file. Pass only non-test sources (D7). */
   export function countImporters(
     root: string,
     files: string[],
   ): Map<string, number> {
     const scope = buildScope(files);
     const counts = new Map(files.map((f) => [f, 0]));
     for (const from of files) {
       const lang = langOf(from);
       const text = readSource(join(root, from));
       if (lang === null || text === null) continue;
       const targets = new Set(TARGETS[lang](text, from, scope));
       for (const target of targets) {
         if (target !== null && target !== from) {
           counts.set(target, counts.get(target)! + 1);
         }
       }
     }
     return counts;
   }
   ```

4. Run the test. Observe pass. Run `harness check-deps`.
5. Run: `harness validate`
6. Commit:
   `feat(critical-areas): count unique importers across JS, Python and PHP`

### Task 4: The command, its registry entry, and the write and abstain paths

**Depends on:** Tasks 1, 2, 3 | **Files:**
ts/src/critical-areas/critical-areas-cli.ts, ts/test/critical-areas-cli.test.ts,
ts/src/commands/audit/cli.ts, ts/test/cli-command-registry.test.ts

Four files, over the three-file guideline: the registry test fails on any commit
that has the command without the row, so they cannot land apart.

1. Write `ts/test/critical-areas-cli.test.ts` with the shared helper and a
   `ranked(root)` fixture: `src/a.ts` importing `./b.js`, `src/b.ts`, a second
   commit touching `src/a.ts`. Assert through `invokeCanary`:
   - Exit 0; `.canary/critical-areas.json` exists; `generator`, full-SHA `base`
     and `files_analyzed: 2` are right; `src/b.ts` has `importers: 1`;
     `src/a.ts` has `churn_commits: 2` (criterion 1).
   - `--out nested/deep/x.json` with `--root` writes there, creates parents and
     leaves `.canary/` absent (criterion 2). Use an absolute `--out`.
   - Run from `--root <repo>/src`: the file lands at `<repo>/.canary/…` and
     paths are repo-relative (D16).
   - Exit 3 and no file for: no git repo; `git init` only; a repo with only
     `README.md`; a repo with two sources that import nothing, in a shallow
     clone, so every score is 0. Each output contains `Abstained` (criterion 7).
   - An existing output file is byte-identical after an abstaining run: plant
     the file in the shallow all-zero fixture (criterion 7).
   - Shallow clone with imports: `churn_commits: null`, `signal_sources.churn`
     is `absent` with a reason matching `/shallow/`, and `src/b.ts` scores 1
     (criterion 8).
   - Run twice: documents are deep-equal after deleting `generated`, and the
     `generated` field parses as a date (criterion 10).
2. In `ts/test/cli-command-registry.test.ts`, add `'critical-areas',`
   immediately after `'order',` in `EXPECTED_COMMANDS`.
3. Run both. Observe failure.
4. Create `ts/src/critical-areas/critical-areas-cli.ts`. Task 5 fills in
   `loadCoverage` and Task 6 fills in `readKeptSymbols`; here they are the
   no-report and no-symbols forms below.

   ```ts
   /**
    * `canary critical-areas` (#1529): writes `.canary/critical-areas.json`, which
    * canary-katana alarms against. See docs/guides/critical-areas.md.
    *
    * Exit codes follow the CLI-wide gate contract:
    *   - 0: the file was written.
    *   - 2: an explicit --coverage report is missing or unparseable.
    *   - 3 (EXIT_ABSTAINED): nothing to rank, so NOTHING is written. An empty map
    *     would also overwrite a good one.
    */
   import { mkdirSync, writeFileSync } from 'node:fs';
   import { dirname, join, resolve } from 'node:path';
   import { Command } from 'commander';

   import { CliExitError, jsonIndent2 } from '../cli-common.js';
   import { EXIT_ABSTAINED } from '../core/gate-result.js';
   import type { MainDeps } from '../main-deps.js';
   import { readGitFacts, type GitFacts } from './git-signals.js';
   import { countImporters } from './importers.js';
   import {
     buildDocument,
     CHURN_WINDOW_DAYS,
     type FileSignals,
     type SignalSource,
   } from './scoring.js';

   interface CriticalAreasOpts {
     root?: string;
     out?: string;
     coverage?: string;
   }

   function abstain(deps: MainDeps, why: string): never {
     deps.out(`Abstained: ${why}; no critical-areas file written.`);
     throw new CliExitError(EXIT_ABSTAINED);
   }

   function churnSource(facts: GitFacts): SignalSource {
     return facts.churn === null
       ? {
           status: 'absent',
           reason: 'shallow clone: every file reads as one commit',
           window_days: CHURN_WINDOW_DAYS,
         }
       : { status: 'measured', window_days: CHURN_WINDOW_DAYS };
   }

   function signalsFor(
     paths: string[],
     facts: GitFacts,
     importers: ReadonlyMap<string, number>,
     pctOf: (path: string) => number | null,
   ): FileSignals[] {
     return paths.map((path) => ({
       path,
       churn: facts.churn === null ? null : (facts.churn.get(path) ?? 0),
       importers: importers.get(path) ?? 0,
       coveragePct: pctOf(path),
     }));
   }

   function runCriticalAreas(opts: CriticalAreasOpts, deps: MainDeps): void {
     const facts = readGitFacts(resolve(opts.root ?? deps.cwd()));
     if (!facts.ok) abstain(deps, facts.reason);
     if (facts.candidates.length === 0) {
       abstain(deps, `0 source files in HEAD of ${facts.top}`);
     }
     const out =
       opts.out === undefined
         ? join(facts.top, '.canary', 'critical-areas.json')
         : resolve(deps.cwd(), opts.out);
     const importers = countImporters(facts.top, facts.candidates);
     const doc = buildDocument({
       generated: new Date().toISOString(),
       base: facts.head,
       files: signalsFor(facts.candidates, facts, importers, () => null),
       extras: [],
       symbols: new Map(),
       sources: {
         churn: churnSource(facts),
         importers: { status: 'measured' },
         coverage: { status: 'absent', reason: 'no coverage report read' },
       },
     });
     if (doc.areas.length === 0) {
       abstain(
         deps,
         `every score is 0 across ${facts.candidates.length} file(s)`,
       );
     }
     mkdirSync(dirname(out), { recursive: true });
     writeFileSync(out, jsonIndent2(doc) + '\n', 'utf-8');
     deps.out(
       `Wrote ${out}: ${doc.areas.length} area(s) from ${doc.files_analyzed} file(s).`,
     );
   }

   export function buildCriticalAreasCommand(deps: MainDeps): Command {
     return new Command('critical-areas')
       .description(
         'Rank tracked source files by churn, importers and coverage, and write .canary/critical-areas.json for canary-katana.',
       )
       .option(
         '--root <dir>',
         'Any directory in the repository (default: current directory).',
       )
       .option(
         '--out <path>',
         'Output file (default: <repo top>/.canary/critical-areas.json).',
       )
       .option(
         '--coverage <file>',
         'Coverage report (default: the first conventional report found).',
       )
       .action((opts: CriticalAreasOpts) => {
         runCriticalAreas(opts, deps);
       });
   }
   ```

   If `facts.ok` does not narrow through the `never` call, write
   `if (!facts.ok) return abstain(deps, facts.reason);`.

5. In `ts/src/commands/audit/cli.ts`, add
   `import { buildCriticalAreasCommand } from '../../critical-areas/critical-areas-cli.js';`
   after the `buildOrderCommand` import, add
   `(deps) => buildCriticalAreasCommand(deps),` after the order row, and add
   `critical areas` to the header comment's list.
6. Run:
   `cd ts && npm run build && npx vitest run test/critical-areas-cli.test.ts test/cli-command-registry.test.ts`.
   Observe pass.
7. Run: `harness check-deps`, then `harness validate`
8. Commit: `feat(critical-areas): add the canary critical-areas command`

### Task 5: Coverage: discovery, explicit report, and null over 0

**Depends on:** Task 4 | **Files:** ts/src/critical-areas/critical-areas-cli.ts,
ts/test/critical-areas-cli.test.ts

1. Add tests. The report fixture is a `coverage/lcov.info` listing only
   `src/a.ts` with `DA:1,1` and `DA:2,0`:
   - No report: every `coverage_pct` is `null`; `signal_sources.coverage.status`
     is `absent`, and its reason names `coverage/lcov.info` (criterion 3).
   - Discovered report: `src/a.ts` has `coverage_pct: 50`; `src/b.ts` has
     `coverage_pct: null`, not 0 (criterion 4); status is `measured` with
     `report: 'coverage/lcov.info'` and `files_matched: 1`.
   - A `DA:1,0`-only report gives `coverage_pct: 0` and `low_coverage`, proving
     a measured 0 stays 0.
   - Discovery precedence: `coverage/lcov.info` wins over `lcov.info`.
   - `--coverage missing.info`: exit 2, stderr names the path, no file written.
   - `--coverage bad.json` holding `not json`: exit 2, no file written. Also
     from a non-repo directory, exit 2 rather than 3 (the assumption above).
   - Discovered unparseable report: exit 0, `absent`, reason matches
     `/could not/`.
   - Report matching 0 files, discovered and explicit: exit 0, `absent`, reason
     matches `/0 of 2/` (D12).
2. Run: `cd ts && npx vitest run test/critical-areas-cli.test.ts`. Observe
   failure.
3. Add to `critical-areas-cli.ts`:

   ```ts
   import { existsSync } from 'node:fs'; // merged with the existing fs import
   import { relative } from 'node:path'; // merged with the existing path import
   import {
     anchorIndex,
     readReportIndex,
   } from '../guardian/diff-coverage/report-tier.js';
   import {
     matchFile,
     recordedLines,
     type FileCoverage,
     type ReportIndex,
   } from '../guardian/diff-coverage/types.js';

   /** The conventional report names, first found wins (D11). */
   const DISCOVERED_REPORTS = [
     'coverage/lcov.info',
     'lcov.info',
     'coverage/coverage.json',
     'coverage.json',
     'coverage.xml',
   ];

   interface CoverageRead {
     pctOf: (path: string) => number | null;
     source: SignalSource;
   }

   const absentCoverage = (reason: string): CoverageRead => ({
     pctOf: () => null,
     source: { status: 'absent', reason },
   });

   /** Hit lines over measured lines; a file with none measured is unknown. */
   function linePct(file: FileCoverage): number | null {
     const measured = file.coverable ?? recordedLines(file.hits);
     if (measured.size === 0) return null;
     const hit = [...measured].filter((l) => (file.hits[l] ?? 0) > 0).length;
     return Math.round((1000 * hit) / measured.size) / 10;
   }

   /** A typo'd flag must not quietly degrade (D12): exit 2 before anything else. */
   function readExplicitReport(
     opts: CriticalAreasOpts,
     deps: MainDeps,
   ): { path: string; index: ReportIndex } | null {
     if (opts.coverage === undefined) return null;
     const path = resolve(deps.cwd(), opts.coverage);
     const { found, index } = readReportIndex(path);
     if (index !== null) return { path, index };
     deps.err(
       found
         ? `--coverage ${path} could not be parsed.`
         : `--coverage ${path} does not exist.`,
     );
     throw new CliExitError(2);
   }

   function discoverReport(
     top: string,
   ): CoverageRead | { path: string; index: ReportIndex } {
     const name = DISCOVERED_REPORTS.find((r) => existsSync(join(top, r)));
     if (name === undefined) {
       return absentCoverage(`no report at ${DISCOVERED_REPORTS.join(', ')}`);
     }
     const path = join(top, name);
     const { index } = readReportIndex(path);
     return index === null
       ? absentCoverage(`${name} could not be parsed`)
       : { path, index };
   }

   function coverageFrom(
     report: { path: string; index: ReportIndex },
     facts: GitFacts,
   ): CoverageRead {
     const anchored = anchorIndex(report.index, report.path, facts.top);
     const name = relative(facts.top, report.path);
     const pcts = new Map<string, number | null>();
     for (const path of facts.candidates) {
       const file = matchFile(path, anchored);
       if (file !== null) pcts.set(path, linePct(file));
     }
     if (pcts.size === 0) {
       return absentCoverage(
         `${name} matched 0 of ${facts.candidates.length} source file(s)`,
       );
     }
     return {
       pctOf: (path) => pcts.get(path) ?? null,
       source: { status: 'measured', report: name, files_matched: pcts.size },
     };
   }

   function loadCoverage(
     explicit: { path: string; index: ReportIndex } | null,
     facts: GitFacts,
   ): CoverageRead {
     const report = explicit ?? discoverReport(facts.top);
     return 'index' in report ? coverageFrom(report, facts) : report;
   }
   ```

   In `runCriticalAreas`, call
   `const explicit = readExplicitReport(opts, deps);` as the first line and
   `const coverage = loadCoverage(explicit, facts);` before `buildDocument`.
   Pass `coverage.pctOf` to `signalsFor` and `coverage.source` as
   `sources.coverage`.

   Export check: `matchFile` and `recordedLines` are already exported from
   `types.ts`; no change there.

4. Run the test. Observe pass. Confirm no other `critical-areas` module gained a
   guardian import:
   `cd ts/src/critical-areas && grep -n guardian scoring.ts git-signals.ts importers.ts`
   prints nothing. Run `harness check-deps`.
5. Run: `harness validate`
6. Commit: `feat(critical-areas): read coverage reports, with absent as null`

### Task 6: Keep declared symbols, and the abstention row

**Depends on:** Task 5 | **Files:** ts/src/critical-areas/critical-areas-cli.ts,
ts/test/critical-areas-cli.test.ts, ts/test/gate-conformance.test.ts

1. Add tests to `critical-areas-cli.test.ts`, planting the existing output file
   before the run:
   - `symbols: ['chargeCard']` on `src/a.ts` survives the rewrite (criterion 9).
   - A fixture of 27 imported files, with `src/quiet.ts` having no signal and
     declared symbols: it is listed with score 0, and the rest are capped at 25.
   - Symbols on `gone/old.ts` (not in HEAD): it is not listed, and stdout
     matches `/Dropped symbols.*gone\/old\.ts/` (D13).
   - Symbols on `tests/x.test.ts`, tracked but not a candidate: it is listed,
     and `files_analyzed` does not count it.
   - A malformed existing file (`not json`): exit 0, overwritten (D17).
   - Entries with an empty or non-string `symbols` value are not carried.
   - A `--out` run reads symbols from that `--out` path, not the default one.
   - Running twice with symbols keeps criterion 10.
2. Add to the `ROWS` table in `ts/test/gate-conformance.test.ts`, before the
   closing `];`:

   ```ts
   {
     command: 'critical-areas',
     layer: 'engine',
     kind: 'gate',
     expect: 'exit3',
     forbid: ['Wrote '],
     // #1529: not a git repository -> zero files to rank, and nothing written.
     run: (base) => invokeCanary(['critical-areas', '--root', base]),
   },
   ```

3. Run:
   `cd ts && npx vitest run test/critical-areas-cli.test.ts test/gate-conformance.test.ts`.
   The row already passes, since Task 4 abstains; its proof is the plant in
   Task 10. The symbols tests fail.
4. Add to `critical-areas-cli.ts`:

   ```ts
   import { readFileSync } from 'node:fs'; // merged with the existing fs import

   function readDeclaredSymbols(out: string): Map<string, string[]> {
     let data: { areas?: unknown };
     try {
       data = JSON.parse(readFileSync(out, 'utf-8')) as { areas?: unknown };
     } catch {
       return new Map();
     }
     const rows = Array.isArray(data?.areas) ? data.areas : [];
     const declared = new Map<string, string[]>();
     for (const row of rows as { path?: unknown; symbols?: unknown }[]) {
       const valid =
         Array.isArray(row?.symbols) &&
         row.symbols.length > 0 &&
         row.symbols.every((s) => typeof s === 'string' && s !== '');
       if (valid && typeof row.path === 'string') {
         declared.set(row.path, row.symbols as string[]);
       }
     }
     return declared;
   }

   /** A person chose these (D13); only a path gone from HEAD loses them. */
   function keepSymbols(out: string, facts: GitFacts) {
     const tracked = new Set(facts.tracked);
     const declared = [...readDeclaredSymbols(out)];
     return {
       kept: new Map(declared.filter(([path]) => tracked.has(path))),
       dropped: declared.map(([path]) => path).filter((p) => !tracked.has(p)),
     };
   }
   ```

   In `runCriticalAreas`, after `out` is resolved:

   ```ts
   const { kept, dropped } = keepSymbols(out, facts);
   const candidates = new Set(facts.candidates);
   const extraPaths = [...kept.keys()].filter((p) => !candidates.has(p));
   ```

   Pass `extras: signalsFor(extraPaths, facts, importers, coverage.pctOf)` and
   `symbols: kept` to `buildDocument`. After the write, add:

   ```ts
   if (dropped.length > 0) {
     deps.out(
       `Dropped symbols for paths no longer in HEAD: ${dropped.join(', ')}.`,
     );
   }
   ```

   `runCriticalAreas` must stay at 50 lines or fewer and complexity 10 or less.
   If it passes either limit, move the `buildDocument` call into a
   `documentFor(facts, coverage, kept)` helper.

5. Run the tests. Observe pass.
6. Run: `harness validate`
7. Commit:
   `feat(critical-areas): keep declared symbols and register the abstention row`

### Task 7: Consumer proof

**Depends on:** Task 6 | **Files:** ts/test/critical-areas-consumers.test.ts

No production code: this proves output against the real consumers, so its plant
is in Task 10.

1. Create the test, with
   `REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')` and
   the shared helper. Fixture: commit `src/points.py`, `src/app.py`
   (`from src.points import earn`) and `tests/test_points.py` (`x = 1\n`). Run
   `invokeCanary(['critical-areas', '--root', root])`, expect exit 0. The diff
   file holds `PY_REMOVAL`, copied from
   `agents/skills/test/canary-katana.test.ts:38`. Spawn with `spawnSync` with
   `process.execPath`, encoding `utf-8`, and the arguments:

   ```text
   <REPO_ROOT>/agents/skills/claude-code/canary-katana/scripts/cli.mjs
   --repo <root> --diff-file <diff> --critical-areas <out> --json --no-write
   ```

   Assert:
   - Criterion 5: the JSON has no `degraded_notice`, `areas.total` is above 0,
     and `findings` contains `kind: 'last-coverage-removed'` with
     `area: 'src/points.py'`.
   - Control: the same spawn with `--critical-areas <missing>` has
     `degraded_notice` and no findings. This shows the alarm above comes from
     the generated file.
   - Criterion 6: `parseCriticalAreas(readFileSync(out, 'utf-8'))` is `ok` with
     the paths and `risk_score` values in the file; `loadAreas(root).areas` has
     the same paths; `readRankIndex(root)` maps each path to its `rank_score`.
     Compare against the file with exact equality, and assert the list is
     non-empty, so a zero-row read cannot pass.

2. Run: `cd ts && npx vitest run test/critical-areas-consumers.test.ts`. Observe
   pass. If katana reports `src/points.py` as not assessed, read the
   `not_assessed` evidence and adjust only the fixture.
3. Run: `harness validate`
4. Commit:
   `test(critical-areas): prove generated output through katana and the engine readers`

### Task 8: Katana's degraded line names the generator

**Depends on:** none | **Files:**
agents/skills/claude-code/canary-katana/scripts/alarm.mjs,
agents/skills/test/canary-katana.test.ts,
agents/skills/claude-code/canary-katana/SKILL.md

1. In `agents/skills/test/canary-katana.test.ts:768`, change the pin to:

   ```ts
   expect(alarm.DEGRADED_NOTICE).toBe(
     'critical-area data unavailable, recording only, not alarming; run `canary critical-areas`, then pass --critical-areas .canary/critical-areas.json',
   );
   ```

2. Run: `cd agents/skills && npx vitest run test/canary-katana.test.ts`. Observe
   failure.
3. In `alarm.mjs:41`:

   ```js
   // Katana has no default path for this file, so the line names both steps.
   export const DEGRADED_NOTICE =
     'critical-area data unavailable, recording only, not alarming; ' +
     'run `canary critical-areas`, then pass --critical-areas .canary/critical-areas.json';
   ```

4. In `agents/skills/claude-code/canary-katana/SKILL.md:218`, replace the fenced
   line with the `DEGRADED_NOTICE` text pinned in step 1.
5. Re-run. Observe pass, including the `toContain` uses at lines 1735, 1751
   and 1792.
6. Run: `harness validate`
7. Commit: `fix(canary-katana): name the generator command in the degraded line`

### Task 9: Command points at the skill; skill names the CLI

**Depends on:** Task 7 | **Files:** commands/canary-critical-areas.md,
agents/skills/claude-code/canary-critical-areas/SKILL.md,
ts/test/critical-areas-consumers.test.ts

1. Add to `critical-areas-consumers.test.ts` (criterion 11):

   ```ts
   it('the command names no agent that does not exist', () => {
     const text = readFileSync(
       join(REPO_ROOT, 'commands/canary-critical-areas.md'),
       'utf-8',
     );
     const agents = [...text.matchAll(/`([\w-]+)` agent/g)].map((m) => m[1]!);
     for (const name of agents) {
       expect(
         existsSync(join(REPO_ROOT, 'agents/agents/claude-code', `${name}.md`)),
       ).toBe(true);
     }
     expect(text).toContain('`canary-critical-areas` skill');
   });
   ```

2. Run it. Observe failure: the
   `agents/agents/claude-code/canary-critical-areas.md` file is absent.
3. In `commands/canary-critical-areas.md`, replace line 9 with:
   ``Use the `canary-critical-areas` skill to identify the highest-risk areas.``
4. In `agents/skills/claude-code/canary-critical-areas/SKILL.md`, under
   `## Optional Artifact`, before "When `--save`…", add:

   ```markdown
   For the deterministic map without any judgement, run `canary critical-areas`.
   It writes this same file from churn, importers and any coverage report, and
   keeps declared `symbols`. See `docs/guides/critical-areas.md`.
   ```

5. Run the test. Observe pass.
6. Run: `harness validate`
7. Commit:
   `fix(canary-critical-areas): point the command at the skill and name the CLI`

### Task 10: Plant the regression in each new test

**Depends on:** Tasks 1-9 | **Files:** none committed

Each test must be seen to catch the bug it exists for. For each row: make the
edit, run the named test, confirm the expected test fails with a non-zero test
count, then `git checkout -- <file>`. Run `git status --short` at the end and
confirm it is clean. Run `cd ts && npm run build` first and after each CLI-side
plant, because `invokeCanary` paths may read built output (`dist` can be stale).

| Test file                          | Plant                                                                     | Must fail                      |
| ---------------------------------- | ------------------------------------------------------------------------- | ------------------------------ |
| critical-areas-scoring.test.ts     | `base === 0` guard in `riskScore` removed                                 | untested-alone scores 0        |
| critical-areas-scoring.test.ts     | `baseScore` returns `0.5 * importers` for null churn                      | shallow scores 1               |
| critical-areas-git-signals.test.ts | `since` computed from `Date.now()`                                        | window anchored to HEAD        |
| critical-areas-git-signals.test.ts | `churn: readChurn(top)` unconditionally                                   | shallow is null                |
| critical-areas-importers.test.ts   | `uniqueSuffix` returns `hits[0] ?? null`                                  | ambiguous counts 0             |
| critical-areas-importers.test.ts   | Drop the `target !== from` check                                          | self-import counts 0           |
| critical-areas-cli.test.ts         | Move the `mkdirSync`/`writeFileSync` above the `doc.areas.length` abstain | abstain leaves the file intact |
| critical-areas-cli.test.ts         | `pctOf` returns `pcts.get(path) ?? 0`                                     | unlisted file is null          |
| critical-areas-cli.test.ts         | Explicit unparseable report falls through to discovery                    | exit 2 cases                   |
| critical-areas-cli.test.ts         | `keepSymbols` keeps every declared path                                   | dropped path                   |
| critical-areas-consumers.test.ts   | `risk_score` renamed to `score` in `areaOf`                               | parseCriticalAreas equality    |
| critical-areas-consumers.test.ts   | `rank_score` removed from `areaOf`                                        | readRankIndex equality         |
| critical-areas-consumers.test.ts   | `areas: []` always from `buildDocument`, with the abstain check disabled  | katana alarm, non-empty guard  |
| critical-areas-consumers.test.ts   | Restore the old agent line in `commands/canary-critical-areas.md`         | command names no missing agent |
| gate-conformance.test.ts (new row) | Stop abstaining on `!facts.ok`, per the note below                        | critical-areas row             |
| cli-command-registry.test.ts       | Remove the `buildCriticalAreasCommand` row from `audit/cli.ts`            | registry snapshot              |
| canary-katana.test.ts              | Restore the old `DEGRADED_NOTICE` text                                    | degraded notice pin            |

For the gate row, the plant is: in the `!facts.ok` branch, replace the call with
`deps.out('nothing to do'); return;`. Commit nothing. Record the outcome of each
row in the PR body under "Plant proofs".

Run: `harness validate`

### Task 11: Guide, index, README, entry points, and the ratchets

**Depends on:** Task 10 | **Files:** docs/guides/critical-areas.md,
docs/guides/index.md, README.md, harness.config.json | **Category:** integration

Four files, over the three-file guideline. All are mechanical and they ratchet
together: the entropy scan reads the entry points and the docs floor reads the
guide.

1. Create `docs/guides/critical-areas.md`. Sections:
   - **What it does:** the command and flags, and that it serves katana's
     `--critical-areas`.
   - **Score:** the D3 formula, the D4 boost rule, the D9 importers-only shallow
     fallback, and the top-25-plus-symbols rule.
   - **Signals:** `null` means not measured, never 0. Coverage discovery order
     and D12. Importer table from the spec, stating that **the count is a
     floor** and reads the working tree.
   - **Exit codes:** the 0/2/3 table.
   - **Overwriting:** it overwrites a skill-written map, keeping `symbols` for
     paths in HEAD (D17).
   - **`rank_score` and `risk_score`:** two names for one idea across consumers;
     it writes both (D14); unifying them is a follow-up.
   - **Source**, in the `order.md` format:

     ```markdown
     - [critical-areas-cli.ts](../../ts/src/critical-areas/critical-areas-cli.ts):
       the command, coverage read, symbols merge and exit codes.
     - [git-signals.ts](../../ts/src/critical-areas/git-signals.ts): top level,
       HEAD, candidate files, churn and the shallow check.
     - [importers.ts](../../ts/src/critical-areas/importers.ts): unique
       importers.
     - [scoring.ts](../../ts/src/critical-areas/scoring.ts): the pure score and
       document.
     ```

2. In `docs/guides/index.md`, after the Order Guide entry, add:

   ```markdown
   ### [Critical Areas Guide](./critical-areas.md)

   `canary critical-areas` — ranks tracked source files by churn, importers and
   coverage, and writes the map `canary-katana` alarms against.

   **Best for:** Giving katana real critical-area data in a fresh worktree.
   ```

3. In `README.md`, after the `canary inventory [testDir]` row (line 272), add:

   ```markdown
   | `canary critical-areas` | CLI, deterministic — writes
   `.canary/critical-areas.json` for `canary-katana`. |
   ```

4. In `harness.config.json`, add these to both `entryPoints` arrays, next to
   `ts/src/order/order-cli.ts` (lines 324 and 484):

   ```json
   "ts/src/critical-areas/critical-areas-cli.ts",
   "ts/src/critical-areas/git-signals.ts",
   "ts/src/critical-areas/importers.ts",
   "ts/src/critical-areas/scoring.ts",
   ```

5. Run `ts/node_modules/.bin/prettier --write` on each changed `.md` and `.ts`
   file, listing them explicitly.
6. Run the gates from `ts/`: `npm run build`, `npm run typecheck`,
   `npm run format:check`, `npm test`. From the root: `harness check-deps`,
   `harness validate`, `harness check-perf`, `harness cleanup`, and
   `node ts/bin/canary.js critical-areas --root . --out "$(mktemp -d)/ca.json"`
   (expect exit 0 with non-zero `files_analyzed`). Read each count, not only the
   exit code. A new finding gets fixed, never baselined: split a function, or
   remove an export nothing imports. Do not raise `maxFindings`.
7. Commit: `docs(critical-areas): add the guide and register the modules`

## Traceability

| Criterion | Tasks | Criterion | Tasks   |
| --------- | ----- | --------- | ------- |
| 1         | 4     | 7         | 4, 6    |
| 2         | 4     | 8         | 1, 2, 4 |
| 3         | 1, 5  | 9         | 1, 6    |
| 4         | 5     | 10        | 4, 6    |
| 5         | 7     | 11        | 9       |
| 6         | 7     | 12        | 8       |

## Parallelism

Tasks 1, 3 and 8 have no dependencies. Task 2 follows 1 for `CHURN_WINDOW_DAYS`.
Tasks 4 to 7 share `critical-areas-cli.ts` or build on it, so they run serially.
Tasks 10 and 11 run last.
