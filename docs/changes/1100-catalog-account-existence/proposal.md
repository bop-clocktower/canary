# Catalog account existence verification (#1100)

## Overview and goals

`canary-ci-ready` and `canary-failure-impact` both instruct an agent to consult
the consuming repo's declared user catalog on an auth, permission, or
configuration failure. Today both ask only **"which user could I try
instead?"**. Neither asks the inverse — **"do the accounts this repo is already
configured with still exist?"** — which is the question that actually resolves
the failure when accounts have been decommissioned upstream.

Goal: give both skills one tested way to ask the inverse question, and make the
answer degrade honestly when it cannot be asked.

Out of scope: implementing a catalog, naming any catalog implementation in
output, fetching accounts over the network, and any new CLI subcommand.

## Decisions made

1. **One tested helper in `ts/src/core/company-knowledge.ts`, called from both
   skills.** Prose-only is untestable and drifts across two files; a helper with
   no callers is the dead `reportBranding()` shape tracked in #1033. Decided by
   the human at the fleet CONFIRM gate (interview.md Q1).

2. **`user_catalog_skill` becomes a validated scalar field on the loader.**
   Verified against the tree: the key is in neither `_KNOWN_KEYS`
   (`ts/src/core/company-knowledge.ts:110`) nor `_SCALAR_FIELDS`
   (`ts/src/core/company-knowledge.ts:802`), so `CompanyKnowledge.load` warns on
   it as unknown and drops it — `canary-company-knowledge/SKILL.md:163`
   documents exactly that. The issue body's premise that the skills "already
   know how to reach" the catalog through the loader is therefore **wrong**, and
   the helper cannot reach the config until the field exists. Validated with the
   existing `_SKILL_RE`, lower-cased, merged as a scalar (highest-priority
   non-empty layer wins) exactly like `dashboard_token_env`.

3. **The verdict is a four-state enum, not a boolean.** `all-present`,
   `some-missing`, `all-missing`, `cannot-verify`. A boolean would force an
   abstention to render as one of the two real answers, which is the exact
   false-green shape the issue is about.

4. **Abstention covers four zero-denominator shapes** (interview.md Q3): no
   `user_catalog_skill` configured, the catalog could not be reached, the
   catalog returned zero users, zero configured accounts were resolved. Each
   carries a stated `reason`.

5. **`all-missing` reads as a diagnosis, not a hint.** When every configured
   account is unknown to the catalog, the headline says it is an account problem
   rather than a test defect.

6. **The helper is pure.** It takes the configured identifiers and the catalog's
   answer as data and returns a verdict. It performs no I/O, so it is fully unit
   testable and it never invokes a catalog itself — the skill does that, keeping
   the catalog tool-neutral.

## Technical design

Added to `ts/src/core/company-knowledge.ts` (extending the existing module
rather than adding one, which sidesteps the entropy `entryPoints` ratchet):

```ts
export type AccountExistenceStatus =
  'all-present' | 'some-missing' | 'all-missing' | 'cannot-verify';

export interface AccountExistenceQuery {
  /** Accounts the repo is configured with, as the failure context resolved them. */
  configured: string[];
  /** Accounts the catalog reports as existing. `null` means the catalog could not be reached. */
  catalogKnown: string[] | null;
  /** The declared `user_catalog_skill`; `''` when the repo configured none. */
  catalogSkill: string;
}

export interface AccountExistenceVerdict {
  status: AccountExistenceStatus;
  /** The denominator: how many configured accounts were actually compared. */
  checked: number;
  present: string[];
  missing: string[];
  /** Why the check abstained. `''` for every non-abstaining status. */
  reason: string;
  /** One line for skill output. Never names a catalog implementation. */
  headline: string;
}

export function verifyConfiguredAccounts(
  query: AccountExistenceQuery,
): AccountExistenceVerdict;
```

Comparison is on trimmed, case-folded identifiers, de-duplicated, with the
original spelling preserved in `present` / `missing`.

Abstention precedence (first match wins, so the most actionable reason is the
one reported): no catalog skill -> catalog unreachable -> catalog empty -> no
configured accounts.

### Skill wiring

Both `agents/skills/claude-code/canary-ci-ready/SKILL.md` and
`agents/skills/claude-code/canary-failure-impact/SKILL.md` gain an ordered step
**before** the existing "which user instead" suggestion: resolve the configured
accounts, invoke the declared capability to list known accounts, pass both to
`verifyConfiguredAccounts`, and report the verdict. The existing "check your
user catalog if you have one" fallback is retained only for the `cannot-verify`
case, where it is honest, and is replaced by the verdict headline in every other
case.

## Integration points

- **Entry Points** — no new module, no new CLI subcommand, no new MCP tool. One
  new exported function and one new field on an existing core module.
- **Registrations Required** — `user_catalog_skill` must be added to
  `_KNOWN_KEYS`, `Layer`, `CompanyKnowledgeInit`, `CompanyKnowledge`,
  `_SCALAR_FIELDS`, `parseLayer`, and `toDict`. The compile-time `CoversAll`
  exhaustiveness assertions fail the build if the `_SCALAR_FIELDS` entry is
  forgotten.
- **Documentation Updates** — the two consuming SKILL.md files, and
  `canary-company-knowledge/SKILL.md`, whose "unknown field, expected for
  `user_catalog_skill` today" row becomes wrong once the loader knows the key.
- **Architectural Decisions** — none. Extending an existing core module with a
  pure function raises no standalone ADR.
- **Knowledge Impact** — the concept "abstention over false pass" gains a second
  concrete instance in the codebase alongside the loader's existing
  drop-with-a-warning behaviour.

## Success criteria

1. When every configured account is absent from the catalog, the verdict is
   `all-missing` and the headline states it is an account problem rather than a
   test defect.
2. When some are absent, the verdict is `some-missing` and names them.
3. When all are present, the verdict is `all-present` with `checked` equal to
   the number of distinct configured accounts.
4. Each of the four zero-denominator shapes yields `cannot-verify` with
   `checked: 0` and a non-empty `reason`, and never `all-present`.
5. `CompanyKnowledge.load` surfaces a valid `user_catalog_skill` from
   `.canary/company.json`, honours the cascade, and warns-and-drops an invalid
   one instead of storing it.
6. No output produced by the helper contains a catalog implementation's name.
7. Both SKILL.md files instruct the existence check before the suggestion.

## Implementation order

1. Tests for `verifyConfiguredAccounts` (all four statuses, all four
   abstentions, de-duplication, case folding).
2. Tests for `user_catalog_skill` loading, cascade, and invalid-value warning.
3. Loader field.
4. Helper.
5. SKILL.md wiring in both consuming skills plus the company-knowledge doc row.
6. Four gates from `ts/`, plus `check-deps` from the repo root.
