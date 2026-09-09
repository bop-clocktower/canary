---
name: VAC-004 — self-excusing skip
status: draft
type: gate
owner: brianna.stevenski@example.com
created: 2026-08-26
related_decisions:
  - docs/knowledge/decisions/0009-exit-3-reserved-for-abstained.md
supersedes_decisions: []
introduces_adrs: []
---

# VAC-004 — self-excusing skip

**Keywords:** vacuity, cassandra, false-green, skip, playwright, pytest,
conditional-skip, abstention

## Overview

A fourth vacuity rule: a **conditional skip whose condition is a function of the
behaviour the test asserts**. Such a skip cannot distinguish "this environment
cannot exercise the behaviour" from "the behaviour is broken", because both
present identically — so it excuses the regression it was written to catch, and
the run reports clean.

Recorded as a false-green shape in
[`docs/knowledge/gates/false-green-detection.md`](../../knowledge/gates/false-green-detection.md).
This proposal is the mechanical half.

### The instance that produced it

A Playwright guard, meant to keep an auth-restriction test honest against
targets with no tenant configured:

```ts
const res = await page.goto('/app/marketplace');
test.skip(
  !AUTH_URL.test(page.url()) &&
    (res?.status() ?? 0) === 200 &&
    page.url().includes('/app'),
  'no redirect and the route rendered — the edge gate is inert on this target',
);
await expect(page).toHaveURL(AUTH_URL);
```

Mutating the middleware so the gate stopped covering that route produced exactly
the state the skip describes. The test **skipped instead of failing**; the suite
reported clean. The fix was a probe independent of the assertion — the sibling
branch of the same matcher — after which the same mutation failed.

Both the flaw and the fix are already in the wild, which is what makes this
specifiable rather than speculative.

## Goals

1. Flag a conditional skip whose condition **reads the same observable** the
   test's subsequent assertions check.
2. Stay quiet on the legitimate majority: skips keyed on configuration,
   credentials, platform, feature flags, or fixture availability — things the
   code under test cannot change.
3. Ship **advisory** (exit 0 on findings), per the repo's established shape for
   a new detector.

## Non-goals

- Judging whether a skip is _justified_. A correctly-keyed skip on an
  unconfigured target is good practice; only the keying is in scope.
- Unconditional skips (`test.skip('...')`, `it.skip`, `xit`). Those are a
  different concern — parked/quarantined coverage — and belong to `katana`, not
  here.
- Inferring intent from the skip's message string. Prose is not evidence.

## Detection

**Fires when**, within one test block:

1. a conditional skip exists — `test.skip(<expr>, …)` / `test.fixme(<expr>, …)`
   (Playwright), `pytest.skip(...)` under an `if`, or
   `@pytest.mark.skipif(<expr>)`; **and**
2. the skip's condition expression references an **observable** that at least
   one assertion after it also references.

"Observable" is deliberately narrow, to keep this deterministic:

| Observable class                                    | Recognised as                                                      |
| --------------------------------------------------- | ------------------------------------------------------------------ |
| response status                                     | `.status()`, `status_code`, `res.status`                           |
| URL / location                                      | `.url()`, `page.url`, `.toHaveURL`, `response.url`                 |
| a locator or selector string shared between the two | identical selector literal or the same `getByTestId(...)` argument |
| a variable assigned from either of the above        | same identifier                                                    |

Both halves must resolve to the same class **and** the same subject. `status` in
the skip and `status` in the assertion counts; `status` in the skip and a
locator in the assertion does not.

**Severity:** `warning`. The detection is textual and cross-referencing, i.e.
inference — so it carries a fidelity tier and cannot be `critical`. Only
`VAC-001` is deterministic enough for that (see the scanner's docblock).

**Fidelity:** reuse the existing ladder. `annotated` when skip and assertion
reference the _same identifier_; `import-inferred` when the match is by
observable class on different expressions.

### Deliberately NOT flagged

```ts
test.skip(!process.env.AUTH0_DOMAIN, 'no tenant on this target'); // config
test.skip(browserName === 'webkit', 'unsupported'); // platform
test.skip(!(await featureEnabled('x')), 'flag off'); // flag
```

None reads an observable the assertions check. This is the whole population the
rule must stay silent on, and the reason the observable list is narrow rather
than "any shared expression".

## Contract

Extends the existing finding shape — the union widens, nothing else changes:

```ts
rule: 'VAC-001' | 'VAC-002' | 'VAC-003' | 'VAC-004';
```

Message names both sides, because the fix is not obvious from the rule name
alone:

```text
VAC-004  tests/smoke/auth-restrictions.spec.ts:99
  test: a deep /app route redirects too, not just the index
  The skip condition reads `page.url()`, which the assertion on line 106 also
  checks. If the behaviour regresses, this test skips rather than fails.
  Suggestion: key the skip on something the code under test cannot change —
  configuration, credentials, or an independent sibling probe.
```

## Denominator

Per the repo rule, a collapsed denominator is not advisory. `VAC-004` needs no
target resolution, so like `VAC-001` it **always runs** and cannot go dark for
lack of a target. It is skipped only for files with zero parsed test blocks,
which the existing scanner already counts and reports.

## Verification

Adopt the repo's own standard — a rule that cannot fail is exactly what this
proposal is about, so the tests must include the mutation:

1. **The real instance** (fixture from the branch above) → fires.
2. **The real fix** (independent sibling probe) → does not fire.
3. Each row of the NOT-flagged table → does not fire.
4. Skip _after_ the assertions rather than before → does not fire (it cannot
   excuse an assertion that already ran).
5. Zero test blocks → counted as a skip, not a pass.

## Rollout

Advisory first. Do not wire as a required check on adoption — run it across
`examples/` and any consuming suite, triage the count, then decide, matching the
dogfooding pattern in `#485`. Ratcheting to strict is a separate decision with
its own evidence.

## Integration Points

- `ts/src/core/vacuity-scanner.ts` — rule implementation + union widening
- `ts/test/vacuity-scanner.test.ts` — the five verification cases
- `agents/skills/claude-code/canary-cassandra/SKILL.md` — the "What it finds"
  table
- `docs/knowledge/gates/false-green-detection.md` — the narrative shape (landed
  with this proposal)
