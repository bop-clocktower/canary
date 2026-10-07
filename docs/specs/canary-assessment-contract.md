---
project: canary
version: 1
created: 2026-10-05
---

# Assessment Contract (canary.assessment/1)

> One assessed metric per record: a health check, a readiness signal or a plain
> measurement, scoped to one project and environment. It is the assessment layer
> of the canary QA data contract ([#1151]). Records are append-only; a reader
> takes the latest record per identity key.
>
> Validate a file against this contract with
> `node agents/skills/lib/contracts/validate.mjs --layer assessment <file>`.

## Shape

```json
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
```

The machine-readable contract is
[assessment.v1.schema.json](../../agents/skills/lib/contracts/assessment.v1.schema.json);
the document above is the executable fixture
[assessment.valid.json](../../agents/skills/test/fixtures/contracts/assessment.valid.json).

## Fields

Every field is **required**. "Nullable" means the key must be present and may be
`null`; it never means the key may be omitted.

| Field                  | Type              | Nullable | Notes                                                                                                                                                                                |
| ---------------------- | ----------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `contract`             | string            | no       | Exactly `canary.assessment/1`.                                                                                                                                                       |
| `scope`                | object            | no       | `{id, env}`; explicit, never inferred (D2).                                                                                                                                          |
| `scope.id`             | string            | no       | Non-empty.                                                                                                                                                                           |
| `scope.env`            | string            | no       | Non-empty and opaque.                                                                                                                                                                |
| `source`               | string            | no       | Non-empty. What produced the assessment, e.g. `canary.ci-ready`.                                                                                                                     |
| `metric`               | string            | no       | Non-empty metric name.                                                                                                                                                               |
| `status`               | enum              | no       | One of the five statuses below.                                                                                                                                                      |
| `value`                | number or boolean | yes      | A finite number, or a boolean for a pass/fail check. No strings. `null` only for `not-assessed`.                                                                                     |
| `unit`                 | string            | yes      | Non-empty when set, e.g. `ratio` or `ms`; `null` = unitless.                                                                                                                         |
| `reason`               | string            | yes      | Required, and non-blank, only for `not-assessed`; `null` for every other status.                                                                                                     |
| `evidence.tier`        | enum              | yes      | `coverage-verified`, `graph-verified` or `heuristic`; `null` = no evidence tier applies.                                                                                             |
| `evidence.denominator` | integer           | yes      | `>= 0`. How many items the assessment measured; `null` = not applicable.                                                                                                             |
| `observed_at`          | string            | no       | ISO 8601 date-time with an offset. When the check ran, not when it was stored.                                                                                                       |
| `sources`              | string[]          | no       | Each non-empty. The inputs the assessment read; `[]` = none recorded.                                                                                                                |
| `verified_by`          | string            | yes      | Non-empty when set. A role or handle that verified the record; do not put an email address in a feed that may be public. Set together with `verified_at` (rule `verification-pair`). |
| `verified_at`          | string            | yes      | ISO 8601 date-time with an offset; set together with `verified_by`.                                                                                                                  |

There is **no `verified` field**. Whether a record is verified is derived from
`verified_by` and `verified_at`, and a producer that supplies `verified` is
refused (rule `verified-derived`).

## Status vocabulary

| Status         | Meaning                                                                 | `value`  | `reason`  |
| -------------- | ----------------------------------------------------------------------- | -------- | --------- |
| `healthy`      | Assessed against a threshold and within it.                             | non-null | `null`    |
| `degraded`     | Assessed against a threshold and outside its healthy band.              | non-null | `null`    |
| `critical`     | Assessed against a threshold and outside its acceptable band.           | non-null | `null`    |
| `observed`     | A measured value with no threshold judgment.                            | non-null | `null`    |
| `not-assessed` | The producer abstained: it could not measure this metric, and says why. | `null`   | non-blank |

## Conventions (frozen)

- **Append-only, latest per key.** The identity key is
  `scope.id + scope.env + source + metric`. A producer never edits a record; it
  appends a new one, and a reader takes the latest per key by `observed_at`.
- **`observed_at` is when the check ran**, not when the record was stored or
  shipped.
- **No composite.** There is no overall score that folds several metrics into
  one number (D6); how a page summarizes several assessments is decided by a
  later phase's ADR.
- **Version (D3)** and **scope (D2)** follow the same rules as
  [canary.run/1](canary-run-contract.md#conventions-frozen): an unknown major is
  refused, unknown fields are tolerated, and every record names its scope.
- **Rule `status-shape`** (criterion 2). `not-assessed` requires `value: null`
  and a non-blank `reason`. Every other status requires a non-null `value`
  (`number | boolean`) and `reason: null`. Both directions are enforced, so an
  abstention can never hide inside a `healthy` record, and `"N/A"` cannot stand
  in for a value.
- **Rule `verified-derived`** (criterion 3). A supplied `verified` key is
  refused, whatever its value: `true`, `false` and `null` are all refused,
  because key presence is the assertion.
- **Rule `real-dates`.** `observed_at` and `verified_at`, when strings, name a
  real instant (see the run contract).
- **Rule `non-blank`.** `unit`, `reason`, `verified_by` and every other string
  the schema gives `minLength: 1` must hold a non-whitespace character (see the
  run contract). A blank `reason` on `not-assessed` is reported twice, by
  `non-blank` and by `status-shape`.
- **Rule `verification-pair`** (criterion 17). `verified_by` and `verified_at`
  are both set or both `null`. A record that sets only one is refused, and the
  error names the half that is missing.

## Validating

```bash
node agents/skills/lib/contracts/validate.mjs --layer assessment assessment.json
```

Exit codes, error shape and `--json` output are the same as for
[canary.run/1](canary-run-contract.md#validating): `0` valid, `1` refused
(including unparseable input), `2` usage error or unreadable file or stdin. Each
error is `{path, message}` with the document root as `$`.

## Consumers

None yet. Phase 2 adds the first producers; the `canary.site/1` feed
([canary-site-feed-contract.md](canary-site-feed-contract.md)) carries the
latest assessment per identity key.

The format is generic: it names metrics, statuses and counts, with no project-,
employer- or client-specific content.

[#1151]: https://github.com/bop-clocktower/canary/issues/1151
