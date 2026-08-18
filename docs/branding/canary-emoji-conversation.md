# Canary Slack Emoji — Working Session

_A recap of the conversation that produced the Canary Slack status-emoji set._

---

## 1. Request: a Canary emoji + test-status variants

**Bri:** Can you make me a Slack emoji for Canary? Ones for the test-status
stuff would be great (canary cry, etc.).

**Claude:** Asked two quick clarifying questions:

- **Which states?** → Pass (happy/singing), Fail (canary cry), Flaky (dizzy)
- **Style?** → Sleek modern flat

Then produced a first pass: four cartoon-canary emoji (`canary`, `canary-pass`,
`canary-cry`, `canary-flaky`) at 128×128 transparent PNG, verified against
Slack's size limits, with a light/dark preview sheet. Offered to add
`canary-running` and `canary-skip`.

## 2. "Use the Canary brand kit"

**Bri:** Use the Canary brand kit.

**Claude:** Searched project knowledge, uploads, and installed skills — found no
brand kit in those locations and asked where it lived.

## 3. "here"

**Bri:** here

**Claude:** Located the kit in the selected folder (`docs/branding/`):
`brand-kit.md` + `brand-system.html`. Extracted:

- **Color tokens** — Obsidian `#0A0A0A`, Ash `#1C1C1C`, Smoke `#2E2E2E`, Canary
  `#F0C040`, Amber `#C09018`, Platinum `#F5F5F5`, Pass green `#28C840`, Fail red
  `#E24B4A`.
- **The official mark** — a geometric canary head (crest + beak + eye).
- **"The Cry" system** — the signal radiating from the beak _is_ the verdict,
  using the same go / advisory / no-go colors Canary returns at every gate.

Rebuilt all four emoji from the real mark geometry and tokens:

| Emoji            | Verdict         | Signal                                     |
| ---------------- | --------------- | ------------------------------------------ |
| `:canary:`       | brand / neutral | hero app icon (yellow tile, obsidian bird) |
| `:canary-pass:`  | GO              | green `#28C840`                            |
| `:canary-cry:`   | NO-GO           | red `#E24B4A`                              |
| `:canary-flaky:` | advisory        | amber `#D4A820` / `#C09018`                |

## 4. Add running + skip

**Bri:** Yes please add those.

**Claude:** Added:

- `:canary-running:` — animated sonar-pulse GIF, Canary-yellow rings expanding
  and fading from the beak (16 frames, 128×128, ~37KB).
- `:canary-skip:` — quarantined/benched: dimmed grey bird with a dashed, muted
  signal (no verdict color).

Full gate vocabulary now: **pass · cry · flaky · running · skip** + base
`:canary:`.

## 5. Document the set

**Bri:** Yes (add an EMOJI.md legend).

**Claude:** Wrote `docs/branding/emoji/EMOJI.md` mapping each emoji to its gate
verdict + token, and copied all six assets (SVG sources + rasters) into
`docs/branding/emoji/` so the legend lives beside the kit.

## 6. PR handling

**Bri:** Did you make a PR? … Get all the work staged; Claude Code will handle
the git.

**Claude:** No PR (repo root not mounted; GitHub connector unauthorized).
Finalized everything for handoff and fixed one doc-drift item — added a Slack
emoji pointer to `brand-kit.md`.

---

## Final deliverables

**Modified**

- `docs/branding/brand-kit.md` — added `emoji/EMOJI.md` pointer.

**Added — `docs/branding/emoji/`**

- `EMOJI.md` — legend (emoji → gate verdict → token).
- `canary`, `canary-pass`, `canary-cry`, `canary-flaky`, `canary-skip` — SVG
  source + 128×128 PNG (~4KB each).
- `canary-running` — SVG + 128×128 animated GIF (16 frames, ~37KB).

**Stage for commit**

```bash
git add docs/branding/brand-kit.md docs/branding/emoji
```

Suggested branch: `chore/canary-slack-emoji` off the default branch. No tests
apply (static assets); the only hygiene item was the doc pointer, which is done.

**Design principle:** every status emoji reuses the exact mark geometry and maps
1:1 to a Canary gate verdict via "The Cry" signal color — go (green), advisory
(amber), no-go (red), plus pending (pulse) and benched (grey).
