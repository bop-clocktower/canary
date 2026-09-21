# canary-sweep: component-level dedup for axe findings (#594)

**Keywords:** accessibility, a11y, axe-core, WCAG, component dedup,
post-processor, abstention, unattributed, skill

## Overview

Issue #594 asked for a site-wide accessibility audit skill that crawls routes,
runs axe-core per page, dedupes by component, and emits a WCAG-mapped report
with fix snippets.

**Three of those four are not ours.** The issue's own third comment established
this from a catalog comparison against harness: harness ships eleven a11y
skills, and `a11y-testing-automation` already wires `@axe-core/playwright` for
full-page scanning plus `jest-axe` for component tests, with CI integration.
Crawling and scanning would be duplication. Route discovery is framework-
specific and, done badly, is exactly the silent-miss failure this repo exists to
prevent.

The fourth is ours, and nothing in harness does it: **dedupe findings by
component rather than by page.** One bad button in a shared header, reported
forty times across forty pages, is forty rows of noise — and noise is how a11y
tooling gets muted.

So `canary-sweep` is a **post-processor**, not a scanner. It ingests axe-core
JSON produced by anything (harness's `a11y-testing-automation`,
`@axe-core/playwright`, `jest-axe`, the `axe` CLI), collapses findings by
component, and emits a WCAG-mapped Markdown/JSON report with fix snippets.

### Resolution of the issue's open questions

| Open question                                                       | Resolution                                                                                                                                                                                   |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Route discovery: explicit list only for v1, or sitemap/router read? | **Neither — route discovery is out of scope entirely.** There is no crawler to discover routes for. An optional explicit route list is accepted only as a coverage denominator (see D4).     |
| Is this in scope for a testing tool, or a downstream overlay?       | **In scope, reduced to the post-processing step.** The scanning half belongs upstream in harness; the dedup-and-report half is finding triage, which is what this repo does everywhere else. |

This rescope was **decided by a human at the fleet CONFIRM step** before any
code was written; it is not an inference made by the authoring lane. It is
recorded again in `provenance.json` as assumption A1.

## Non-goals

These are named so a later reader does not read their absence as an oversight:

- **No crawling, no browser, no network.** The skill reads JSON off disk and
  writes files. It never launches a browser and never fetches a URL.
- **No route discovery.** Not from a sitemap, not from a router config, not from
  a framework manifest.
- **No axe execution.** It does not depend on `axe-core` and does not shell out
  to it. Someone else ran axe; this reads what they produced.
- **No new `canary` engine subcommand.** This is a self-contained skill CLI in
  `agents/skills/claude-code/`, the same shape as `canary-blackhawk`,
  `canary-screech` and `canary-strix`. No `ts/src` surface is added.

## Decisions

Recommended defaults, chosen by the authoring lane running non-interactively.
Each is a real fork with a real alternative, so each is reviewable.

### D1 — Component attribution comes from explicit markers, and nothing else

The dedup key is `component × rule`. Everything turns on how a component is
identified from an axe node, which gives only `html`, `target` (CSS selector
path) and `failureSummary`.

**Decision:** attribution reads explicit authoring markers from the node's own
HTML, in a fixed priority order:

1. `data-component`
2. `data-testid`
3. `data-test`
4. `data-qa`

The list is overridable with `--component-attr a,b,c`. The first attribute
present on the failing element wins. If the failing element carries none of
them, the node is **unattributed** — reported as such, with a count.

**Rejected alternative:** synthesise a component key from the tag name plus the
class list, or from the second-to-last selector segment. That would produce a
key for every node and make the report look complete. It would also merge two
genuinely different buttons that happen to share a utility class, and split one
component whose class list varies by state. A key derived from a proxy is a
guess presented as an attribution, and the count of things this skill could not
attribute is precisely the number a reader needs in order to know how much of
the report to trust.

**Consequence, stated plainly:** on a codebase with no `data-*` markers, every
finding lands in the unattributed bucket and the report is a flat list. That is
the honest output for that input, and the report says so in one line rather than
pretending to a dedup it did not perform. The fix is to add markers, which is
advice the report gives.

### D2 — Ancestor lookup is bounded to the failing element

A node's `html` is the failing element's outer HTML only; axe does not ship its
ancestors. `target` is a selector path, so an ancestor's `data-component` is
reachable only if it appears as a selector segment
(`[data-component="Foo"] > button`). **Decision:** read markers from the node
`html` first, then from any attribute selector present in the `target` path. No
DOM reconstruction, no guessing at a parent that was never serialised.

### D3 — WCAG mapping is derived from axe tags, never invented

axe tags each rule (`wcag2a`, `wcag21aa`, `wcag143`, `best-practice`,
`cat.forms`). **Decision:** the success criterion is parsed from the `wcagNNN`
tags (`wcag143` → `1.4.3`) and the level from the `wcag2a`/`wcag2aa`/`wcag2aaa`
/`wcag21*`/`wcag22*` tags. A rule carrying no WCAG tag is reported as **"no WCAG
criterion (best-practice rule)"**, not silently mapped to a plausible one. A
rule carrying a WCAG tag this skill cannot parse keeps the raw tag verbatim.

### D4 — Fix snippets are a curated table with an honest fallback

**Decision:** ship a small snippet table keyed by axe rule id, covering the
rules that actually dominate real axe output (`image-alt`, `button-name`,
`link-name`, `label`, `color-contrast`, `html-has-lang`, `document-title`,
`frame-title`, `aria-required-attr`, `aria-hidden-focus`, `select-name`,
`heading-order`, `landmark-one-main`, `region`, `list`, `input-image-alt`,
`meta-viewport`, `tabindex`, `th-has-data-cells`, `duplicate-id-active`). For
any other rule, the report prints axe's own `help` text and `helpUrl` and says
there is no canary snippet for that rule.

**Rejected alternative:** generate a snippet from the failing HTML. A generated
snippet that is subtly wrong is worse than no snippet, because it gets pasted.

### D5 — Zero findings is an abstention unless the scan is provably non-empty

This is the load-bearing honesty rule, and the reason the skill inspects parts
of the axe document it otherwise ignores.

An axe result document with `violations: []` has two completely different
meanings: _axe checked this page and it is clean_, or _axe never actually ran
anything here_. A post-processor that prints "no violations" for both is the
false-green shape.

**Decision:** the denominator is explicit and two-level.

| Input state                                                                                           | Outcome                                                                                        |
| ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Zero axe result documents parsed                                                                      | **ABSTAINED** — nothing was read                                                               |
| Documents parsed, but every one has empty `violations`, `passes`, `incomplete` **and** `inapplicable` | **ABSTAINED** — axe produced documents in which no rule was evaluated; the denominator is zero |
| Documents parsed, at least one rule evaluated somewhere, zero violations                              | **CLEAN**, printed with its denominator: _N pages, M rule evaluations, 0 violations_           |
| Documents parsed, violations present                                                                  | Findings report                                                                                |

The clean line always carries its denominator, so a reader never sees a bare
green tick.

### D6 — An explicit route list is a coverage denominator, not a work list

`--routes <file>` (newline-delimited, or a JSON array) is optional. It does not
cause anything to be scanned — there is no scanner. It is compared against the
`url` of each parsed axe document, and any listed route with **no** axe document
is reported as **unscanned**, with a count. This is the one honest thing a
post-processor can say about route coverage: it can name what it was told to
expect and did not receive.

### D7 — Advisory by default, `--strict` carries the exit contract

Matching every other skill CLI in this family (`D3` of #508): exit 0 by default
whatever is found; under `--strict`, exit 1 on violations, 3 on abstention, 2 on
a usage error. Abstention prints loudly in both modes.

## Interface

```bash
canary skills run canary-sweep -- --results axe-results/ \
  --markdown-out a11y/report.md --json-out a11y/report.json
```

| Flag               | Meaning                                                             |
| ------------------ | ------------------------------------------------------------------- |
| `--results PATH`   | required; a JSON file or a directory of `.json` files of axe output |
| `--routes PATH`    | optional explicit route list, used as a coverage denominator (D6)   |
| `--component-attr` | comma-separated attribute priority list, overriding the D1 default  |
| `--markdown-out`   | write Markdown to a file (stdout when neither `--*-out` is given)   |
| `--json-out`       | write the machine-readable report to a file                         |
| `--strict`         | enable the exit-code contract (D7)                                  |

Accepted input shapes: a single axe `AxeResults` object, an array of them, or
`{ "results": [...] }`. Each is what one of the common producers emits.

### JSON report contract

```json
{
  "version": 1,
  "generated_at": "2026-09-17T00:00:00Z",
  "summary": {
    "pages": 12,
    "rule_evaluations": 4193,
    "violation_nodes": 87,
    "components": 9,
    "unattributed_nodes": 14,
    "findings": 23,
    "abstained": false
  },
  "coverage": {
    "routes_expected": 14,
    "routes_scanned": 12,
    "routes_unscanned": ["/billing", "/help"]
  },
  "findings": [
    {
      "component": "SiteHeader",
      "attribution": "data-component",
      "rule": "color-contrast",
      "impact": "serious",
      "wcag": { "criteria": ["1.4.3"], "level": "AA" },
      "occurrences": 40,
      "pages": ["/", "/pricing"],
      "sample_targets": ["[data-component=\"SiteHeader\"] > button"],
      "fix": "..."
    }
  ]
}
```

`unattributed_nodes` is a top-level summary field, not a bucket hidden inside
`findings`, precisely so it cannot be skimmed past.

## Success criteria

1. Forty occurrences of one rule on one marked component across forty pages
   collapse to **one** finding with `occurrences: 40` and the page list.
2. Nodes with no attribution marker are reported as unattributed with an exact
   count, and never merged into a named component.
3. A results set in which no rule was evaluated abstains loudly and, under
   `--strict`, exits 3.
4. A genuinely clean scan prints its denominator alongside the zero.
5. A rule with no WCAG tag is labelled as such rather than mapped.
6. A route listed in `--routes` with no axe document is reported unscanned.
7. The skill imports no engine code, launches no browser, and makes no network
   call.

## Out of scope / follow-ups

- Trend-over-time for a11y findings (belongs with the run-history store).
- Ingesting non-axe a11y formats (Pa11y, Lighthouse).
- A `canary` engine subcommand wrapping this skill.
