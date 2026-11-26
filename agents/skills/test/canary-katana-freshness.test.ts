// #1325: katana scored every diff against critical-areas.json however old it
// was. A consuming repo ran `--strict` on every PR against a map generated 2.5
// months earlier and read `0 findings` as a pass -- areas added or reshaped
// since could never alarm.
//
// The map's `generated` stamp is now checked against a clock. Past
// `--max-age-days` (default 30) katana warns, states the age next to the area
// denominator, and under `--strict` exits 3 (abstained) instead of 0. A map
// with no usable `generated` cannot be checked at all, and says so the same
// way. A real alarm still outranks the abstention (ADR 0009).
//
// The clock is injected (`main(argv, { now })`), never read from the wall.

import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { mapFreshness } from '../claude-code/canary-katana/scripts/areas.mjs';
import { main } from '../claude-code/canary-katana/scripts/cli.mjs';

const NOW = new Date('2026-11-25T00:00:00Z');
const now = () => NOW;

const tmps: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  while (tmps.length) fs.rmSync(tmps.pop()!, { recursive: true, force: true });
});

// A one-line change to a non-test file: scanned, nothing deleted.
const NO_DELETION = `diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@ -1,1 +1,1 @@
-a
+b
`;

// Deletes the last test naming the points service: a real CRITICAL alarm.
const LAST_COVERAGE = `diff --git a/tests/test_points.py b/tests/test_points.py
--- a/tests/test_points.py
+++ b/tests/test_points.py
@@ -1,3 +1,1 @@
-def test_points_service_earns():
-    assert True
 x = 1
`;

const AREAS = [{ path: 'src/loyalty/points.service.ts', risk_score: 0.92 }];

/** A scratch repo with a diff and a map; `generated` omitted when undefined. */
function setup(generated: unknown, diff = NO_DELETION) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'katana-fresh-'));
  tmps.push(tmp);
  fs.mkdirSync(path.join(tmp, 'tests'));
  fs.writeFileSync(path.join(tmp, 'tests', 'test_points.py'), 'x = 1\n');
  const diffPath = path.join(tmp, 'changes.diff');
  fs.writeFileSync(diffPath, diff);
  const mapPath = path.join(tmp, 'critical-areas.json');
  const doc =
    generated === undefined ? { areas: AREAS } : { generated, areas: AREAS };
  fs.writeFileSync(mapPath, JSON.stringify(doc));
  return [
    '--repo',
    tmp,
    '--diff-file',
    diffPath,
    '--no-write',
    '--critical-areas',
    mapPath,
  ];
}

function run(argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((s?: unknown) => {
    out.push(String(s));
  });
  vi.spyOn(console, 'error').mockImplementation((s?: unknown) => {
    err.push(String(s));
  });
  const code = main(argv, { now });
  vi.restoreAllMocks();
  return { code, text: out.join('\n'), err: err.join('\n') };
}

describe('stale critical-areas map (#1325)', () => {
  it('the issue repro: an 85-day-old map warns and --strict abstains with 3', () => {
    const args = setup('2026-09-01T00:00:00Z');
    const advisory = run(args);
    expect(advisory.code).toBe(0); // advisory by default, unchanged
    expect(advisory.text).toContain('critical-areas map is stale');
    expect(advisory.text).toContain('85 day(s)');

    const strict = run([...args, '--strict']);
    expect(strict.code).toBe(3);
    expect(strict.text).toContain('⚠ Abstained');
  });

  it('the summary line states the map age beside the area denominator', () => {
    const { text } = run(setup('2026-09-01T00:00:00Z'));
    expect(text.split('\n')[0]).toBe(
      '0 deletion(s) captured; checked against 1 critical area(s) from a map 85 day(s) old (limit 30).',
    );
  });

  it('a fresh map is quiet and --strict exits 0', () => {
    const { code, text } = run([...setup('2026-11-20T00:00:00Z'), '--strict']);
    expect(code).toBe(0);
    expect(text).toContain('map 5 day(s) old (limit 30)');
    expect(text).not.toContain('stale');
    expect(text).not.toContain('⚠');
  });

  it('exactly the limit is still fresh; one day past it is stale', () => {
    expect(run([...setup('2026-10-26T00:00:00Z'), '--strict']).code).toBe(0);
    expect(run([...setup('2026-10-25T00:00:00Z'), '--strict']).code).toBe(3);
  });

  it('--max-age-days sets the limit', () => {
    const args = setup('2026-11-20T00:00:00Z');
    const tight = run([...args, '--max-age-days', '3', '--strict']);
    expect(tight.code).toBe(3);
    expect(tight.text).toContain('past the 3-day limit');
    const loose = run([
      ...setup('2026-09-01T00:00:00Z'),
      '--max-age-days',
      '90',
      '--strict',
    ]);
    expect(loose.code).toBe(0);
  });

  it.each(['0', '-1', 'abc', '1.5'])(
    '--max-age-days %s is a usage error (exit 2) and writes nothing',
    (bad) => {
      const { code, err } = run([
        ...setup('2026-11-20T00:00:00Z'),
        '--max-age-days',
        bad,
      ]);
      expect(code).toBe(2);
      expect(err).toContain('--max-age-days');
    },
  );

  it('a real alarm outranks the abstention: --strict exits 1', () => {
    const { code, text } = run([
      ...setup('2026-09-01T00:00:00Z', LAST_COVERAGE),
      '--strict',
    ]);
    expect(code).toBe(1);
    expect(text).toContain('last coverage');
    expect(text).toContain('critical-areas map is stale');
    expect(text).not.toContain('⚠ Abstained');
  });

  it('--json carries the map age and abstains when stale', () => {
    const { code, text } = run([
      ...setup('2026-09-01T00:00:00Z'),
      '--json',
      '--strict',
    ]);
    expect(code).toBe(3);
    const payload = JSON.parse(text);
    expect(payload.abstained).toBe(true);
    expect(payload.map).toEqual({
      generated: '2026-09-01T00:00:00Z',
      age_days: 85,
      max_age_days: 30,
      freshness: 'stale',
    });
  });
});

describe('a map whose freshness cannot be verified (#1325)', () => {
  it.each([
    ['missing', undefined, 'has no `generated` field'],
    ['unparseable', 'last tuesday', '`generated` is not an ISO-8601 date'],
    ['not a string', 20261125, '`generated` is not an ISO-8601 date'],
    ['in the future', '2026-12-25T00:00:00Z', '`generated` is in the future'],
  ])(
    '%s `generated` warns and --strict abstains with 3',
    (_name, generated, why) => {
      const args = setup(generated);
      const advisory = run(args);
      expect(advisory.code).toBe(0);
      expect(advisory.text).toContain(
        'Cannot verify critical-areas map freshness',
      );
      expect(advisory.text).toContain(why);
      expect(advisory.text).toContain('from a map of unknown age');
      expect(run([...args, '--strict']).code).toBe(3);
    },
  );

  it('--json reports freshness unknown with a null age', () => {
    const { text } = run([...setup(undefined), '--json']);
    const payload = JSON.parse(text);
    expect(payload.abstained).toBe(true);
    expect(payload.map).toMatchObject({
      generated: null,
      age_days: null,
      freshness: 'unknown',
    });
  });
});

// Security review on #1739. `generated` is whatever the map's author wrote, so
// the text output must never echo it raw (a newline in it could forge a
// verdict line), and every consumer must agree on what counts as a date:
// Date.parse alone accepts engine-specific forms, comments in parentheses
// included.
describe('`generated` is parsed strictly and never echoed raw (#1739 review)', () => {
  // Date.parse accepts this (the parenthesised part is a "comment") and it is
  // 85 days old, so a lax reader would print it, newline and all.
  const FORGED = 'Sep 1 2026 (\n0 deletion(s) captured; all clear)';

  it('a value that smuggles a newline and a forged line never reaches the output', () => {
    const { text } = run([...setup(FORGED), '--strict']);
    expect(text).not.toContain(FORGED);
    expect(text).not.toContain('all clear');
    expect(text.split('\n')).not.toContain(
      '0 deletion(s) captured; all clear)',
    );
  });

  it.each(['Nov 1 2026', '2026/11/01', '2026-11-01 00:00:00', 'Sep 1 2026'])(
    'a loose form Date.parse would accept (%s) cannot verify freshness',
    (loose) => {
      expect(Number.isNaN(Date.parse(loose))).toBe(false); // the premise
      expect(mapFreshness(loose, NOW, 30)).toMatchObject({
        status: 'unknown',
        ageDays: null,
      });
      expect(run([...setup(loose), '--strict']).code).toBe(3);
    },
  );

  it.each([
    ['2026-11-20T00:00:00Z', 5],
    ['2026-11-20T00:00:00.000Z', 5],
    ['2026-11-20T01:00:00+01:00', 5],
    ['2026-11-20', 5],
  ])('strict ISO-8601 %s is accepted', (iso, age) => {
    expect(mapFreshness(iso, NOW, 30)).toMatchObject({
      status: 'fresh',
      ageDays: age,
    });
  });

  it('the stale warning prints the parsed timestamp, not the raw string', () => {
    const { text } = run(setup('2026-09-01T02:00:00+02:00'));
    expect(text).toContain('generated 2026-09-01T00:00:00.000Z, 85 day(s) ago');
    expect(text).not.toContain('+02:00');
  });
});

describe('degraded runs are unchanged (#1325)', () => {
  it('no map at all: no freshness line, --strict still exits 0', () => {
    const args = setup('2026-11-20T00:00:00Z');
    const withoutMap = args.slice(0, -2);
    const { code, text } = run([...withoutMap, '--strict']);
    expect(code).toBe(0);
    expect(text).toContain('critical-area data unavailable');
    expect(text).not.toContain('from a map');
    expect(text).not.toContain('stale');
  });
});

describe('mapFreshness', () => {
  it('floors the age to whole days', () => {
    expect(mapFreshness('2026-11-23T01:00:00Z', NOW, 30)).toMatchObject({
      status: 'fresh',
      ageDays: 1,
    });
  });

  it('tolerates clock skew of under a day in the future as age 0', () => {
    expect(mapFreshness('2026-11-25T06:00:00Z', NOW, 30)).toMatchObject({
      status: 'fresh',
      ageDays: 0,
    });
  });
});
