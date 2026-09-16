---
name: canary-mission-briefing
description: >
  Turns a PR diff into a test charter for a human tester: what to verify by
  hand, which edge cases this diff invites, which tests already touch the
  changed code, and what nothing covers. Use when asked for a "test charter",
  "what should I test by hand on this PR", or "brief a tester". Advisory, never
  a gate: it writes no test file and changes no check. NOT canary-pr-guardian (a
  verdict) and NOT canary-generate-test (test code).
cli: canary briefing
requires: [node>=20]
---

# Canary: Mission Briefing

A charter is a short plan for a person doing manual or exploratory verification.
It says what to verify by hand, which edge cases this particular diff invites,
which existing tests already touch the changed code, and which changed lines
nothing touches. It is **not a gate**: it has no pass or fail and never changes
a check's colour. It is **not generated code**: it never writes a test file.

| Surface                   | Output            | Audience       |
| ------------------------- | ----------------- | -------------- |
| `canary-pr-guardian`      | a gate verdict    | CI             |
| `canary-generate-test`    | test code         | the suite      |
| `canary-mission-briefing` | a testing charter | a human tester |

The CLI supplies the facts; this skill supplies the judgment; the CLI then keeps
only the judgment that cites a changed line.

## When to Use

- Someone asks for a test charter, a manual test plan, or "what should I check
  by hand" on a PR or diff.
- A tester is picking up a change and needs to know where to spend their time.
- CI should post a charter next to the guardian verdict (`--comment`).

## When NOT to Use

- You need a merge verdict: use `canary-pr-guardian`.
- You need test code: use `canary-generate-test`.
- You want edge cases for a feature description with no diff: use
  `canary-edge-case-discovery` directly.

## Usage

```bash
canary briefing --help
```

That one needs no diff, no credentials and no network. A real charter needs a
diff (`--diff <file>`, or the PR diff resolved in CI) and, for the judgment
sections, a judgment file written by the workflow below.

## Workflow

1. **Facts.** Run
   `canary briefing --json [--diff <file>] [--coverage <report>]`. Exit 3 means
   it abstained. Relay the `Abstained:` line and stop, with no charter. It never
   exits 1.
2. **Risk.** If `risk_ranking` is `available`, the units are already highest
   risk first. Run `canary-failure-impact` for the top unit only, to keep cost
   bounded (spec D6).
3. **Edge cases.** For each unit, invoke `canary-edge-case-discovery` on the
   added ranges only. Keep only cases you can tie to one added line. Use the
   exact category names: Boundary values, Race conditions, Locale and timezone,
   Partial network, Unexpected input shapes, Accessibility.
4. **Judgment file.** Write JSON:

   ```json
   {
     "mission": "One sentence: what this tester is exploring and why.",
     "verify": [{ "text": "...", "cite": "path:line" }],
     "edge_cases": [
       { "category": "Boundary values", "text": "...", "cite": "path:line" }
     ]
   }
   ```

   Every `cite` must be a line inside that unit's `added_ranges`. The CLI drops
   anything else and lists it under "Out of this charter" with the reason. A
   dropped item is a signal to re-cite, not to argue.

5. **Render.** Run `canary briefing --judgment <file>` (stdout), or add
   `--comment` in CI to upsert a sticky comment under
   `<!-- canary-mission-briefing -->`. With no PR context, or a 403, the charter
   prints to stdout instead (the 403 with a `::warning::`), and it exits 0.

## Honesty rules

1. **No coverage data means "coverage unknown"** — never an implication that
   something is covered, and never a bare absence of findings.
2. **"Nothing covers" distinguishes measured from unmeasured.** A measured unhit
   line and a line nobody measured are different sentences.
3. **An absent inventory reads "inventory unavailable"**, never "none found". A
   static import match is not execution.
4. **No gate vocabulary.** No pass/fail word, no status emoji, and the literal
   phrase "not a gate" in the heading.
5. **Never edit the guardian comment.** The charter has its own marker, and
   guardian's sticky is left byte for byte as it was.

## Related skills

- `canary-edge-case-discovery` — the six categories the edge cases come from.
- `canary-critical-areas` — the `rank_score` that orders units by risk.
- `canary-failure-impact` — blast radius for the top-ranked unit.
- `canary-pr-guardian` — the gate verdict; a different surface.
- `canary-generate-test` — test code; a different surface.
- Guide: `docs/guides/mission-briefing.md`
