---
project: canary
version: 1
created: 2026-10-05
---

# Site Feed Contract (canary.site/1)

> The single static feed a QA site page loads: declared scopes and suites,
> recent [canary.run/1](canary-run-contract.md) records, distinct flaky tests,
> the latest [canary.assessment/1](canary-assessment-contract.md) per identity
> key, and a register of skipped or removed tests. It is the composed layer of
> the canary QA data contract ([#1151]). A producer builds it; a page only reads
> it.
>
> Validate a file against this contract with
> `node agents/skills/lib/contracts/validate.mjs --layer site <file>`.

## Shape

```json
{
  "contract": "canary.site/1",
  "generated_at": "2026-10-05T15:00:00Z",
  "scopes": [{ "id": "canary", "env": "ci" }],
  "suites": [
    { "scope": { "id": "canary", "env": "ci" }, "suite": "ts-engine" }
  ],
  "runs": [
    {
      "contract": "canary.run/1",
      "scope": { "id": "canary", "env": "ci" },
      "producer": {
        "name": "canary-starling",
        "version": "0.1.0",
        "channel": "ci"
      },
      "run": {
        "id": "9001-1",
        "suite": "ts-engine",
        "branch": "main",
        "commit_sha": "a8be94e6",
        "started_at": "2026-10-04T10:00:00Z",
        "finished_at": "2026-10-04T10:04:00Z",
        "ci_url": null,
        "status": "passed",
        "shard": null
      },
      "totals": {
        "passed": 2,
        "failed": 0,
        "flaky": 0,
        "skipped": 0,
        "timed_out": 0,
        "interrupted": 0,
        "total": 2
      },
      "results": null,
      "collected": null
    },
    {
      "contract": "canary.run/1",
      "scope": { "id": "canary", "env": "ci" },
      "producer": {
        "name": "canary-starling",
        "version": "0.1.0",
        "channel": "ci"
      },
      "run": {
        "id": "9002-1",
        "suite": "ts-engine",
        "branch": "main",
        "commit_sha": "0ba2dd68",
        "started_at": "2026-10-05T10:00:00Z",
        "finished_at": "2026-10-05T10:04:00Z",
        "ci_url": null,
        "status": "passed",
        "shard": null
      },
      "totals": {
        "passed": 1,
        "failed": 0,
        "flaky": 0,
        "skipped": 0,
        "timed_out": 0,
        "interrupted": 0,
        "total": 1
      },
      "results": [
        {
          "title": "history > trims to the newest runs",
          "file": "ts/test/history-trim-windows.test.ts",
          "status": "passed",
          "duration_ms": 412,
          "retries": 0,
          "area": null,
          "tags": [],
          "error": null
        }
      ],
      "collected": null
    }
  ],
  "flaky": [
    {
      "scope": { "id": "canary", "env": "ci" },
      "suite": "ts-engine",
      "title": "history > trims to the newest runs",
      "file": "ts/test/history-trim-windows.test.ts",
      "flaky_runs": 3,
      "window_runs": 30
    }
  ],
  "assessments": [
    {
      "contract": "canary.assessment/1",
      "scope": { "id": "canary", "env": "ci" },
      "source": "canary.ci-ready",
      "metric": "flakiness",
      "status": "healthy",
      "value": 0.012,
      "unit": "ratio",
      "reason": null,
      "evidence": { "tier": "heuristic", "denominator": 412 },
      "observed_at": "2026-10-05T14:10:00Z",
      "sources": ["history-v2.jsonl@0ba2dd68"],
      "verified_by": null,
      "verified_at": null
    }
  ],
  "register": [
    {
      "scope": { "id": "canary", "env": "ci" },
      "title": "legacy > old login flow",
      "file": "tests/legacy.spec.ts",
      "kind": "skipped",
      "reason": "chore: quarantine the legacy login flow",
      "recorded_at": "2026-09-30T12:00:00Z",
      "commit": "0ba2dd68",
      "cause": "obsolete",
      "issue": null
    }
  ]
}
```

The machine-readable contract is
[site.v1.schema.json](../../agents/skills/lib/contracts/site.v1.schema.json);
the document above is the executable fixture
[site.valid.json](../../agents/skills/test/fixtures/contracts/site.valid.json).

## Fields

Every top-level field is **required**.

| Field          | Type                    | Nullable | Notes                                                                                                                                                                                                                       |
| -------------- | ----------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `contract`     | string                  | no       | Exactly `canary.site/1`.                                                                                                                                                                                                    |
| `generated_at` | string                  | no       | ISO 8601 date-time with an offset. When the producer built the feed.                                                                                                                                                        |
| `scopes`       | `{id, env}[]`           | no       | The scopes the feed covers.                                                                                                                                                                                                 |
| `suites`       | `{scope, suite}[]`      | yes      | The **declared** expected suites (D12). `null` = none declared, which is not the same as `[]`; without a declaration a page cannot say a suite was never reported.                                                          |
| `runs`         | `canary.run/1[]`        | no       | The last 30 runs per suite (D15), counted as logical runs: a run's shard records are one run. Per-test `results` are carried only on the shards of each suite's latest run; older runs carry `results: null` (not carried). |
| `flaky`        | object[]                | no       | One row per **distinct** flaky test over the history window (D13): `scope`, `suite`, `title`, `file`, `flaky_runs` and `window_runs`, both integers `>= 1`.                                                                 |
| `assessments`  | `canary.assessment/1[]` | no       | The latest assessment per identity key (`scope.id + scope.env + source + metric`).                                                                                                                                          |
| `register`     | object[]                | no       | Skipped or removed tests as visible debt. See the register mapping below.                                                                                                                                                   |

Every nested record is validated against its own layer's schema and rules: a run
inside `runs[]` is a full `canary.run/1` record, and errors name it by position
(`runs[1].totals.total`, `assessments[0].verified`).

## Every scope is `{id, env}`

Every `scope` in the feed, on `scopes[]`, `suites[]`, `runs[]`, `flaky[]`,
`assessments[]` and `register[]`, is the full `{id, env}` object (D2). A bare
string such as `"scope": "canary"` is refused with the path of the field, for
example `suites[0].scope`. Implicit scope is how a handoff once resolved to the
wrong tenant.

## The register

A register row mirrors a `canary-katana` ledger row. Every field below is
required; `cause` and `issue` are `string | null`, where the ledger writes an
empty string. "Age" is not stored: a page derives it from `recorded_at`.

| Ledger column | Register field | Notes                                                       |
| ------------- | -------------- | ----------------------------------------------------------- |
| (scope)       | `scope`        | `{id, env}`; the ledger is per repo, the feed is per scope. |
| `test`        | `title`        | Non-empty.                                                  |
| `file`        | `file`         | Non-empty and repo-relative.                                |
| `kind`        | `kind`         | Non-empty, e.g. `skipped` or `removed`.                     |
| `reason`      | `reason`       | Non-empty: the subject of the commit that made the change.  |
| `date`        | `recorded_at`  | ISO 8601 date-time with an offset.                          |
| `commit`      | `commit`       | Non-empty.                                                  |
| `cause`       | `cause`        | Non-empty or `null`.                                        |
| `issue`       | `issue`        | Non-empty or `null`.                                        |
| `author`      | not carried    | Refused if supplied (rule `register-no-author`).            |

**A register row carries no author field.** The ledger records who made each
change; the register row defines no field for it. Because unknown fields are
otherwise tolerated (D3), rule **`register-no-author`** refuses a `who` or
`author` key on any register row, even with a `null` value. That is the whole of
the enforcement: the validator does not inspect free-text values, so a producer
remains responsible for keeping personal identity out of every other field (a
commit subject in `reason`, a `verified_by` on a nested assessment, which should
name a role or handle, never an email address). The ledger's `marker` and
`expiry` columns are not carried in v1.

## Conventions (frozen)

- **Version (D3)** and **scope (D2)** follow
  [canary.run/1](canary-run-contract.md#conventions-frozen).
- **Abstention is a value (D4).** `suites: null` (none declared) is not
  `suites: []` (declared, and empty); `results: null` on an older run is not
  `results: []`.
- **Nested rules apply in place.** The run rules (`counts-safe`,
  `totals-match-results`, `totals-sum`, `real-dates`, `repo-relative`,
  `non-blank`) and the assessment rules (`status-shape`, `verified-derived`,
  `verification-pair`, `real-dates`, `non-blank`) apply to every nested record,
  with the record's position as the path prefix.
- **Rule `register-no-author`.** A register row carrying a `who` or `author` key
  is refused, whatever its value.
- **Rule `real-dates`.** `generated_at` and every register row's `recorded_at`
  name a real instant, as in the run contract.
- **Rule `repo-relative`.** Every `flaky[].file` and `register[].file` is
  repo-relative, as in the run contract.

## Deferred to phase 2

These cross-record invariants are not enforced in v1. Adding a rule after a
release refuses documents that used to pass, so each one **must land before the
first npm release that carries `canary.site/1`**:

- every run's `scope` is listed in `scopes[]`;
- each suite's latest run carries its `results` (not `null`);
- `flaky_runs <= window_runs` on every `flaky[]` row.

## Validating

```bash
node agents/skills/lib/contracts/validate.mjs --layer site site.json
```

Exit codes, error shape and `--json` output are the same as for
[canary.run/1](canary-run-contract.md#validating). For a site feed, `checked`
counts the feed plus its nested runs, assessments, flaky rows and register rows:
the fixture above reports `1 + 2 + 1 + 1 + 1 = 6`. `scopes[]` and `suites[]`
entries are keys that records refer to, not records, so they are not counted.
Refusing a feed with zero runs is the deploy workflow's job (D14), not the
validator's.

## Consumers

None yet. Phase 2 adds `canary-starling`, which builds the feed from canary's
history, and later phases add the site that renders it.

The format is generic: it names scopes, suites, test titles, repo-relative files
and counts, with no project-, employer- or client-specific content.

[#1151]: https://github.com/bop-clocktower/canary/issues/1151
