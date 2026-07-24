# Plan: TestTracker Ingest Reporter (interim)

**Date:** 2026-07-24 | **Spec:** `docs/changes/testtracker-ingest-reporter/proposal.md` | **Tasks:** 18 | **Time:** ~75 min code + 2 human checkpoints | **Integration Tier:** medium

> Cross-repo plan. Canary tasks (1–10) run in this worktree
> (`canary-testtracker-reporter`, branch `feat/testtracker-ingest-reporter`).
> Capwell tasks (12–15) and optum tasks (16–18) run in their OWN isolated
> worktrees, created at execution time (see each task). The Canary package must
> be published/linked before downstream repos can consume `canary-test-cli/reporter`.

## Gates

- No vague tasks; exact paths/code/commands.
- TDD: reporter logic is pure + unit-tested via the existing `node --test` infra.
- The reporter must NEVER throw from `onEnd` and NEVER push without URL+token and (CI or force flag).
- Observable truths (proposal §Goals) each trace to ≥1 task.

## Observable truths → tasks

| # | Truth | Task(s) |
|---|---|---|
| 1 | pushes one run on `onEnd` when configured + (CI or force) | 2,3 |
| 2 | no-op + no error when unconfigured / not CI | 2,3 |
| 3 | never fails the run on push error | 2,3 |
| 4 | stable `canary_run_id` (GITHUB_RUN_ID[-ATTEMPT]) dedupes | 2,3 |
| 5 | suite / test_file prefix / environment from config | 2,3 |
| 6 | `merge-reports --reporter canary-test-cli/reporter` pushes once | 6,14 |
| 7 | optum copies gone; suites still push | 16,17,18 |
| 8 | capwell tenant shows capwell-api + capwell-web runs on dev | 11,15,18 |

---

## Phase 1 — Canary reporter (this worktree)

### Task 1: Scaffold reporter dir + failing test
**Depends on:** none | **Files:** `npm/src/reporters/testtracker.ts` (stub), `npm/scripts/__tests__/testtracker.test.js` (CREATE) | **Category:** impl

Create the reporter stub exporting the pure helpers, and a failing `node:test`
suite that imports from the built `dist/reporters/testtracker.js`.

`npm/src/reporters/testtracker.ts` (stub — real body in Task 2):
```ts
export function mapStatus(_pw: string): string { return "skipped"; }
export function resolveConfig(_opts: unknown, _env: NodeJS.ProcessEnv): never {
  throw new Error("not implemented");
}
```

`npm/scripts/__tests__/testtracker.test.js`:
```js
const test = require("node:test");
const assert = require("node:assert/strict");
const { mapStatus, resolveConfig, buildPayload, shouldPush } = require("../../dist/reporters/testtracker.js");

test("mapStatus collapses PW statuses", () => {
  assert.equal(mapStatus("passed"), "passed");
  assert.equal(mapStatus("timedOut"), "failed");
  assert.equal(mapStatus("failed"), "failed");
  assert.equal(mapStatus("flaky"), "flaky");
  assert.equal(mapStatus("skipped"), "skipped");
  assert.equal(mapStatus("interrupted"), "skipped");
});

test("resolveConfig requires a suite", () => {
  assert.throws(() => resolveConfig({}, {}), /suite/);
  const c = resolveConfig({ suite: "x" }, {});
  assert.equal(c.suite, "x");
});

test("shouldPush gates on url+token and (CI or force)", () => {
  const base = { url: "u", token: "t" };
  assert.equal(shouldPush(base, { CI: "true" }), true);
  assert.equal(shouldPush(base, {}), false);
  assert.equal(shouldPush(base, { TESTTRACKER_PUSH: "true" }), true);
  assert.equal(shouldPush({ url: "", token: "t" }, { CI: "true" }), false);
});

test("buildPayload computes totals + stable run id", () => {
  const cfg = resolveConfig({ suite: "capwell-api" }, {});
  const results = [
    { full_title: "a", test_file: "a.spec.ts", status: "passed", retries: 0, tags: [] },
    { full_title: "b", test_file: "b.spec.ts", status: "failed", retries: 1, tags: ["smoke"] },
  ];
  const p = buildPayload(results, cfg, { startedAt: "2026-07-24T00:00:00Z", finishedAt: "2026-07-24T00:01:00Z" }, { GITHUB_RUN_ID: "42", GITHUB_RUN_ATTEMPT: "1" });
  assert.equal(p.suite, "capwell-api");
  assert.equal(p.canary_run_id, "42-1");
  assert.equal(p.status, "failed");
  assert.deepEqual(p.totals, { passed: 1, failed: 1, flaky: 0, skipped: 0, total: 2 });
  assert.equal(p.results.length, 2);
});
```

Run (expect fail): `cd npm && npm run build && node --test "scripts/__tests__/testtracker.test.js"`
Commit: `test(reporter): failing spec for testtracker reporter helpers`
Final: `harness validate`

### Task 2: Implement the reporter (make Task 1 green)
**Depends on:** 1 | **Files:** `npm/src/reporters/testtracker.ts` | **Category:** impl
**Skills:** `naming-craft` (reference)

Replace the stub with the full reporter. Exact code:
```ts
import type { Reporter, TestCase, TestResult } from "@playwright/test/reporter";
import crypto from "node:crypto";
import path from "node:path";

// Optional .env load — MUST NOT crash the suite if dotenv is absent.
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require("dotenv").config();
} catch {
  /* dotenv not installed — use ambient env */
}

export interface TestTrackerReporterOptions {
  suite?: string;
  /** Prefix stripped from an absolute test file path. Default: `<cwd>/`. */
  testFilePrefix?: string;
  /** Explicit environment label; else derived from env at push time. */
  environment?: string;
  url?: string;
  token?: string;
  workflow?: string;
}

export interface ResolvedConfig {
  suite: string;
  testFilePrefix: string;
  environment?: string;
  url: string;
  token: string;
  workflow: string;
}

export interface ResultEntry {
  full_title: string;
  test_file: string;
  status: string;
  duration_ms?: number;
  error_message?: string;
  error_stack?: string;
  retries: number;
  tags: string[];
}

export function mapStatus(pw: string): string {
  switch (pw) {
    case "passed": return "passed";
    case "failed":
    case "timedOut": return "failed";
    case "flaky": return "flaky";
    case "skipped":
    case "interrupted": return "skipped";
    default: return "skipped";
  }
}

export function resolveConfig(
  opts: TestTrackerReporterOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): ResolvedConfig {
  const suite = opts.suite ?? env.TESTTRACKER_SUITE;
  if (!suite) throw new Error("TestTrackerReporter: `suite` is required (option or TESTTRACKER_SUITE).");
  return {
    suite,
    testFilePrefix: opts.testFilePrefix ?? env.TESTTRACKER_TEST_FILE_PREFIX ?? `${process.cwd()}/`,
    environment: opts.environment ?? env.TESTTRACKER_ENVIRONMENT,
    url: opts.url ?? env.TESTTRACKER_URL ?? "",
    token: opts.token ?? env.TESTTRACKER_API_TOKEN ?? "",
    workflow: opts.workflow ?? env.TESTTRACKER_WORKFLOW ?? "playwright",
  };
}

export function shouldPush(cfg: Pick<ResolvedConfig, "url" | "token">, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!cfg.url || !cfg.token) return false;
  const isCI = env.CI === "true" || env.GITHUB_ACTIONS === "true";
  const force = env.TESTTRACKER_PUSH === "true";
  return isCI || force;
}

function stableRunId(env: NodeJS.ProcessEnv): string {
  const runId = env.GITHUB_RUN_ID;
  if (runId) return env.GITHUB_RUN_ATTEMPT ? `${runId}-${env.GITHUB_RUN_ATTEMPT}` : runId;
  const sha = env.GITHUB_SHA?.slice(0, 7);
  return (sha ? `${sha}-` : "local-") + crypto.randomUUID();
}

export function buildPayload(
  results: ResultEntry[],
  cfg: ResolvedConfig,
  timing: { startedAt: string; finishedAt: string },
  env: NodeJS.ProcessEnv = process.env,
) {
  const count = (s: string) => results.filter((r) => r.status === s).length;
  const passed = count("passed"), failed = count("failed"), flaky = count("flaky"), skipped = count("skipped");
  const status = failed > 0 ? "failed" : flaky > 0 ? "flaky" : "passed";
  return {
    canary_run_id: stableRunId(env),
    suite: cfg.suite,
    branch: env.GITHUB_REF_NAME ?? "local",
    commit_sha: env.GITHUB_SHA,
    workflow: cfg.workflow,
    environment: cfg.environment,
    status,
    started_at: timing.startedAt,
    finished_at: timing.finishedAt,
    totals: { passed, failed, flaky, skipped, total: results.length },
    results,
  };
}

export default class TestTrackerReporter implements Reporter {
  private results = new Map<string, ResultEntry>();
  private startTime = Date.now();
  private cfg: ResolvedConfig | null = null;

  constructor(private options: TestTrackerReporterOptions = {}) {}

  onBegin() {
    // Resolve config once; a config error here is logged, not thrown, so a
    // misconfigured reporter never aborts the whole run.
    try {
      this.cfg = resolveConfig(this.options);
    } catch (err) {
      console.log(`\nTestTracker: disabled — ${err instanceof Error ? err.message : String(err)}`);
      this.cfg = null;
    }
  }

  onTestEnd(test: TestCase, result: TestResult) {
    if (!this.cfg) return;
    const fullTitle = test.titlePath().filter(Boolean).join(" > ");
    const tags = test.tags.map((t) => t.replace(/^@/, ""));
    this.results.set(fullTitle, {
      full_title: fullTitle,
      test_file: test.location.file.startsWith(this.cfg.testFilePrefix)
        ? test.location.file.slice(this.cfg.testFilePrefix.length)
        : test.location.file,
      status: mapStatus(result.status),
      duration_ms: result.duration,
      error_message: result.errors[0]?.message,
      error_stack: result.errors[0]?.stack,
      retries: result.retry,
      tags,
    });
  }

  async onEnd() {
    if (!this.cfg || !shouldPush(this.cfg)) return;
    const payload = buildPayload(
      [...this.results.values()],
      this.cfg,
      { startedAt: new Date(this.startTime).toISOString(), finishedAt: new Date().toISOString() },
    );
    try {
      const resp = await fetch(`${this.cfg.url}/api/ingest/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.cfg.token}` },
        body: JSON.stringify(payload),
      });
      if (resp.ok) {
        const data = (await resp.json().catch(() => ({}))) as { id?: number; duplicate?: boolean };
        console.log(`\nTestTracker: run ${data.id ?? "?"} ingested${data.duplicate ? " (duplicate)" : ""}.`);
      } else {
        const text = await resp.text().catch(() => "");
        console.log(`\nTestTracker: push failed ${resp.status} — ${text.slice(0, 200)}`);
      }
    } catch (err) {
      console.log(`\nTestTracker: push error — ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
```
Run (expect green): `cd npm && npm run build && node --test "scripts/__tests__/testtracker.test.js"`
Commit: `feat(reporter): config-driven TestTracker ingest reporter`
Final: `harness validate`

### Task 3: Edge-case tests — no-op gating + testFilePrefix strip + error safety
**Depends on:** 2 | **Files:** `npm/scripts/__tests__/testtracker.test.js` (extend) | **Category:** impl

Add tests: (a) `shouldPush` false when url/token missing; (b) `buildPayload` with
`GITHUB_RUN_ID` absent yields a `local-`/`<sha>-` prefixed id; (c) `resolveConfig`
default `testFilePrefix` = `<cwd>/`; (d) a `results` array with `timedOut` counts
as `failed` in totals. (No network — `onEnd`'s fetch is covered by manual verify in Task 15.)
Run: `cd npm && npm run build && node --test "scripts/__tests__/testtracker.test.js"`
Commit: `test(reporter): gating, run-id fallback, and prefix edge cases`
Final: `harness validate`

## Phase 2 — Package wiring

### Task 4: Export the reporter subpath + optional peer dep + files
**Depends on:** 2 | **Files:** `npm/package.json` | **Category:** integration

Add to `npm/package.json`:
```jsonc
"exports": {
  "./reporter": { "types": "./dist/reporters/testtracker.d.ts", "default": "./dist/reporters/testtracker.js" }
},
"files": ["bin/", "dist/", "scripts/install.js"],           // dist/ already covers reporters
"peerDependencies": { "@playwright/test": ">=1.40.0" },
"peerDependenciesMeta": { "@playwright/test": { "optional": true } }
```
Ensure `tsconfig.json` `declaration: true` and that `npm/src/reporters` is in the
compiled rootDir (verify `dist/reporters/testtracker.js` + `.d.ts` emit after build).
Bump `version` (minor: `5.14.0` → `5.15.0`).
Run: `cd npm && npm run build && ls dist/reporters/testtracker.js dist/reporters/testtracker.d.ts && node -e "require('./dist/reporters/testtracker.js')"`
Commit: `feat(pkg): export canary-test-cli/reporter subpath + optional PW peer dep`
Final: `harness validate`

### Task 5: Resolve subpath export against Node + PW config loader
**Depends on:** 4 | **Files:** `npm/scripts/__tests__/exports.test.js` (CREATE) | **Category:** impl

Test that the subpath resolves as consumers will load it:
```js
const test = require("node:test");
const assert = require("node:assert/strict");
test("canary-test-cli/reporter resolves to the built reporter", () => {
  const p = require.resolve("../../dist/reporters/testtracker.js");
  const mod = require(p);
  assert.equal(typeof mod.default, "function"); // the Reporter class
});
```
Run: `cd npm && npm run build && node --test "scripts/__tests__/exports.test.js"`
Commit: `test(pkg): reporter subpath resolves`
Final: `harness validate`

## Phase 3 — Docs

### Task 6: Adoption guide (incl. merge-reports usage)
**Depends on:** 4 | **Files:** `docs/wiki/TestTracker-Reporter.md` (CREATE; adjust path to canary docs convention at execution) | **Category:** integration

Document: playwright.config usage
`reporter: [["canary-test-cli/reporter", { suite: "capwell-api" }]]`; env
(`TESTTRACKER_URL`, `TESTTRACKER_API_TOKEN`, optional `TESTTRACKER_ENVIRONMENT`,
`TESTTRACKER_PUSH=true` for local); the CI-only default; and the sharded pattern:
`npx playwright merge-reports --reporter "canary-test-cli/reporter" ./blob-report`
(push fires once at merge; per-shard runs should NOT include the reporter).
Commit: `docs(reporter): adoption + merge-reports guide`
Final: `harness validate`

### Task 7: Convergence note → canary publish / unified-reporting
**Depends on:** 6 | **Files:** `docs/wiki/TestTracker-Reporter.md` (append), `docs/roadmap.md` (link) | **Category:** integration

Record that this reporter is the INTERIM precursor to `canary publish` (blocked on
Phase 2a `canary report`), the deprecation path, and the per-test-vs-aggregate
mismatch the future command must resolve. Link `unified-reporting.md`.
Commit: `docs(reporter): record interim→canary-publish convergence`
Final: `harness validate`

## Phase 4 — Publish gate (checkpoint)

### Task 8: `[checkpoint:human-action]` Publish or link canary-test-cli 5.15.0
**Depends on:** 4,5 | **Files:** — | **Category:** integration

Downstream repos consume the published package. Either publish `canary-test-cli@5.15.0`
(follow `DEPLOY_CHECKLIST.md`), or for dev, `npm pack` + install the tarball / `npm link`
in each consumer. PAUSE: confirm the version consumers will install.

### Task 9: Open Canary PR
**Depends on:** 3,5,7 | **Files:** — | **Category:** integration

Push branch, open PR (`feat/testtracker-ingest-reporter`), run CI. Link proposal + plan.
Commit: n/a (PR step).

### Task 10: `[checkpoint:human-verify]` Canary PR green + reviewed
**Depends on:** 9 | Pause for review/merge before downstream adoption relies on the published package.

## Phase 5 — Dev TestTracker (checkpoint)

### Task 11: `[checkpoint:human-action]` Create capwell tenant + tt_ token on DEV
**Depends on:** none | **Files:** — | **Category:** integration

On the **dev** TestTracker deployment (URL provided by Bri at execution):
1. `pnpm --filter @test-tracker/api create-tenant --slug capwell --name "Capwell" --profile automation_first` (or admin UI → Tenants).
2. Log in as admin → switch to Capwell → Admin → API tokens → issue token scoped
   `ingest:runs` (name e.g. `capwell-ci`). Copy the `tt_…` secret ONCE.
3. Store `TESTTRACKER_URL` (dev) + `TESTTRACKER_API_TOKEN` as GitHub Actions secrets
   in the Capwell repo (and later optum repos). PAUSE: confirm token stored.

## Phase 6 — Capwell adoption (own worktree)

> At execution: `git -C ../../capwell/capwell worktree add ../capwell-testtracker -b feat/testtracker-reporter origin/main` (verify default branch first). All Capwell edits happen there.

### Task 12: Add reporter to api-contract suite
**Depends on:** 8,11 | **Files:** `apps/api-contract/playwright.config.ts`, `package.json` (bump `canary-test-cli` devDep) | **Category:** impl

Add to the `reporter` array:
`["canary-test-cli/reporter", { suite: "capwell-api", testFilePrefix: `${process.cwd()}/apps/api-contract/tests/` }]`
(keep existing list/html/json reporters). Env from CI secrets. environment derived
from `API_CONTRACT_BASE_URL` (set `TESTTRACKER_ENVIRONMENT` in the workflow if the
default heuristic is insufficient).
Run: `pnpm --filter @capwell/api-contract test:smoke` locally with `TESTTRACKER_PUSH=true` against dev to smoke the push.
Commit: `test(api-contract): push runs to TestTracker via canary-test-cli/reporter`

### Task 13: Add reporter to web-e2e suite (non-sharded jobs)
**Depends on:** 8,11 | **Files:** `apps/web-e2e/playwright.config.ts` | **Category:** impl

Add the reporter with `{ suite: "capwell-web", testFilePrefix: ... }` for the
smoke/functional (non-sharded) invocations. Guard so it does NOT double-push in the
sharded nightly (that pushes at merge — Task 14). Simplest: only include the reporter
when `process.env.PLAYWRIGHT_BLOB_OUTPUT_DIR`/shard is unset, OR always include but
rely on merge-step push for nightly and per-run push for PR (stable run_id makes a
single nightly push authoritative). Document the chosen guard.
Commit: `test(web-e2e): push non-sharded runs to TestTracker`

### Task 14: Wire merge-reports push for the sharded nightly
**Depends on:** 13 | **Files:** `.github/workflows/web-e2e.yml` | **Category:** integration

In the `merge-reports` job, after producing the merged report, run:
`npx playwright merge-reports --reporter "canary-test-cli/reporter" ./blob-report`
with `TESTTRACKER_*` env set and `suite=capwell-web`. This yields exactly one
`capwell-web` run per nightly (truth #6).
Commit: `ci(web-e2e): push merged nightly run to TestTracker`

### Task 15: `[checkpoint:human-verify]` Capwell CI run lands on dev dashboard
**Depends on:** 12,13,14 | Trigger PR + nightly (or dispatch); confirm `capwell-api`
and `capwell-web` runs appear under the Capwell tenant on dev `/automation`.

## Phase 7 — Optum migration (own worktrees)

### Task 16: Migrate optum-testing-api
**Depends on:** 8,10 | **Files (in optum-testing-api worktree):** DELETE `reporters/testtracker-reporter.ts`; MODIFY `playwright.config.ts`, `package.json` (bump `canary-test-cli`) | **Category:** impl

> Worktree: `git -C ../../optum/optum-testing-api worktree add ../optum-testing-api-tt -b feat/testtracker-reporter <default>`.
Replace the file reference with
`["canary-test-cli/reporter", { suite: "optum-api", testFilePrefix: `${process.cwd()}/tests/`, environment: <derive from AUTH_BASE_URL/API_BASE_URL 'ushc'→stage else prod> }]`.
Verify no other import of the deleted file: `grep -rn testtracker-reporter .` → empty.
Run: `TESTTRACKER_PUSH=true pnpm test:smoke` against dev.
Commit: `refactor(reporting): use canary-test-cli/reporter; drop local copy`

### Task 17: Migrate optum-testing-web
**Depends on:** 8,10 | **Files (in optum-testing-web worktree):** DELETE `reporters/testtracker-reporter.ts`; MODIFY `playwright.config.ts`, `package.json` | **Category:** impl

Same as Task 16 with `suite: "optum-web"`, `testFilePrefix: `${process.cwd()}/web/tests/``,
environment `BASE_URL 'uat'→uat else stage`. `grep -rn testtracker-reporter .` → empty.
Commit: `refactor(reporting): use canary-test-cli/reporter; drop local copy`

### Task 18: `[checkpoint:human-verify]` Optum suites still push post-migration
**Depends on:** 16,17 | Confirm `optum-api` + `optum-web` runs still land on the
dashboard from the migrated repos (dev), with correct `test_file` paths + suite names.

---

## Sequencing / parallelism

- **Canary core:** 1→2→3; 2→4→5; 4→6→7. 8 needs 4,5. 9 needs 3,5,7. 10 needs 9.
- **11 (dev tenant/token)** is independent — can start any time.
- **Capwell (12–15)** needs 8 (published/linked pkg) + 11 (token). 12 ∥ 13; 14 needs 13; 15 needs 12–14.
- **Optum (16,17)** needs 8 + 10 (merged/reviewed pkg); 16 ∥ 17; 18 needs both.
- Capwell and optum phases are independent → parallelizable across their worktrees.

## Known-failure check
- Stale `.js` shadowing (`project_stale_js_shadowing`): after editing TS, rebuild `dist/`; delete stray compiled `.js` if edits "don't take effect."
- Shared-DB integration flakiness in TestTracker (#61) is unrelated to this reporter work.
