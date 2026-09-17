---
name: canary-sweep
description:
  Component-level dedup for axe-core accessibility findings. Ingests axe JSON
  produced by anything (harness a11y-testing-automation, @axe-core/playwright,
  jest-axe, the axe CLI), collapses findings by COMPONENT rather than by page,
  and emits a WCAG-mapped Markdown/JSON report with fix snippets. A
  post-processor — it never crawls, never discovers routes, never runs a browser
  and never touches the network. Nodes it cannot attribute are reported as
  unattributed with a count, and a results set in which no rule was evaluated
  abstains rather than reading as a clean pass.
cli: scripts/cli.mjs
requires: [node>=20]
---

# Canary Sweep

One bad button in a shared header, reported on forty pages, is forty rows of
noise — and noise is how accessibility tooling gets muted. `canary-sweep`
collapses a per-page axe dump into a per-component finding list.

## What this is not

It is a **post-processor**. Someone else ran axe.

- No crawling, no route discovery, no browser, no network.
- No dependency on `axe-core`; it reads JSON off disk.
- The scanning half lives upstream — harness's `a11y-testing-automation` already
  wires `@axe-core/playwright` and `jest-axe` into CI. Point this at its output.

## Invocation

```bash
# A directory of axe JSON, Markdown to stdout:
canary skills run canary-sweep -- --results axe-results/

# Both artifacts, which is what CI wants:
canary skills run canary-sweep -- \
  --results axe-results/ \
  --markdown-out a11y/report.md \
  --json-out a11y/report.json

# Explicit route list as a coverage denominator:
canary skills run canary-sweep -- --results axe-results/ --routes routes.txt

# Usage and the full flag list (exits 0):
canary skills run canary-sweep -- --help
```

| Flag                    | Meaning                                                           |
| ----------------------- | ----------------------------------------------------------------- |
| `--results PATH`        | required; a JSON file or a directory of `.json` axe output        |
| `--routes PATH`         | optional route list (newline-delimited or a JSON array)           |
| `--component-attr LIST` | comma-separated attribute priority, overriding the default        |
| `--markdown-out PATH`   | write Markdown to a file (stdout when neither `--*-out` is given) |
| `--json-out PATH`       | write the machine-readable report to a file                       |
| `--strict`              | enable the exit-code contract                                     |

**Accepted input shapes:** a single axe `AxeResults` object, an array of them,
or a `{ "results": [...] }` envelope.

**Exit codes.** Advisory by default: `0` whatever is found. Under `--strict`:
`1` when violations were found, `3` when the run abstained, `0` when clean. A
usage error is always `2`.

## How a component is identified

Attribution reads explicit authoring markers off the failing element, in
priority order: `data-component`, `data-testid`, `data-test`, `data-qa`
(override with `--component-attr`). If the failing element carries none, the
skill also reads an attribute selector out of axe's `target` path, which is the
only way an ancestor's marker is reachable — axe serialises the failing
element's HTML only, so there is no DOM to walk.

If neither yields a marker, the node is **unattributed**. It is reported under
its own group with an exact count, and it is never folded into a named
component. A key synthesised from the tag name and class list would produce a
component for every node and make the report look complete, while merging two
different buttons that share a utility class. The unattributed count is how a
reader knows how much of the dedup actually happened.

On a codebase with no markers at all, every finding lands in that bucket and the
report says so in one line. That is the honest output for that input.

## Honesty rules

**Zero violations is not automatically a pass.** An axe document with
`violations: []` means "this page is clean" only if axe evaluated something. So
the report carries a two-level denominator:

| Input                                                                                 | Outcome                                                                |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| No axe document read                                                                  | **ABSTAINED**                                                          |
| Documents read, but `violations`, `passes`, `incomplete` and `inapplicable` all empty | **ABSTAINED**, with the document count                                 |
| At least one rule evaluated, zero violations                                          | Clean, printed as _0 violations across N pages and M rule evaluations_ |

The clean line always carries its denominator, so a bare green tick is never
what a reader sees.

**WCAG mapping is derived, not invented.** Criteria come from axe's `wcagNNN`
tags and the level from `wcag2a`/`wcag21aa`/… A rule with no WCAG tag is
labelled _no WCAG criterion (best-practice rule)_ rather than mapped to the
criterion it resembles.

**Fix snippets are curated or absent.** Around twenty high-frequency rules have
a written snippet. Any other rule gets axe's own `help` text and `helpUrl`, and
the report says there is no canary snippet for it. A generated snippet that is
subtly wrong is worse than none, because it gets pasted.

**Route coverage is a gap report, not a work list.** `--routes` does not cause
anything to be scanned. Listed routes with no axe document are reported as
unscanned, with a count — the one honest thing a post-processor can say about
coverage.

## CI wiring (GitHub Actions)

```yaml
- name: Accessibility scan
  run: npx playwright test a11y.spec.ts # writes axe-results/*.json

- name: Accessibility sweep
  if: always()
  run: |
    canary skills run canary-sweep --allow-executable-skills -- \
      --results axe-results/ \
      --routes routes.txt \
      --markdown-out a11y/report.md \
      --json-out a11y/report.json

- name: Upload the sweep report
  if: always()
  uses: actions/upload-artifact@v4
  with:
    name: a11y-report
    path: a11y/report.*
```

Add `--strict` once the report is triaged and the component list is stable;
until then the advisory default keeps it out of the way while it is being read.

## Related skills

- `canary-test-reporter` — the same artifact shape for Playwright run results
- `canary-fail-fast` — aborts a run early and emits `::error` annotations
