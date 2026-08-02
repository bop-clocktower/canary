# Canary Slack Emoji

Status emoji for the Canary test reporter, built on the mark's **"The Cry"**
signal system — the arc radiating from the beak is the verdict, using the same
go / advisory / no-go colors Canary returns at every gate.

Assets live in this folder (`docs/branding/emoji/`). Each has a `.svg` source
and a Slack-ready raster: **128×128**, transparent, rounded tile (reads on light
and dark themes), all under Slack's 128 KB limit.

## Legend

| Emoji              | Gate verdict          | Signal color              | Token(s)              | File                 |
| ------------------ | --------------------- | ------------------------- | --------------------- | -------------------- |
| `:canary:`         | brand / neutral       | — (hero app icon)         | Canary `#F0C040`      | `canary.png`         |
| `:canary-pass:`    | GO / passing          | green                     | Pass green `#28C840`  | `canary-pass.png`    |
| `:canary-cry:`     | NO-GO / failed        | red                       | Fail red `#E24B4A`    | `canary-cry.png`     |
| `:canary-flaky:`   | advisory / flaky      | amber                     | `#D4A820` / `#C09018` | `canary-flaky.png`   |
| `:canary-running:` | in progress           | yellow (pulsing sonar)    | Canary `#F0C040`      | `canary-running.gif` |
| `:canary-skip:`    | skipped / quarantined | grey, dashed (no verdict) | `#7C7C7C` / `#6A6A6A` | `canary-skip.png`    |

## Uploading to Slack

Workspace → _Customize_ → _Emoji_ → _Add Emoji_. Upload each file and name it
with the filename minus its extension (e.g. `canary-pass`). `:canary-running:`
is a GIF and animates in-channel.

## Regenerating

Sources are plain SVG (raster them at 128×128 with any SVG renderer). The
animated `:canary-running:` frames are generated with the sonar-pulse script;
geometry and colors trace directly to `../brand-kit.md`.
