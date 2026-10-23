# PHP support: framework detection and two security gates (#1465)

## Problem

canary's engine could not see a PHP repo. None of the 27 registry frameworks was
PHP, and no probe read `composer.json` or `phpunit.xml`. Only the savant and
blackhawk skills (#1106, #1107) and guardian's suffix list knew `.php` existed.

PHP2Shell (CVE-2026-109618 and CVE-2026-109619, CVSS 9.2, unauthenticated RCE,
patched 2026-10-21) made that gap urgent. A team racing the patch needs answers
to two questions a green CI run does not give:

1. **Is the runtime patched?** A matrix pinned to a floating `'8.3'` proves the
   suite passed on _some_ patched PHP. It proves nothing about the PHP that
   production runs.
2. **Are the locked dependencies clean?** `composer audit` exists, but it is
   silent on a missing lockfile, and that silence reads exactly like a clean
   result.

## Decisions

### D1: the framework surface follows the existing probe tiers

`phpunit` and `pest` are registry entries that run through `vendor/bin/*`, the
project-local Composer install. The tiers match the Python path:

- `phpunit.xml(.dist)` is a config probe.
- `composer.json` `require-dev`/`require` is a content probe. Pest is checked
  first, because it depends on phpunit.
- `language: php` falls back to phpunit.

Only `phpunit` gets a scaffold template. `pest --init` owns Pest's, and
duplicating it would drift.

### D2: Pest is a refinement, not a probe-table row

Config probe entries are bare filenames, and the nested walk matches on
basename. A `tests/Pest.php` row can never match nested and breaks that
invariant (`test-shapes.test.ts` caught it). So `classifyConfig` refines a
`phpunit.xml` to `pest` when `tests/Pest.php` sits beside it, the same way it
refines Playwright `e2e_ui` to `api`.

### D3: phpunit is `supported`, not `preferred`

`preferred` ranks first in every language-blind recommendation. Language-blind
is what `canary recommend` always is, because it passes `null` metadata. As
`preferred`, phpunit replaced schemathesis in the top three `api` picks for
every Python and JS user. PHP users reach phpunit through the `phpunit` hint,
the probes and the `php` language filter instead.

### D4: `pest` is not a classifier hint

The hint regex is case-insensitive and leftmost-first. "test the pest-control
booking page with playwright" would hint `pest`. A test pins this.

### D5: the runtime floor skips what the version number cannot prove

The verdict for each runtime:

| Runtime                                                         | Verdict  |
| --------------------------------------------------------------- | -------- |
| Upstream build at or above its branch floor                     | pass     |
| Upstream build below its branch floor                           | finding  |
| Upstream build on 7.4/8.0/8.1 (no upstream release)             | finding  |
| Anything below 7.4, vendor builds included (no fix from anyone) | finding  |
| Vendor build (`8.3.6-1ubuntu…`) on a covered branch             | **skip** |
| Unknown branch, or not a version string                         | **skip** |

Debian and Ubuntu keep the upstream number in `PHP_VERSION` and backport fixes
under their own suffix. Failing a vendor build is a false alarm, and passing it
is a false green. Only the vendor's advisory can answer, so the gate abstains
(#508: unknown is not zero). When it probes a binary, it also reports the
`session.upload_progress.enabled` stopgap state for CVE-2026-109619.

### D6: the audit's denominator is canary's own lockfile count

`composer audit` never says how much it looked at. canary counts `packages` +
`packages-dev` in `composer.lock` before composer runs. Each of these abstains
(exit 3) with the reason and the first fix step:

- the lockfile is missing, empty, unparseable, or unreadable (errno)
- composer cannot run
- composer's output is not an audit report

Abandoned packages are findings. An abandoned framework gets no security
releases, and that is the risk this gate exists to surface.

## Where it lives

- [ts/src/core/php-floor.ts](../../../ts/src/core/php-floor.ts): the advisory
  table and the per-runtime judge (D5).
- [ts/src/core/composer-audit.ts](../../../ts/src/core/composer-audit.ts): the
  lockfile denominator and the audit-report parser (D6).
- [ts/src/php/php-cli.ts](../../../ts/src/php/php-cli.ts): `canary php floor`
  and `canary php audit`, the binary probe and the gate output.

## Out of scope

- Static analysis (Psalm/PHPStan taint) is a separate shape.
- Remote probing of production hosts. `--php-version` takes the versions ops
  report.
- Scanning `composer.json` packages in `MetadataScanner`. `canary recommend`
  passes `null` metadata, so it would have no caller.
