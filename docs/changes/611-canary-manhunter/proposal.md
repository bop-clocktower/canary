# canary-manhunter — release quality dossier

**Issue:** #611 · **Route:** feature (roadmap-fleet lane, autonomous) ·
**Ideation:** `docs/ideation/bop-themed-canary-skills-2026-07-21.md` rank 6

**Keywords:** release-dossier, evidence, abstention, content-digest,
guardian-analyses, run-history, katana-ledger, sweep, escaped-defects

## Overview

Delivery and client-success staff are asked, under time pressure, "is this
release OK to ship, and what should I look at?" Every input to that answer
already exists in canary — the run-history store, the guardian's analysis
records, `canary ci-ready`, the katana quarantine ledger, the sweep
accessibility report — but each lives in its own file and format, and none says
what the others did not see.

`canary manhunter` assembles those sources into **one release dossier**: a
markdown report (plus an optional JSON twin) with one section per evidence
source, a derived **Worth your eyes** list, an overall evidence verdict, and a
**sha256 content digest** over the canonical payload so the dossier that was
reviewed can be proven to be the dossier that was shipped.

### Goals

1. One command produces the dossier from files already on disk. Emit-only: no
   network, no posting, no credentials.
2. **Every section abstains loudly.** A missing, unreadable, self-abstained or
   zero-denominator source renders as `DARK` with the reason, never as a clean
   section. A dossier with dark sections can never report `complete`.
3. The dossier answers a question and gates a checklist item (the ideation
   objection): its exit code is the release-checklist item "quality evidence is
   complete", and the Worth-your-eyes list is the short answer to "what should I
   look at".
4. The content digest is reproducible and checkable: `canary manhunter verify`
   recomputes it from the JSON dossier.

### Non-goals

- Cryptographic signing, keys, or secrets (answered fork: "signed" means a
  content-hash digest).
- Posting anywhere (PR comment, chat, tracker). The artifact is the output.
- Running any producer. The dossier reads what `canary history record`,
  `canary guardian pr-check`, katana and sweep already wrote; it runs none of
  them.
- A correctness verdict on the release. The dossier grades the **evidence**, not
  the product.
- Batwoman closure audits (needs `gh` + network; would break emit-only). Noted
  as a follow-up.

## Decisions made

Autonomous lane: each routine question was answered with the recommended option
and is recorded as an assumption in `provenance.json`.

| #   | Question                                  | Decision                                                                                                                                                                                                                                                                                                                                                  | Why                                                                                                                                                                                                                         |
| --- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | What real decision does the dossier gate? | Exit code = evidence completeness: `0` complete, `1` incomplete (one or more undeclared dark sections), `3` abstained (every section dark). Worth-your-eyes items never change the exit code.                                                                                                                                                             | Answers the ideation objection with a checklist item a release manager can wire into CI, without the tool pretending to judge the product. `3` matches `EXIT_ABSTAINED` (`ts/src/core/gate-result.ts:37`).                  |
| D2  | How does a project without a source pass? | `--exclude <section>=<reason>` declares a section out of scope. It renders as `EXCLUDED — <reason>` and counts toward `complete`. An exclusion with an empty reason is a usage error.                                                                                                                                                                     | Silence is earned by declaring the gap, never by omitting it; a non-UI project must be able to reach `complete` without a sweep report.                                                                                     |
| D3  | Where do inputs come from?                | Conventional paths under `--root`, each overridable: history `test-results/reports/history-v2.jsonl`, guardian `.harness/analyses/canary-pr-guardian-*.json`, ci-ready computed in-process from the same inputs `canary ci-ready` reads, ledger `.canary/quarantine.json`, escapes `.canary/escapes.json`, sweep `--sweep <file>` (no convention exists). | Same records the producers already write (`ts/src/ci-ready-cli.ts:24`, `ts/src/guardian/cli.ts:1330`, katana SKILL.md "The ledger"); no second pipeline.                                                                    |
| D4  | Escape history has no canary source       | A hand-maintained `.canary/escapes.json` (`{schema_version: 1, tracked_since, escapes: [...]}`). No file or no `tracked_since` → DARK. An empty list with `tracked_since` is fed ("0 escapes recorded since X").                                                                                                                                          | `STRATEGY.md#key-metrics`: the escaped-defect ratio "requires an incident-data join canary does not hold today — tracked manually at first". `tracked_since` is the denominator that separates "none" from "never tracked". |
| D5  | Digest scope                              | sha256 over canonical JSON (recursively sorted keys) of the payload **excluding** `generatedAt` and `digest`; each source's own file sha256 is inside the payload.                                                                                                                                                                                        | Same evidence ⇒ same digest, so anyone can re-run and compare; any edit to the JSON changes it; the per-source hashes pin which artifacts were read.                                                                        |
| D6  | CLI mount                                 | `canary manhunter [options]` and `canary manhunter verify <dossier.json>`, registered in the `readiness` domain registry (`ts/src/commands/readiness/cli.ts`).                                                                                                                                                                                            | #988 registry rule; `readiness` is "suite readiness, data and briefing tools". Nothing is added to `ts/src/history/**` (#1074).                                                                                             |
| D7  | Module placement                          | Engine in `ts/src/analysis/manhunter/` (analysis layer: may import history, core, util — not guardian); CLI in `ts/src/manhunter/manhunter-cli.ts` (cli layer by filename).                                                                                                                                                                               | `harness.config.json` layers. Guardian records are parsed as JSON with a local minimal shape, not by importing guardian types.                                                                                              |
| D8  | Two guardian sections or one              | Two: `coverage-tiers` (fidelity mix + coverage-input status) and `guardian-findings` (unaddressed findings), sharing one loader.                                                                                                                                                                                                                          | The issue names them separately; they answer different questions ("how do we know" vs "what is open").                                                                                                                      |
| D9  | Skill vs command                          | Composition lives in the command; the `canary-manhunter` skill only runs it, relays the verdict line and the dark/eyes lists.                                                                                                                                                                                                                             | Issue comment (pre-merge-brief shape): keeps the assembly testable.                                                                                                                                                         |

## Technical design

### Section model

```ts
type SectionStatus = 'fed' | 'dark' | 'excluded';
interface Section {
  id: SectionId; // 'run-history' | 'coverage-tiers' | 'guardian-findings'
  //               | 'ci-readiness' | 'quarantine' | 'sweep' | 'escapes'
  title: string;
  status: SectionStatus;
  reason: string | null; // why dark / excluded; null when fed
  sources: SourceRef[]; // { path, sha256 | null }
  denominator: string | null; // e.g. "42 runs", "3 guardian records, 118 units checked"
  facts: string[]; // plain lines rendered under the section
  eyes: EyeItem[]; // { section, text }
}
```

Each builder is a pure function `(input) => Section`. The readers are the only
I/O and return a tagged result:
`missing | unreadable(reason) | ok(bytes, sha256)`.

| Section             | Source                                            | Fed when                                            | Worth your eyes                                                                               |
| ------------------- | ------------------------------------------------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `run-history`       | `NdjsonHistoryStore.readAll()` / `queryFlaky()`   | ≥1 run in store                                     | latest run per suite with `failed > 0`; flaky tests over the window                           |
| `coverage-tiers`    | guardian analysis records                         | ≥1 record with `abstained: false` and `checked > 0` | records whose coverage status is not `verified`; heuristic-only share when > 0                |
| `guardian-findings` | guardian analysis records                         | same denominator as above                           | each unaddressed (non-suppressed) finding                                                     |
| `ci-readiness`      | `scoreCiReady()` on the same inputs as `ci-ready` | verdict ≠ `abstained`                               | each `fail`/`warn` check; `incomplete` verdict itself                                         |
| `quarantine`        | katana ledger                                     | file exists and parses (katana has written it)      | rows with a cause needing an issue but none; rows past `expiry`; `removed` rows with no cause |
| `sweep`             | sweep `report.json`                               | file parses and `summary.abstained` is false        | findings with impact `critical`/`serious`; `unattributed_nodes > 0`                           |
| `escapes`           | `.canary/escapes.json`                            | file parses and has `tracked_since`                 | each recorded escape                                                                          |

Each section caps its eyes list at 10 with an "and N more" line.

### Assembly and verdict

- `verdict = 'abstained'` when no section is `fed` (excluded-only counts as
  abstained too: nothing was read); `'incomplete'` when any section is `dark`;
  else `'complete'`.
- **Worth your eyes** = one item per dark section (first), then section items in
  section order.
- `digest = sha256(canonicalJson(payload))`, payload =
  `{schemaVersion: 1, release, verdict, sections, worthYourEyes}`.

### Output

- Markdown to stdout by default; `--out <file.md>` writes it instead;
  `--json-out <file.json>` writes the JSON dossier (payload + `generatedAt` +
  `digest`). The markdown header prints release label, verdict,
  fed/dark/excluded counts, and the digest.
- `canary manhunter verify <file.json>`: recomputes the digest; exit 0 on match,
  1 on mismatch, 2 on unreadable input.

### File layout

```text
ts/src/analysis/manhunter/
  types.ts        section/dossier types, section ids
  sources.ts      read + sha256 a file; list guardian records
  history.ts      run-history section
  guardian.ts     coverage-tiers + guardian-findings sections
  readiness.ts    ci-readiness section
  ledger.ts       quarantine section
  sweep.ts        sweep section
  escapes.ts      escapes section
  assemble.ts     verdict, eyes, exclusions, digest, canonical JSON, verify
  render.ts       markdown
ts/src/manhunter/manhunter-cli.ts   commander wiring (readiness registry)
agents/skills/claude-code/canary-manhunter/{SKILL.md,skill.yaml}
docs/guides/release-dossier.md
```

## Integration points

### Entry Points

- New CLI subcommand `canary manhunter` (+ `verify`).
- New skill `agents/skills/claude-code/canary-manhunter/`.

### Registrations Required

- `ts/src/commands/readiness/cli.ts` — one import + one registry entry.
- `harness.config.json` `entropy.entryPoints` and `performance.entryPoints` if
  the entropy ratchet reads the new modules as dead.
- `.harness/arch/allowances/` entry if module-size grows (measured vs merge
  base).
- Skill roster surfaces: `agents/skills/README.md`, `docs/naming-registry.md`
  (`reserved` → `shipped`), `docs/roadmap.md` row status, and whatever
  roster/catalog tests require.

### Documentation Updates

- `docs/guides/release-dossier.md` (new) linking every new source file; linked
  from the guides index.
- `CHANGELOG.md` Unreleased entry.

### Architectural Decisions

None warrants a standalone ADR: D1 (exit code as evidence completeness) reuses
the existing gate contract; D4's escapes file is a local input format documented
in the guide and versioned by `schema_version`.

### Knowledge Impact

Domain concept "release dossier": a composition over existing evidence sources
whose sections carry fed/dark/excluded status and whose payload carries a
content digest.

## Success criteria

1. When every source is present with a non-zero denominator, `canary manhunter`
   prints a dossier whose verdict is `complete` and exits 0.
2. When a source file is missing, unreadable, malformed, self-abstained, or has
   a zero denominator, its section renders `DARK` with the reason, the dark
   section heads Worth your eyes, the verdict is `incomplete`, and the exit code
   is 1 — never 0.
3. When every section is dark, the verdict is `abstained` and the exit code
   is 3.
4. `--exclude sweep="no UI surface"` renders the section
   `EXCLUDED — no UI surface` and lets the verdict reach `complete`; an empty
   reason exits 2.
5. The digest is identical across two runs over the same inputs at different
   times, changes when any source byte changes, and `canary manhunter verify`
   returns 0 on the untouched JSON and 1 after any payload field is edited.
6. The command performs no network I/O and writes only the paths given by
   `--out` / `--json-out`.
7. No file under `ts/src/history/**` changes.

## Implementation order

1. Types, source readers, canonical JSON + digest (+ verify).
2. Section builders (one per source), each with abstention tests first.
3. Assembly (verdict, exclusions, eyes) and markdown render.
4. CLI wiring in the readiness registry; end-to-end CLI tests on synthetic
   fixtures.
5. Skill, guide, roster/registry docs, ratchet declarations.
