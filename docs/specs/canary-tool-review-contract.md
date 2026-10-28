---
project: canary
version: 1
created: 2026-10-28
---

# Tool Review Contract (canary.tool-review/1)

> One review of a QA tool — a test tracker, a test-case manager, a results
> dashboard — from the seats of the people who use it. The report says how much
> of the tool it examined before it says anything about what the tool got wrong:
> every job and every result surface ends in exactly one ledger state.
> `canary-blackalice` produces it ([#1524]; [ADR 0045][adr-0045]).
>
> This is a **standalone contract**, not a layer of the canary QA data contract.
> Validate a report with `validateToolReview` from
> [`tool-review.mjs`](../../agents/skills/lib/contracts/tool-review.mjs), not
> with `validate.mjs`.

## Shape

```json
{
  "contract": "canary.tool-review/1",
  "tool": {
    "name": "example-tracker",
    "commit_sha": "0123456789abcdef0123456789abcdef01234567",
    "url": "https://staging.example.test"
  },
  "reviewed_at": "2026-10-28T14:00:00Z",
  "catalog_version": "jobs.v1",
  "overlay_sha": "89abcdef0123456789abcdef0123456789abcdef",
  "ledger": [
    {
      "id": "report.read-release-status-at-a-glance",
      "kind": "job",
      "state": "walked",
      "reason": null,
      "evidence": [{ "kind": "snapshot", "ref": "snapshots/release-status.md" }]
    },
    {
      "id": "triage.find-when-it-started-failing",
      "kind": "job",
      "state": "mapped",
      "reason": null,
      "evidence": [{ "kind": "file", "ref": "src/routes/history.ts:42" }]
    },
    {
      "id": "report.see-only-my-results",
      "kind": "job",
      "state": "not-assessed",
      "reason": "no external-viewer account in the seed data",
      "evidence": []
    },
    {
      "id": "plan.import-from-external-tracker",
      "kind": "job",
      "state": "not-applicable",
      "reason": "the tool has no external tracker",
      "evidence": []
    },
    {
      "id": "/dashboard",
      "kind": "surface",
      "state": "walked",
      "reason": null,
      "evidence": [{ "kind": "screenshot", "ref": "screenshots/dashboard.png" }]
    }
  ],
  "findings": [
    {
      "id": "f-001",
      "severity": "blocker",
      "persona": "pm-owner",
      "job": null,
      "quality": "Q2",
      "surface": "/dashboard",
      "what_happened": "A suite with no runs this week shows a green tick",
      "cost": "A PM reads 'all good' for a suite nobody ran",
      "evidence": [
        { "kind": "screenshot", "ref": "screenshots/dashboard.png" }
      ],
      "file_candidate": true
    },
    {
      "id": "f-002",
      "severity": "friction",
      "persona": "developer",
      "job": "triage.find-when-it-started-failing",
      "quality": "Q4",
      "surface": null,
      "what_happened": "A result links to its run but not to its build or its previous result",
      "cost": "A developer cannot tell when a test started failing without opening every older run",
      "evidence": [{ "kind": "file", "ref": "src/routes/history.ts:42" }],
      "file_candidate": false
    }
  ],
  "not_assessed": []
}
```

The machine-readable contract is
[tool-review.v1.schema.json](../../agents/skills/lib/contracts/tool-review.v1.schema.json);
the document above is the executable fixture
[tool-review.valid.json](../../agents/skills/test/fixtures/contracts/tool-review.valid.json).

## Fields

Every field is **required**. "Nullable" means the key must be present and may be
`null`; it never means the key may be omitted.

| Field             | Type             | Nullable | Notes                                                                                    |
| ----------------- | ---------------- | -------- | ---------------------------------------------------------------------------------------- |
| `contract`        | string           | no       | Exactly `canary.tool-review/1`.                                                          |
| `tool.name`       | string           | no       | Non-empty. The reviewed tool.                                                            |
| `tool.commit_sha` | string           | no       | Non-empty. The revision reviewed; for a hosted tool, the deployed version.               |
| `tool.url`        | string           | no       | Non-empty. Where the review reached the tool.                                            |
| `reviewed_at`     | string           | no       | Timestamp with a zone, the run contract's pattern.                                       |
| `catalog_version` | string           | no       | The generic job catalog the review used, e.g. `jobs.v1`.                                 |
| `overlay_sha`     | string           | yes      | Content hash of the tool overlay; `null` when the review ran without one.                |
| `ledger`          | array            | no       | One row per merged job and per result surface. See [Ledger](#ledger).                    |
| `findings`        | array            | no       | `[]` = no findings. See [Findings](#findings).                                           |
| `not_assessed`    | array of strings | no       | Run-level abstentions; `[]` = none. See [Run-level abstentions](#run-level-abstentions). |

## Ledger

A row is `{id, kind, state, reason, evidence}`: `kind` is `job` or `surface`,
`reason` is a non-blank string or `null`, and `evidence` is a list of
`{kind, ref}` with `kind` one of `screenshot`, `snapshot`, `file`.

| State            | Meaning                        | The producer must supply  |
| ---------------- | ------------------------------ | ------------------------- |
| `walked`         | Driven live in the browser     | ≥1 snapshot or screenshot |
| `mapped`         | Judged from code and docs only | ≥1 `file:line`            |
| `not-assessed`   | Not examined this run          | a reason                  |
| `not-applicable` | Disabled by the tool overlay   | the overlay's reason      |

`pending` is a state of the ledger file a review works in, never of a report:
the schema refuses it.

## Findings

| Field            | Type    | Nullable | Notes                                                                                |
| ---------------- | ------- | -------- | ------------------------------------------------------------------------------------ |
| `id`             | string  | no       | Non-empty, unique within the report, e.g. `f-003`.                                   |
| `severity`       | enum    | no       | `blocker`, `friction` or `polish`.                                                   |
| `persona`        | enum    | no       | `manual-tester`, `sdet`, `qa-lead`, `developer`, `pm-owner` or `external-viewer`.    |
| `job`            | string  | yes      | The catalog job id the finding is about.                                             |
| `quality`        | enum    | yes      | `Q1`-`Q4`. At least one of `job` and `quality` is set; both may be (`jobOrQuality`). |
| `surface`        | string  | yes      | The result surface, e.g. `/dashboard`; `null` when the finding has none.             |
| `what_happened`  | string  | no       | Non-blank.                                                                           |
| `cost`           | string  | no       | Non-blank. In plain language: what this costs the persona.                           |
| `evidence`       | array   | no       | `{kind, ref}` items; at least one (`evidenceRequired`).                              |
| `file_candidate` | boolean | no       | The default selection when findings are turned into issues.                          |

## Run-level abstentions

`not_assessed` lists what the run could not exercise at all, for example
`"walk skipped: no browser driver"` or `"overlay auth env var unset"`. It is
required: an absent list is refused, and `[]` means there were none. A row that
was not examined stays a `not-assessed` row in `ledger`; the two never repeat
each other.

## Named rules

The schema stays inside ADR 0035's keyword subset (no `oneOf`, no
`additionalProperties`, no `minItems`). These rules, in `tool-review.mjs`, state
what the subset cannot:

| Rule               | Refuses                                                                                        | Path                           |
| ------------------ | ---------------------------------------------------------------------------------------------- | ------------------------------ |
| `jobOrQuality`     | A finding whose `job` and `quality` are both `null`                                            | `findings[i]`                  |
| `noCompositeScore` | A `score`, `overall`, `composite` or `rating` key on the report or on any finding, even `null` | `<key>` or `findings[i].<key>` |
| `evidenceRequired` | A finding with `evidence: []`                                                                  | `findings[i].evidence`         |

Like every canary contract, a `minLength` of 1 also refuses a whitespace-only
string (rule `non-blank`).

## Conventions (frozen)

- **Version.** `contract` is `canary.<name>/<major>`. Layer contracts keep
  `canary.<layer>/<major>`; a standalone contract's `<name>` may contain hyphens
  (ADR 0045, extending ADR 0035 D3). Any other contract string or major version
  is refused. A minor version only adds optional fields.
- **Unknown fields are tolerated**, except the four score keys.
- **No composite score** (D8, ADR 0036). A roll-up hides the persona that was
  failed.
- **Public boundary** (spec D11). The format is generic. Tool-specific overlays,
  internal routes and paths, screenshots, and the report of a review of a
  private tool belong in that tool's repository, never in canary.

## Validating

```js
import { validateToolReview } from './agents/skills/lib/contracts/tool-review.mjs';

const { valid, checked, errors } = validateToolReview(JSON.parse(text));
```

Errors are `{path, message}`, and the document root is `$`. `checked` is the
denominator: the report plus its ledger rows and findings. There is no
command-line entry point in this release.

### Not checked by the validator

The `canary-blackalice` CLI is to enforce these producer obligations when it
ships (spec phase 3). They are **not shipped yet**:

- A row's companion from the [Ledger](#ledger) table, enforced when the row is
  recorded.
- **Zero `walked` rows is an abstention, not a review with no findings.**
  `report build` prints the abstention line first, writes no report, and exits
  0, or 3 under `--strict`.
- Exit codes: 0 ok, 1 refused, 2 usage error, 3 abstention (only under
  `--strict`).

## Consumers

None yet. `canary-blackalice` (phases 2-4 of [#1524]) is the first producer.

[#1524]: https://github.com/bop-clocktower/canary/issues/1524
[adr-0045]: ../knowledge/decisions/0045-tool-review-ledger-first-contract.md
