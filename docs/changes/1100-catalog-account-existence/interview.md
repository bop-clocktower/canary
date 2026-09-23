# Interview — catalog account existence (#1100)

Question-file mode. This lane ran autonomously, so the EVALUATE decisions were
answered at the fleet CONFIRM gate rather than in chat. Every `[Answer]:` below
is a human decision already on record; none was taken by the agent.

---

## Q1. Where does the verification live?

|            | A) Prose-only in both SKILL.md     | B) Tested TS helper + wiring in both SKILL.md | C) TS helper only         |
| ---------- | ---------------------------------- | --------------------------------------------- | ------------------------- |
| **Pros**   | No code, smallest diff             | One tested implementation, two honest callers | Smallest test surface     |
| **Cons**   | Untestable; two copies drift       | Touches loader + two skills                   | Dead export, no behaviour |
| **Risk**   | High — the failure mode is silence | Low                                           | High — reproduces #1033   |
| **Effort** | Low                                | Medium                                        | Low                       |

**[Answer]:** B. A helper with no callers is the dead `reportBranding()` shape
tracked in #1033 and is explicitly rejected; prose-only is untestable and drifts
across the two skills.

---

## Q2. `user_catalog_skill` is not a field the loader knows. What do we do?

Verified against the tree: `user_catalog_skill` appears in neither `_KNOWN_KEYS`
(`ts/src/core/company-knowledge.ts:110-134`) nor `_SCALAR_FIELDS`
(`ts/src/core/company-knowledge.ts:802-809`). Both skills instruct "Read
`user_catalog_skill` from `.canary/company.json`"
(`agents/skills/claude-code/canary-ci-ready/SKILL.md:162`,
`agents/skills/claude-code/canary-failure-impact/SKILL.md:114`), and
`canary-company-knowledge/SKILL.md:163` documents the key as an _unknown field_
that the loader warns about and ignores. So the issue body's premise — that the
skills "already know how to reach" the catalog through the loader — is wrong:
the key is silently stripped.

|          | A) Add it as a validated scalar field | B) Have the helper re-read the raw JSON |
| -------- | ------------------------------------- | --------------------------------------- |
| **Pros** | Cascade + validation + warnings apply | No loader change                        |
| **Cons** | Touches the exhaustiveness arrays     | Second parser; bypasses the cascade     |
| **Risk** | Low — compile-time exhaustiveness     | High — two loaders that disagree        |

**[Answer]:** A. Prerequisite for the helper to reach the config at all, and it
retires the documented "unknown field" wart.

---

## Q3. What must an abstention cover?

**[Answer]:** All four zero-denominator shapes, each reported as `cannot-verify`
with a stated reason and never as a pass: no `user_catalog_skill` configured;
the catalog could not be reached; the catalog returned zero users; zero
configured accounts were resolved.

---

**Keywords:** user-catalog, account-existence, abstention, zero-denominator,
company-knowledge, ci-ready, failure-impact, auth-failure,
decommissioned-account
