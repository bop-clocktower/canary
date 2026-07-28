---
name: canary-shadow
description: >
  Differential ("shadow") parity testing — run the SAME invocation through a
  baseline and a candidate, normalize away irrelevant noise (ANSI, timestamps,
  temp paths, version banners, SHAs), diff, and flag divergences. Use to prove a
  behavior-preserving change actually preserves behavior: a language/framework
  port (Python→TS, typer→commander), a skill rewrite (old vs new), a refactor
  claimed equivalent, or "does this still match the old CLI?". Runs both sides
  live, so it needs no golden capture — just the two versions. NOT a correctness
  oracle: it proves the two AGREE, not that either is right, so pair it with a
  few asserted cases.
cli: scripts/cli.mjs
requires: [node>=20]
---

# Canary: Shadow (differential parity testing)

> Run one invocation through two implementations, normalize the noise, diff the
> rest. Every un-accepted divergence is a behavior change to explain or fix.

## When to Use

- **Ports / rewrites** where output should be identical: Python→TS, a BoP skill
  re-port, typer→commander, one engine replacing another. (This is exactly how
  the v6 cutover was validated: run `canary <cmd>` through the TS engine AND the
  Python reference, diff. It surfaced a divergence the unit tests + golden suite
  missed — Python's `rich` console renders the ticket-marker hint
  `# canary:ticket:` as `# canary🎫` via emoji-shortcode substitution, mangling
  a hint the parser can't match; the TS port printed the literal, correct
  marker. A console-rendering artifact only a live side-by-side run exposes.)
- **Skill changes** — old skill vs new skill on the same inputs: "prove the
  rewrite is equivalent."
- **Refactors** asserted to be behavior-preserving.
- **Framework / dependency swaps** where the observable surface should not move.
- NOT for greenfield behavior (nothing to compare against) — use asserted tests.
- NOT as a sole correctness check — see the caveat at the bottom.

## The idea (differential / shadow testing)

For each case, run the SAME arguments through a `baseline` command and a
`candidate` command, capture `{exitCode, stdout, stderr}`, **normalize** both,
and diff. Identical (post-normalization) ⇒ `ok`. Different ⇒ `DIVERGE` — a real
behavior change, unless it's a _documented, intentional_ difference recorded in
the accepted-divergence allowlist.

The value is not the runner (two `spawn`s and a diff) — it's the two disciplines
below.

### 1. The normalization ruleset (get this right, or drown)

Output has meaningful content and irrelevant noise. Normalize the noise; keep
everything else. Default masks (see `scripts/cli.mjs`): ANSI SGR codes, ISO
timestamps, temp paths (`/tmp`, `/var/folders`, `/private`), version banners
(`vX.Y.Z[-rc.N]`), commit SHAs, run-ids.

- **Under-normalize** and every run is a wall of false DIVERGE (a timestamp, a
  temp dir) — you stop reading them.
- **Over-normalize** and you mask a real bug (don't blanket-strip numbers if the
  command emits counts/scores that matter).
- Make masking **visible**: the runner reports what each mask touched, so a
  reviewer can see a real difference wasn't hidden. Tune masks per project in
  the cases file's `normalize` list, don't hardcode.

### 2. The accepted-divergence allowlist

Some differences are intentional and permanent (e.g. Python `rich` soft-wraps
prose at 80 cols; a TS port emits it unwrapped — same content, different line
breaks). Record each in the cases file with a **reason**, keyed by case label.
This is the differential-test analog of `// harness-ignore`: an allowlisted
DIVERGE is reported as `accept` (with its reason), never as a failure, and a NEW
divergence still fails loudly. Review the allowlist like code — an entry with no
reason, or one that quietly grows, is a smell.

## Process

### Phase 1: SCOPE — define baseline, candidate, and cases

1. Identify the two implementations and how to invoke each (argv-preserving):
   `baseline` = the trusted side (old skill, Python reference, prior version),
   `candidate` = the new side.
2. Enumerate cases that cover the observable surface: the happy paths, the JSON
   contracts, the error/exit-code paths (a good differential run checks exit
   codes AND stdout), and any command that needs a fixture (a sample file, a
   temp project). Prefer read-only/deterministic cases first; give
   state-changing ones (`init`, `migrate`) an isolated `cwd`.

### Phase 2: RUN — cycle until clean

1. Write a cases file (see `scripts/cases.example.json`) and run:
   `node scripts/cli.mjs --cases <file>` (or via the skill `cli`). It prints
   `ok` / `DIVERGE` / `accept` per case and a summary; exit is non-zero if any
   un-accepted divergence remains.
2. For each DIVERGE: read the diff. Decide — **bug** (fix the candidate),
   **noise** (add/adjust a normalize rule), or **intentional** (add an allowlist
   entry WITH a reason). Re-run. Iterate in cycles until the only remaining
   divergences are `accept`ed.
3. Do multiple cycles broadening coverage (add sub-commands, more fixtures,
   adversarial inputs) — the first cycle finds the obvious breaks; the tail
   finds the subtle ones.

### Phase 3: LOCK — keep it honest

1. Commit the cases file + allowlist alongside the change so the parity contract
   is reviewable and re-runnable in CI.
2. Add a handful of **asserted** cases (expected exact output/exit for a few
   invocations) so the suite also catches "both sides are wrong the same way."

## Caveat — agreement is not correctness

Differential testing proves the two implementations AGREE. If the baseline has a
bug the candidate faithfully reproduces, both pass. So it is a powerful
regression net, not a correctness oracle — always pair it with a few asserted
cases and human review of the allowlist.
