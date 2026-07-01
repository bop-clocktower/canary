---
project: canary
version: 1
created: 2026-07-01
---

# API Delta Contract (`api-delta.json` v1)

> The machine-readable artifact emitted by
> `canary guardian analyze --emit-diff <path>`. It captures the OpenAPI diff
> between two SUT specs in a stable, tool-consumable shape. Downstream
> automation (test generators, library-stub regenerators) reads this instead of
> re-diffing the specs.

## Shape

```json
{
  "schema_version": 1,
  "sut": { "sha": "abc1234", "suite": "api" },
  "generated": "2026-07-01T00:00:00Z",
  "summary": { "added": 1, "removed": 0, "changed": 1, "total": 2 },
  "endpoints": {
    "added": [{ "method": "POST", "path": "/orders/{id}/submit" }],
    "removed": [],
    "changed": [
      { "method": "GET", "path": "/orders", "changes": ["params", "response"] }
    ]
  }
}
```

## Fields

| Field                             | Type     | Notes                                                     |
| --------------------------------- | -------- | --------------------------------------------------------- |
| `schema_version`                  | int      | `1`. Bumped only on a breaking change; evolve additively. |
| `sut.sha`                         | string   | Commit SHA analyzed (or `"unknown"`).                     |
| `sut.suite`                       | string   | Suite name passed via `--suite` (e.g. `api`).             |
| `generated`                       | string   | ISO-8601 UTC timestamp of emission.                       |
| `summary.{added,removed,changed}` | int      | Counts per bucket.                                        |
| `summary.total`                   | int      | `added + removed + changed`. **`0` means "no change".**   |
| `endpoints.added[]`               | object[] | `{ method, path }`.                                       |
| `endpoints.removed[]`             | object[] | `{ method, path }`.                                       |
| `endpoints.changed[]`             | object[] | `{ method, path, changes[] }`.                            |

## Conventions (frozen)

- **`method`** is upper-case (`GET`, `POST`, …).
- **`path`** is the OpenAPI path template verbatim, braces preserved
  (`/orders/{id}/submit`). Consumers rely on this being stable for idempotent
  regeneration.
- **`changes[]`** on a changed endpoint is drawn from a fixed vocabulary and
  lists **every** category that differs (an endpoint may change in several ways
  at once):

  | Value          | Meaning                                            |
  | -------------- | -------------------------------------------------- |
  | `params`       | `parameters` (query/path/header) differ.           |
  | `request-body` | `requestBody` differs.                             |
  | `response`     | Schema of an existing response code differs.       |
  | `auth`         | `security` requirements differ.                    |
  | `status-codes` | The set of response codes changed (added/removed). |

  An operation whose only delta is non-contract (summary/description/tags) has
  an empty `changes[]` but still appears under `changed`.

## Consumers

The artifact is generic — it names only HTTP methods, paths, and change
categories, with no project-, employer-, or client-specific content. Downstream
overlays and skills consume it to decide whether and what to regenerate; the
`summary.total == 0` signal is the canonical "nothing to do" gate.
