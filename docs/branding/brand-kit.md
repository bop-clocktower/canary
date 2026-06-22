# Canary Brand Kit

Brand assets and snippets for Canary. The icon variants live in
[`docs/assets/`](../assets/); this file holds the badge snippets, color
tokens, and the demo slide template reference.

<!-- markdownlint-disable MD013 -->
<!-- Badge URLs are intentionally long (shields.io query strings). -->

<!-- Badge row — paste these at the top of your README -->
<!-- Shields.io badges styled to match Canary brand tokens -->

![version](https://img.shields.io/badge/version-5.3.0-F0C040?style=flat-square&labelColor=0A0A0A&color=F0C040&logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAzMiAzMiI+PHBvbHlnb24gcG9pbnRzPSI3LDI2IDEzLDE0IDIwLDEzIDIxLDI0IDE2LDI5IDksMzAiIGZpbGw9IiNGMEMwNDAiLz48Y2lyY2xlIGN4PSI3IiBjeT0iMjAiIHI9IjUiIGZpbGw9IiNGMEMwNDAiLz48L3N2Zz4=)
![python](https://img.shields.io/badge/python-3.11+-F5F5F5?style=flat-square&labelColor=1C1C1C&color=2E2E2E)
![tests](https://img.shields.io/badge/tests-passing-28C840?style=flat-square&labelColor=1C1C1C&color=1C1C1C&logo=checkmarx&logoColor=28C840)
![frameworks](https://img.shields.io/badge/playwright_·_vitest_·_pytest-F0C040?style=flat-square&labelColor=C09018&color=F0C040&logoColor=0A0A0A)
![license](https://img.shields.io/badge/license-MIT-555?style=flat-square&labelColor=1C1C1C&color=2E2E2E)

---

<!-- Alt: raw HTML badges (more control, works in GitHub README) -->
<!--
<p align="left">
  <img src="https://img.shields.io/badge/canary-v5.3.0-F0C040?style=flat-square&labelColor=0A0A0A" alt="version"/>
  <img src="https://img.shields.io/badge/python-3.11+-F5F5F5?style=flat-square&labelColor=1C1C1C&color=2E2E2E" alt="python"/>
  <img src="https://img.shields.io/badge/tests-passing-28C840?style=flat-square&labelColor=1C1C1C&color=1C1C1C&logoColor=28C840" alt="tests passing"/>
  <img src="https://img.shields.io/badge/playwright_·_vitest_·_pytest-0A0A0A?style=flat-square&labelColor=C09018&color=F0C040" alt="frameworks"/>
  <img src="https://img.shields.io/badge/license-MIT-555?style=flat-square&labelColor=1C1C1C&color=2E2E2E" alt="MIT license"/>
</p>
-->

---

## Color tokens (for shields.io / custom badge use)

| Token      | Hex       | Use                        |
|------------|-----------|----------------------------|
| Obsidian   | `0A0A0A`  | labelColor (primary)       |
| Ash        | `1C1C1C`  | labelColor (secondary)     |
| Smoke      | `2E2E2E`  | labelColor (tertiary)      |
| Canary     | `F0C040`  | color (accent badges)      |
| Amber      | `C09018`  | color (framework badge)    |
| Platinum   | `F5F5F5`  | color (text-on-dark badge) |
| Pass green | `28C840`  | logoColor (CI status)      |
| Fail red   | `E24B4A`  | logoColor (CI fail)        |

---

## Usage in shields.io URL pattern

```text
https://img.shields.io/badge/{label}-{message}-{color}?style=flat-square&labelColor={labelColor}
```

Note: spaces in label/message → replace with `_`
