---
project: canary
version: 1
created: 2026-10-05
---

# Run Contract (canary.run/1)

> One record per test run, or per shard of a sharded run, carrying the run's
> identity, its totals and (optionally) its per-test results. It is the
> producer-side contract for the TestTracker ingest reporter ([#603]) and the
> run layer of the canary QA data contract ([#1151]); the field names align with
> the ingest payload the reporter already sends rather than inventing a new
> envelope.
>
> Validate a file against this contract with
> `node agents/skills/lib/contracts/validate.mjs --layer run <file>`.

## Shape

```json
{
  "contract": "canary.run/1",
  "scope": { "id": "example-web", "env": "staging" },
  "producer": {
    "name": "canary-test-cli/reporter",
    "version": "8.1.0",
    "channel": "ci"
  },
  "run": {
    "id": "123456-1-s2of4",
    "suite": "web-e2e",
    "branch": "main",
    "commit_sha": "0ba2dd6818ee23df211f799ce714cb92983f65b1",
    "started_at": "2026-10-05T14:00:00Z",
    "finished_at": "2026-10-05T14:06:30Z",
    "ci_url": null,
    "status": "passed",
    "shard": { "index": 2, "total": 4 }
  },
  "totals": {
    "passed": 1,
    "failed": 0,
    "flaky": 1,
    "skipped": 0,
    "timed_out": 0,
    "interrupted": 0,
    "total": 2
  },
  "results": [
    {
      "title": "checkout > pays with a saved card",
      "file": "tests/checkout.spec.ts",
      "status": "passed",
      "duration_ms": 1840,
      "retries": 0,
      "area": "checkout",
      "tags": ["@smoke"],
      "error": null
    },
    {
      "title": "search > filters by price",
      "file": "tests/search.spec.ts",
      "status": "flaky",
      "duration_ms": 2210,
      "retries": 1,
      "area": null,
      "tags": [],
      "error": {
        "message": "expect(locator).toBeVisible() failed",
        "stack": null
      }
    }
  ],
  "collected": [
    {
      "title": "checkout > pays with a saved card",
      "file": "tests/checkout.spec.ts"
    },
    { "title": "search > filters by price", "file": "tests/search.spec.ts" }
  ]
}
```

The machine-readable contract is
[run.v1.schema.json](../../agents/skills/lib/contracts/run.v1.schema.json); the
document above is the executable fixture
[run.valid.json](../../agents/skills/test/fixtures/contracts/run.valid.json).

## Fields

Every field is **required**. "Nullable" means the key must be present and may be
`null`; it never means the key may be omitted.

| Field                   | Type     | Nullable | Notes                                                                                     |
| ----------------------- | -------- | -------- | ----------------------------------------------------------------------------------------- |
| `contract`              | string   | no       | Exactly `canary.run/1`. See the version rule below.                                       |
| `scope`                 | object   | no       | `{id, env}`; explicit, never inferred (D2).                                               |
| `scope.id`              | string   | no       | Non-empty. The project or product the run belongs to.                                     |
| `scope.env`             | string   | no       | Non-empty and opaque: canary never interprets it.                                         |
| `producer.name`         | string   | no       | Non-empty. What emitted the record.                                                       |
| `producer.version`      | string   | no       | Non-empty. The producer's own version.                                                    |
| `producer.channel`      | string   | no       | Non-empty, e.g. `ci` or `local`.                                                          |
| `run.id`                | string   | no       | Non-empty. Unique per run, and per shard of a sharded run.                                |
| `run.suite`             | string   | no       | Non-empty suite name.                                                                     |
| `run.branch`            | string   | yes      | Non-empty when set; `null` = unknown.                                                     |
| `run.commit_sha`        | string   | yes      | 7-64 lowercase hex characters; `null` = unknown.                                          |
| `run.started_at`        | string   | no       | ISO 8601 date-time with a `Z` or `±hh:mm` offset.                                         |
| `run.finished_at`       | string   | no       | Same format as `started_at`.                                                              |
| `run.ci_url`            | string   | yes      | `http://` or `https://` URL; `null` = not run in CI, or unknown.                          |
| `run.status`            | enum     | no       | `passed`, `failed` or `cancelled`. See the status vocabulary.                             |
| `run.shard`             | object   | yes      | `{index, total}`, both integers `>= 1`; `null` = not sharded.                             |
| `totals.passed`         | integer  | no       | `>= 0`.                                                                                   |
| `totals.failed`         | integer  | no       | `>= 0`.                                                                                   |
| `totals.flaky`          | integer  | no       | `>= 0`. Tests that failed and then passed on retry.                                       |
| `totals.skipped`        | integer  | no       | `>= 0`.                                                                                   |
| `totals.timed_out`      | integer  | no       | `>= 0`.                                                                                   |
| `totals.interrupted`    | integer  | no       | `>= 0`.                                                                                   |
| `totals.total`          | integer  | no       | `>= 0`. Equals the sum of the six counts (rule `totals-sum`).                             |
| `results`               | array    | yes      | The per-test results. `null` = not carried in this record; `[]` = zero tests (D4).        |
| `results[].title`       | string   | no       | Non-empty full test title; half of the join key (ADR 0029).                               |
| `results[].file`        | string   | no       | Non-empty, repo-relative: never absolute, never a drive letter (ADR 0029).                |
| `results[].status`      | enum     | no       | One of the six result statuses below.                                                     |
| `results[].duration_ms` | integer  | no       | `>= 0`.                                                                                   |
| `results[].retries`     | integer  | no       | `>= 0`.                                                                                   |
| `results[].area`        | string   | yes      | Non-empty when set; `null` = no area assigned.                                            |
| `results[].tags`        | string[] | no       | Each tag non-empty; `[]` = no tags.                                                       |
| `results[].error`       | object   | yes      | `{message, stack}`; `message` is a string, `stack` a string or `null`. `null` = no error. |
| `collected`             | array    | yes      | The full collected test list ([#1150]). `null` = not reported; `[]` = none collected.     |
| `collected[].title`     | string   | no       | Non-empty; same join key as `results[].title`.                                            |
| `collected[].file`      | string   | no       | Non-empty and repo-relative, as `results[].file`.                                         |

## Conventions (frozen)

- **Version (D3).** `contract` is `canary.<layer>/<major>`. A reader refuses an
  unknown major version and a record with no `contract` at all. A minor revision
  only adds optional fields, so a reader **tolerates unknown fields** rather
  than refusing them.
- **Scope (D2).** Every record carries an explicit `scope: {id, env}`. `env` is
  opaque. Nothing is inferred from a session, a token or "last active" state.
- **Abstention is a value (D4).** `results: null` means the per-test results are
  not carried in this record; `results: []` means the run had zero tests.
  `collected: null` means the producer did not report a collected list;
  `collected: []` means nothing was collected. `null` is never `0`.
- **Rule `totals-match-results`** (criterion 4). When `results` is an array, its
  length equals `totals.total`. The rule does not apply when `results` is
  `null`.
- **Rule `totals-sum`.**
  `passed + failed + flaky + skipped + timed_out + interrupted` equals
  `totals.total`.
- **Rule `counts-safe`.** Every `totals` count, `results[].duration_ms` and
  `results[].retries` is at most `2^53 - 1` (9007199254740991). A larger JSON
  integer is not the number the producer wrote once parsed, so `totals-sum`
  could not check it honestly.
- **Rule `real-dates`.** `run.started_at` and `run.finished_at` name a real
  instant. The timestamp pattern admits month 13 or hour 25, which a reader
  parses as NaN and then sorts as the newest run; such a record is refused.
- **`file` is repo-relative** (ADR 0029). `title` plus `file` is the join key
  between `results[]`, `collected[]` and other canary records.

## Status vocabulary

| Level  | Values                                                             |
| ------ | ------------------------------------------------------------------ |
| Run    | `passed`, `failed`, `cancelled`                                    |
| Result | `passed`, `failed`, `flaky`, `skipped`, `timed_out`, `interrupted` |

There is no run-level `flaky`. A run whose only non-passes are recovered flakes
is `passed`, and its flakiness is carried in `totals.flaky`. "Did the run pass"
and "was it clean" are separate questions, and the totals already answer the
second.

## Alignment with the TestTracker ingest payload

`canary.run/1` maps field for field onto the `IngestPayload` that
`npm/src/reporters/ingest.ts` sends today (D1). **The existing ingest payload is
unchanged by this contract**; the reporter emits `canary.run/1` alongside it in
phase 2. [#1148], [#1149] and [#1150] were fixed in the ingest payload itself,
so those rows already line up.

| Ingest payload today                                                  | `canary.run/1`                                      |
| --------------------------------------------------------------------- | --------------------------------------------------- |
| `canary_run_id`, shard-suffixed `-s2of4` ([#1148])                    | `run.id`, same form                                 |
| `status: flaky`                                                       | `run.status: passed` with `totals.flaky > 0`        |
| Playwright run `interrupted` (sent as `cancelled`)                    | `run.status: cancelled`                             |
| Playwright run `timedout` (sent as `failed`)                          | `run.status: cancelled`: the run did not complete   |
| `mapStatus`: `timedOut` → `timed_out` ([#1149])                       | `results[].status: timed_out`                       |
| `interrupted` → `failed` + an error prefixed `interrupted:` ([#1149]) | `results[].status: interrupted`                     |
| `results[].full_title`                                                | `results[].title`                                   |
| `results[].test_file`                                                 | `results[].file`                                    |
| `results[].error_message` / `results[].error_stack`                   | `results[].error.message` / `results[].error.stack` |
| `results[].area`, omitted when unmapped                               | `results[].area`, `null` when unmapped              |
| `collected` omitted / `[]` / list ([#1150])                           | `collected: null` / `[]` / list                     |

## Validating

```bash
node agents/skills/lib/contracts/validate.mjs --layer run run.json
node agents/skills/lib/contracts/validate.mjs --json - < run.json
```

The validator has no dependencies, so it runs from the shipped skills tree with
nothing installed. Omit the file, or pass `-`, to read stdin. Without `--layer`,
the layer is read from the document's own `contract` field; with it, a document
of any other layer is refused.

| Exit | Meaning                                                                           |
| ---- | --------------------------------------------------------------------------------- |
| `0`  | Valid.                                                                            |
| `1`  | Refused: the document is invalid, or the input is not parseable JSON.             |
| `2`  | Usage error (unknown flag, bad `--layer`, two files) or unreadable file or stdin. |

Unparseable or empty input is a refusal (exit 1), never a pass. Each error is
`{path, message}`. `path` is dotted with bracketed indexes (`scope.env`,
`results[0].file`) and the document root is `$`. Text output prints one
`path: message` line per error on stderr. `--json` prints
`{valid, contract, checked, errors}` on stdout, where `checked` is the number of
records validated: 1 for a run document, and 0 when the input did not parse.

## Consumers

None yet. Phase 2 adds the reporter's `canary.run/1` emission and the
`canary-starling` producer; the site feed
([canary-site-feed-contract.md](canary-site-feed-contract.md)) embeds run
records.

The format is generic: it names suites, test titles, repo-relative files and
counts, with no project-, employer- or client-specific content.

[#603]: https://github.com/bop-clocktower/canary/issues/603
[#1148]: https://github.com/bop-clocktower/canary/issues/1148
[#1149]: https://github.com/bop-clocktower/canary/issues/1149
[#1150]: https://github.com/bop-clocktower/canary/issues/1150
[#1151]: https://github.com/bop-clocktower/canary/issues/1151
