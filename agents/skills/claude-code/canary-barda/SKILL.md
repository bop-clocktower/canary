---
name: canary-barda
description:
  QA site builder. Turns a validated canary.site/1 feed (from canary-starling)
  into a self-contained static site — index.html, site.json and the site kit's
  six panels — that runs under a strict `script-src 'self'` CSP. An invalid feed
  builds nothing; a feed with zero runs still builds but reports ABSTAINED.
  Writes only, never deploys.
cli: scripts/cli.mjs
requires: [node>=20]
---

# Canary Barda

`canary-starling` writes the feed; `canary-barda` turns it into a page. The page
shows six panels — pipeline health, pass rate, failures by area, flaky tests,
pillars, and the skipped/removed register — and every one of them says what it
could not show instead of rendering an empty "all clear".

## What this is not

- **Not a deployer.** It writes a directory. Publishing it is the site
  workflow's job.
- **Not a feed composer.** It reads one `canary.site/1` file; build it with
  `canary-starling`.
- **Not a dashboard server.** No server, database or auth: the output is static
  files.

## Invocation

```bash
canary skills run canary-barda -- \
  --feed site/site.json --out site-out --title "Canary QA"

# Usage and the full flag list (exits 0):
canary skills run canary-barda -- --help
```

| Flag       | Default   | Meaning                                      |
| ---------- | --------- | -------------------------------------------- |
| `--feed`   | required  | a `canary.site/1` feed; validated before use |
| `--out`    | required  | a new or empty directory to build into       |
| `--title`  | `QA site` | page title and heading                       |
| `--strict` | off       | exit 3 when the feed carries zero runs       |

## Output

```text
site-out/
  index.html      six panels, no inline script or style
  site.json       the feed, as validated
  kit/            canary-site.js, model.js, panel.js, panels/, tokens.css, page.css
```

Serve the directory from any static host. `index.html` declares the feed with
`<meta name="canary-feed" content="site.json">`; `kit/canary-site.js` loads it.

## Honest degradation

- **Invalid or unparseable feed:** nothing is written (exit 1), and every
  validation error is printed.
- **Non-empty `--out`:** refused (exit 1). Barda never overwrites a file it did
  not write. An `--out` inside the site kit itself is refused too.
- **A build that fails part-way** (disk full, permissions): barda removes what
  it wrote before exiting 1, so the same command can simply be re-run.
- **Opened from `file://`, or `kit/` not deployed:** the kit cannot run, and
  each panel shows a line saying so instead of an empty box.
- **Zero runs:** the site builds, every run panel abstains on the page, and the
  CLI prints `ABSTAINED` (exit 3 under `--strict`).
- **On the page:** a panel that cannot show something says why, in text, inside
  a live region. No panel shows a composite score (ADR 0036).

## Theming

Panels read only the custom properties in `kit/tokens.css`. Redefine them on
`:root` (or set `data-theme="dark"` / `"light"`) to re-theme. Embedding panels
in an existing site is `canary-vixen`'s job (phase 4).
