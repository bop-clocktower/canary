// canary-katana proximity, review round on #1242 (PR #1246).
//
// Each block reproduces one review finding: a false CRITICAL that main does not
// produce, a silent false green, or a too-broad "at stake". Layouts are neutral
// stand-ins for real monorepo shapes.

import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as diffscan from '../claude-code/canary-katana/scripts/diffscan.mjs';
import * as alarm from '../claude-code/canary-katana/scripts/alarm.mjs';
import { main } from '../claude-code/canary-katana/scripts/cli.mjs';

const tmps: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  while (tmps.length) fs.rmSync(tmps.pop()!, { recursive: true, force: true });
});

type Area = Record<string, unknown>;

/** A scratch repo with `files` and a critical-areas.json holding `areas`. */
function repo(files: Record<string, string>, areas: Area[]) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'katana-prox-'));
  tmps.push(tmp);
  for (const [rel, text] of Object.entries(files)) {
    const p = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
  }
  const areasPath = path.join(tmp, 'critical-areas.json');
  fs.writeFileSync(areasPath, JSON.stringify({ areas }));
  return { tmp, areasPath };
}

/** A diff deleting the whole of `file`, whose lines were `lines`. */
const delFile = (
  file: string,
  lines: string[],
) => `diff --git a/${file} b/${file}
deleted file mode 100644
--- a/${file}
+++ /dev/null
@@ -1,${lines.length} +0,0 @@
${lines.map((l) => `-${l}`).join('\n')}
`;

/** A diff removing one line from `file`, which keeps `const keep = 1;`. */
const delLine = (file: string, line: string) => `diff --git a/${file} b/${file}
--- a/${file}
+++ b/${file}
@@ -1,2 +1,1 @@
-${line}
 const keep = 1;
`;

function verdict(
  files: Record<string, string>,
  areas: Area[],
  diff: string,
): {
  findings: { test: string; area: string; severity: { value: string } }[];
  total: number;
  notAssessed: { area: string; reason: string; atStake: boolean }[];
} {
  const { tmp, areasPath } = repo(files, areas);
  return alarm.assess(
    diffscan.findDeletions(diff),
    alarm.loadCriticalAreas(areasPath),
    tmp,
    diff,
  );
}

const summary = (v: ReturnType<typeof verdict>) => ({
  findings: v.findings.map((f) => `${f.severity.value} ${f.test} -> ${f.area}`),
  notAssessed: v.notAssessed.map(
    (n) => `${n.area} ${n.reason} atStake=${n.atStake}`,
  ),
});

const AREA = (p: string, extra: Area = {}) => [
  { path: p, risk_score: 0.9, ...extra },
];

/** Run the real CLI over a scratch repo; returns exit code and stdout. */
function cli(
  files: Record<string, string>,
  areas: Area[] | null,
  diff: string,
  flags: string[],
) {
  const { tmp, areasPath } = repo(files, areas ?? []);
  if (areas === null)
    fs.writeFileSync(areasPath, JSON.stringify({ areas: [] }));
  const df = path.join(tmp, 'changes.diff');
  fs.writeFileSync(df, diff);
  const out: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    out.push(a.join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
    out.push(a.join(' '));
  });
  const code = main([
    '--repo',
    tmp,
    '--diff-file',
    df,
    '--no-write',
    '--critical-areas',
    areasPath,
    ...flags,
  ]);
  return { code, text: out.join('\n') };
}

// --- finding 1: the deleted test must be near the area too ------------------

describe('a deletion must relate to the area by proximity (finding 1)', () => {
  it('a far unrelated deletion named for the symbol does not alarm', () => {
    // The area's own tests are intact; they import it, and their titles do not
    // say "engine". Deleting an unrelated far-away "engine signal" test used to
    // read as the area losing its last coverage: a false CRITICAL.
    const v = verdict(
      {
        'src/__tests__/engine.test.ts':
          "import { award } from '../engine';\nit('awards points on purchase', () => {});\n",
        'apps/web/__tests__/other.test.tsx':
          "it('engine warmup banner', () => {});\n",
      },
      AREA('src/engine.ts'),
      delFile('apps/web/__tests__/providers.engine-signal.test.tsx', [
        "it('engine signal', () => {});",
      ]),
    );
    expect(summary(v)).toEqual({ findings: [], notAssessed: [] });
  });

  it('a far deletion named for the symbol does not alarm on an uncovered area', () => {
    // The area has no tests of its own at all. The deleted far test only
    // shares a word with it, so it was never the area's coverage (M23).
    const v = verdict(
      {},
      AREA('src/engine.ts'),
      delFile('apps/web/__tests__/providers.engine-signal.test.tsx', [
        "it('engine signal', () => {});",
      ]),
    );
    expect(summary(v)).toEqual({ findings: [], notAssessed: [] });
  });

  it('a nearby file named for the area covers it without an import, whatever its titles', () => {
    // Python-style: tests/test_engine.py beside src/ reaches the module through
    // sys.path, so there is no import katana can tie to src/engine.py (M24).
    const v = verdict(
      {
        'tests/test_engine.py':
          'def test_awards_points():\n    pass\nconst keep = 1;\n',
      },
      AREA('src/engine.py'),
      delLine('tests/test_engine.py', 'def test_engine_handles_refunds():'),
    );
    expect(summary(v)).toEqual({ findings: [], notAssessed: [] });
  });

  it('a file that owns and imports the area still covers it, whatever its titles', () => {
    const v = verdict(
      {
        'src/__tests__/engine.test.ts':
          "import { award } from '../engine';\nit('awards points on purchase', () => {});\nconst keep = 1;\n",
      },
      AREA('src/engine.ts'),
      delLine(
        'src/__tests__/engine.test.ts',
        "it('engine handles refunds', () => {});",
      ),
    );
    expect(summary(v)).toEqual({ findings: [], notAssessed: [] });
  });

  it('the genuine last-coverage deletion still fires CRITICAL', () => {
    const v = verdict(
      { 'other/__tests__/x.test.ts': "it('engine signal', () => {});\n" },
      AREA('src/engine.ts'),
      delFile('src/__tests__/engine.test.ts', [
        "it('engine awards points', () => {});",
      ]),
    );
    expect(summary(v).findings).toEqual([
      'critical engine awards points -> src/engine.ts',
    ]);
  });

  it('a deleted test named for the area relates to it even from a root tests/ dir', () => {
    // The rehearsal shape: tests/test_sprocket.py for src/widgets/sprocket.service.ts.
    const v = verdict(
      {},
      AREA('src/widgets/sprocket.service.ts'),
      delFile('tests/test_sprocket.py', [
        'def test_sprocket_spins_forward():',
        '    assert True',
      ]),
    );
    expect(summary(v).findings).toEqual([
      'critical test_sprocket_spins_forward -> src/widgets/sprocket.service.ts',
    ]);
  });

  it('a far deleted file that imported the area relates to it (read from the diff)', () => {
    const v = verdict(
      {},
      AREA('src/pricing/engine.ts'),
      delFile('e2e/flows/quote.spec.ts', [
        "import { quote } from '../../src/pricing/engine';",
        "it('engine quotes a cart', () => {});",
      ]),
    );
    expect(summary(v).findings).toEqual([
      'critical engine quotes a cart -> src/pricing/engine.ts',
    ]);
  });
});

// --- finding 2: import matcher gaps ------------------------------------------

describe('import matching (finding 2)', () => {
  const pyDeletion = delFile('app/billing/tests/test_engine.py', [
    'def test_engine_awards():',
    '    pass',
  ]);

  it.each([
    ['import-as', 'import app.billing.engine as eng\n'],
    [
      'import with a trailing comment',
      'import app.billing.engine  # noqa: F401\n',
    ],
    ['from-import-star', 'from app.billing.engine import *\n'],
  ])('python %s still covers the area', (_, line) => {
    const v = verdict(
      {
        'tests/test_checkout.py': `${line}\ndef test_engine_totals():\n    pass\n`,
      },
      AREA('app/billing/engine.py'),
      pyDeletion,
    );
    expect(v.findings).toEqual([]);
  });

  it('python `from pkg import mod` imports pkg.mod', () => {
    // The title does not say "engine": only the direct pkg.mod import can
    // cover the area. `from app.billing` alone is the package (a barrel),
    // which needs a title naming the symbol.
    const v = verdict(
      {
        'tests/test_checkout.py':
          'from app.billing import engine\n\ndef test_totals():\n    pass\n',
      },
      AREA('app/billing/engine.py'),
      pyDeletion,
    );
    expect(v.findings).toEqual([]);
  });

  const engineGone = delFile('packages/core/test/engine.test.ts', [
    "it('engine awards points', () => {});",
  ]);

  it('a package subpath without src covers packages/<pkg>/src/<mod>', () => {
    const v = verdict(
      {
        'apps/web/test/checkout.test.ts':
          "import { quote } from '@acme/core/engine';\nit('engine quotes a cart', () => {});\n",
      },
      AREA('packages/core/src/engine.ts'),
      engineGone,
    );
    expect(v.findings).toEqual([]);
  });

  it('a package path whose second-last segment differs is another module', () => {
    // Matching on the last segment alone would call any `.../engine` import
    // coverage of this area.
    const v = verdict(
      {
        'apps/web/test/checkout.test.ts':
          "import { quote } from '@acme/other/engine';\nit('engine quotes a cart', () => {});\n",
      },
      AREA('packages/core/src/engine.ts'),
      engineGone,
    );
    expect(summary(v).findings).toEqual([
      'critical engine awards points -> packages/core/src/engine.ts',
    ]);
  });

  it('a scoped alias (@app/engine) covers src/engine.ts', () => {
    const v = verdict(
      {
        'packages/web/test/x.test.ts':
          "import { quote } from '@app/engine';\nit('engine quotes', () => {});\n",
      },
      AREA('src/engine.ts'),
      delFile('src/__tests__/engine.test.ts', [
        "it('engine awards points', () => {});",
      ]),
    );
    expect(v.findings).toEqual([]);
  });

  it('a barrel import of the area directory counts as near', () => {
    const v = verdict(
      {
        'test/pricing.test.ts':
          "import { quote } from '../src/pricing';\nit('pricing engine quotes', () => {});\n",
      },
      AREA('src/pricing/engine.ts'),
      delFile('src/pricing/__tests__/engine.test.ts', [
        "it('engine awards points', () => {});",
      ]),
    );
    expect(v.findings).toEqual([]);
  });

  it('an import of the area module as `dir/index` resolves to the area', () => {
    const v = verdict(
      {
        'test/auth.test.ts':
          "import { login } from '../src/auth/index';\nit('auth logs in', () => {});\n",
      },
      AREA('src/auth/index.ts', { symbols: ['auth'] }),
      delFile('src/auth/__tests__/index.test.ts', [
        "it('auth rejects a bad token', () => {});",
      ]),
    );
    expect(v.findings).toEqual([]);
  });

  it.each([["vi.mock('../../src/engine')"], ["jest.mock('../../src/engine')"]])(
    '%s is not an import of the area',
    (mock) => {
      // SKILL.md promises a mock is not coverage: a test that mocks a module
      // does not exercise it.
      const v = verdict(
        {
          'other/__tests__/x.test.ts': `${mock};\nit('engine signal', () => {});\n`,
        },
        AREA('src/engine.ts'),
        delFile('src/__tests__/engine.test.ts', [
          "it('engine awards points', () => {});",
        ]),
      );
      expect(summary(v).findings).toEqual([
        'critical engine awards points -> src/engine.ts',
      ]);
    },
  );
});

// --- finding 3: dotted basenames ----------------------------------------------

describe('dotted basenames (finding 3)', () => {
  it('derives the joined basename and first part, never a role suffix', () => {
    expect([...alarm.areaSymbols('src/billing/invoice.service.ts')]).toEqual([
      'invoice.service',
      'invoice',
    ]);
    expect([...alarm.areaSymbols('src/web/user.controller.ts')]).not.toContain(
      'controller',
    );
  });

  it('a sibling payment.service.spec.ts does not saturate invoice.service.ts', () => {
    const v = verdict(
      {
        'src/billing/payment.service.spec.ts':
          "import { PaymentService } from './payment.service';\ndescribe('PaymentService', () => { it('charges', () => {}); });\n",
        'src/billing/invoice.service.spec.ts':
          "import { InvoiceService } from './invoice.service';\ndescribe('InvoiceService', () => {});\nconst keep = 1;\n",
      },
      AREA('src/billing/invoice.service.ts'),
      delLine(
        'src/billing/invoice.service.spec.ts',
        "  it('InvoiceService totals lines', () => {});",
      ),
    );
    expect(v.notAssessed).toEqual([]);
  });

  it('a basename that is only a role word has no symbol', () => {
    const v = verdict({}, AREA('src/utils.ts'), '');
    expect(summary(v).notAssessed).toEqual([
      'src/utils.ts no-symbol atStake=false',
    ]);
  });

  it('a derived symbol of exactly 4 characters is used; 3 is too short', () => {
    const four = verdict({}, AREA('src/cart.ts'), '');
    expect(four.notAssessed).toEqual([]);
    const three = verdict({}, AREA('src/tax.ts'), '');
    expect(summary(three).notAssessed).toEqual([
      'src/tax.ts no-symbol atStake=false',
    ]);
  });
});

// --- finding 4: at stake for areas that can never be assessed ----------------

describe('at stake for unassessable areas (finding 4)', () => {
  it('any root tests/ deletion does not put a no-symbol area at stake', () => {
    const { code, text } = cli(
      { 'tests/users.test.ts': "it('lists users', () => {});\n" },
      AREA('src/db.ts'),
      delFile('tests/checkout.test.ts', ["it('totals a cart', () => {});"]),
      ['--strict'],
    );
    expect(code).toBe(0);
    expect(text).toContain('src/db.ts: ');
    expect(text).not.toContain('[at stake in this diff]');
  });

  it('a deleted test named for the no-symbol area puts it at stake', () => {
    const v = verdict(
      {},
      AREA('src/db.ts'),
      delFile('tests/db.test.ts', ["it('connects', () => {});"]),
    );
    expect(summary(v).notAssessed).toEqual([
      'src/db.ts no-symbol atStake=true',
    ]);
  });

  it('a deleted test that imported the no-symbol area puts it at stake', () => {
    const v = verdict(
      {},
      AREA('src/db.ts'),
      delFile('tests/users.test.ts', [
        "import { pool } from '../src/db';",
        "it('lists users', () => {});",
      ]),
    );
    expect(summary(v).notAssessed).toEqual([
      'src/db.ts no-symbol atStake=true',
    ]);
  });
});

// --- finding 5: an anchor name reused elsewhere --------------------------------

describe('the anchor is a path suffix, not any segment (finding 5)', () => {
  it('an unrelated services/ dir elsewhere neither covers nor exempts (probe J)', () => {
    const v = verdict(
      {
        'apps/web/services/__tests__/engine-signal.test.tsx':
          "it('engine signal', () => {});\n",
      },
      AREA('packages/api/services/engine.ts'),
      delFile('packages/api/services/__tests__/engine.test.ts', [
        "it('engine awards points', () => {});",
      ]),
    );
    expect(v.findings.length + v.notAssessed.length).toBeGreaterThan(0);
    expect(summary(v).findings).toEqual([
      'critical engine awards points -> packages/api/services/engine.ts',
    ]);
  });

  it('a mirrored test tree is still near (tests/<feature>/ for src/<feature>/)', () => {
    const v = verdict(
      {
        'packages/core/test/engine.refund.test.ts':
          "it('engine refunds', () => {});\n",
      },
      AREA('packages/core/src/engine.ts'),
      delFile('packages/core/test/engine.test.ts', [
        "it('engine awards points', () => {});",
      ]),
    );
    expect(v.findings).toEqual([]);
  });

  it('the anchor is the deepest significant directory', () => {
    // packages/api/src/rollups/engine.ts: `rollups`, not `api`. A test under
    // another api/ feature dir is not near the area.
    const v = verdict(
      {
        'packages/api/src/ledger/__tests__/ledger.test.ts':
          "it('ledger engine posts', () => {});\n",
      },
      AREA('packages/api/src/rollups/engine.ts'),
      delFile('packages/api/src/rollups/__tests__/engine.test.ts', [
        "it('engine rolls up', () => {});",
      ]),
    );
    expect(summary(v).findings).toEqual([
      'critical engine rolls up -> packages/api/src/rollups/engine.ts',
    ]);
  });

  it('a far test named for the area does not exempt itself from saturation', () => {
    // ownsTest exempts only a strongly-near file: same directory or the area's
    // own test directory. `tests/` beside src/ is near but not the area's own.
    const v = verdict(
      { 'tests/engine-signal.test.ts': "it('engine signal', () => {});\n" },
      AREA('src/engine.ts'),
      '',
    );
    expect(summary(v).notAssessed).toEqual([
      'src/engine.ts symbol-saturated atStake=false',
    ]);
  });

  it('a test in the area own test dir named for it is exempt', () => {
    const v = verdict(
      {
        'src/__tests__/engine-signal.test.ts':
          "it('engine signal', () => {});\n",
      },
      AREA('src/engine.ts'),
      '',
    );
    expect(v.notAssessed).toEqual([]);
  });
});

// --- finding 6: an empty areas list is a zero denominator --------------------

describe('an empty areas list (finding 6)', () => {
  const diff = delFile('src/__tests__/engine.test.ts', [
    "it('engine awards points', () => {});",
  ]);

  it('--strict with captured deletions abstains with exit 3', () => {
    const { code, text } = cli({}, null, diff, ['--strict']);
    expect(code).toBe(3);
    expect(text).toContain('⚠ Abstained');
    expect(text).toContain('lists 0 areas');
  });

  it('json says abstained and 0 areas', () => {
    const { text } = cli({}, null, diff, ['--json']);
    const payload = JSON.parse(text);
    expect(payload.abstained).toBe(true);
    expect(payload.areas).toEqual({ total: 0, assessed: 0, not_assessed: [] });
  });

  it('with no deletions there is nothing to abstain on', () => {
    const { code } = cli(
      {},
      null,
      `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,1 +1,1 @@
-const a = 1;
+const a = 2;
`,
      ['--strict'],
    );
    expect(code).toBe(0);
  });
});

// --- finding 7: JSON abstained when a finding outranks ------------------------

describe('a finding outranks abstention in JSON too (finding 7, M11)', () => {
  it('abstained is false when an alarm fired beside an at-stake unassessable area', () => {
    const { code, text } = cli(
      {
        'src/__tests__/validator.test.ts':
          "it('validation rules apply', () => {});\n",
      },
      [
        { path: 'src/engine.ts', risk_score: 0.9 },
        { path: 'src/rules.ts', risk_score: 0.9 },
      ],
      delFile('src/__tests__/engine.test.ts', [
        "it('engine awards points', () => {});",
      ]) +
        delFile('src/__tests__/rules.test.ts', [
          "it('rules evaluate', () => {});",
        ]),
      ['--json', '--strict'],
    );
    expect(code).toBe(1);
    const payload = JSON.parse(text);
    expect(payload.findings).toHaveLength(1);
    expect(payload.abstained).toBe(false);
    expect(payload.areas.not_assessed).toMatchObject([
      { area: 'src/rules.ts', reason: 'symbol-saturated', at_stake: true },
    ]);
  });
});

// --- finding 10: risk_score as a numeric string -------------------------------

describe('risk_score back-compat (finding 10)', () => {
  it('a numeric string risk_score is read as before', () => {
    const v = verdict(
      {},
      [{ path: 'src/engine.ts', risk_score: '0.9' }],
      delFile('src/__tests__/engine.test.ts', [
        "it('engine awards points', () => {});",
      ]),
    );
    expect(summary(v)).toEqual({
      findings: ['critical engine awards points -> src/engine.ts'],
      notAssessed: [],
    });
  });

  it('a null or absent risk_score is read as 0 (high, not critical)', () => {
    const v = verdict(
      {},
      [{ path: 'src/engine.ts', risk_score: null }],
      delFile('src/__tests__/engine.test.ts', [
        "it('engine awards points', () => {});",
      ]),
    );
    expect(summary(v).findings).toEqual([
      'high engine awards points -> src/engine.ts',
    ]);
  });
});

// --- #1253: a deletion katana cannot tie to an area ---------------------------
//
// Monorepo shape: services under packages/<pkg>/src/services, integration tests
// in a central packages/<pkg>/test/ that import a server module and drive the
// service over HTTP, with behaviour titles. Deleting every such test used to
// exit 0 with no finding and the area unlisted: "unable to tell" read as clean.

describe('a deletion that cannot be tied to the area abstains (#1253)', () => {
  const WIDGET = 'packages/core/src/services/widgetService.ts';
  const SERVER = "import { app } from '../src/api/httpServer.js';";
  const REMAINING = {
    // Another integration test in the same central dir: proves nothing about
    // the widget service, but used to count as "coverage remains".
    'packages/core/test/health.integration.test.ts': `${SERVER}\nit('responds to health checks', () => {});\n`,
  };
  const httpDeletion = delFile(
    'packages/core/test/widget-links.integration.test.ts',
    [SERVER, "it('creates a link whose page is the run report', () => {});"],
  );

  it('lists the area as not assessed (unlinked) and at stake', () => {
    const v = verdict(REMAINING, AREA(WIDGET), httpDeletion);
    expect(summary(v)).toEqual({
      findings: [],
      notAssessed: [`${WIDGET} unlinked atStake=true`],
    });
  });

  it('--strict exits 3 and names the area, never exit 0', () => {
    const { code, text } = cli(REMAINING, AREA(WIDGET), httpDeletion, [
      '--strict',
    ]);
    expect(code).toBe(3);
    expect(text).toContain(`[unlinked] ${WIDGET} [at stake in this diff]`);
    expect(text).toContain('Abstained on 1 critical area(s)');
  });

  it('--json reports the abstention and the area', () => {
    const { code, text } = cli(REMAINING, AREA(WIDGET), httpDeletion, [
      '--strict',
      '--json',
    ]);
    const doc = JSON.parse(text);
    expect(code).toBe(3);
    expect(doc.abstained).toBe(true);
    expect(doc.findings).toEqual([]);
    expect(doc.areas.not_assessed).toEqual([
      expect.objectContaining({
        area: WIDGET,
        reason: 'unlinked',
        at_stake: true,
      }),
    ]);
  });

  it('a deleted test that imports the area still alarms, whatever its title', () => {
    const v = verdict(
      REMAINING,
      AREA(WIDGET),
      delFile('packages/core/test/widget-links.integration.test.ts', [
        "import { createLink } from '../src/services/widgetService.js';",
        "it('creates a link whose page is the run report', () => {});",
      ]),
    );
    expect(summary(v)).toEqual({
      findings: [
        `critical creates a link whose page is the run report -> ${WIDGET}`,
      ],
      notAssessed: [],
    });
  });

  it('a deleted test named for the symbol and importing the area alarms', () => {
    const v = verdict(
      REMAINING,
      AREA(WIDGET),
      delFile('packages/core/test/widget-links.integration.test.ts', [
        "import { createLink } from '../src/services/widgetService.js';",
        "it('widgetService creates a link', () => {});",
      ]),
    );
    expect(summary(v).findings).toEqual([
      `critical widgetService creates a link -> ${WIDGET}`,
    ]);
  });

  it('a remaining test importing the area keeps it clean (exit 0)', () => {
    const files = {
      ...REMAINING,
      'packages/core/test/widget.unit.test.ts':
        "import { slug } from '../src/services/widgetService.js';\nit('formats a slug', () => {});\n",
    };
    expect(summary(verdict(files, AREA(WIDGET), httpDeletion))).toEqual({
      findings: [],
      notAssessed: [],
    });
    const { code } = cli(files, AREA(WIDGET), httpDeletion, ['--strict']);
    expect(code).toBe(0);
  });

  it('a deletion in another package does not put the area at stake', () => {
    const v = verdict(
      REMAINING,
      AREA(WIDGET),
      delFile('packages/billing/test/invoices.integration.test.ts', [
        SERVER,
        "it('lists invoices', () => {});",
      ]),
    );
    expect(summary(v)).toEqual({ findings: [], notAssessed: [] });
  });

  it('unlinked is reported only when a related test was deleted', () => {
    const v = verdict(
      REMAINING,
      AREA(WIDGET),
      delLine(
        'packages/core/test/health.integration.test.ts',
        "it('x', () => {});",
      ),
    );
    // health.integration.test.ts sits in a shared dir and remains on disk; the
    // deleted line is a test, so the area is at stake -- but a diff with no
    // deletions at all must not list it.
    const none = verdict(REMAINING, AREA(WIDGET), delLine('README.md', 'x'));
    expect(none.notAssessed).toEqual([]);
    expect(v.notAssessed.map((n) => n.reason)).toEqual(['unlinked']);
  });
});

// --- #1255: single-package repo, integration tests in a root test(s)/ ---------
//
// src/services/widgetService.ts and test/widget-links.integration.test.ts share
// no significant directory and are not near, so #1253's "related" missed them
// and deleting every such test exited 0. Decided (2026-10-09, option 2): a
// root test(s)/ deletion is related to an area only when its risk_score is at
// or above 0.7; lower-risk areas keep #1246's rule, so the noise stays bounded.

describe('a root test(s)/ deletion abstains for high-risk areas (#1255)', () => {
  const WIDGET = 'src/services/widgetService.ts';
  const SERVER = "import { app } from '../src/api/httpServer.js';";
  const REMAINING = {
    'test/health.integration.test.ts': `${SERVER}\nit('responds to health checks', () => {});\n`,
  };
  const rootDeletion = (dir: string) =>
    delFile(`${dir}/widget-links.integration.test.ts`, [
      SERVER,
      "it('creates a link whose page is the run report', () => {});",
    ]);
  const risk = (r: number) => AREA(WIDGET, { risk_score: r });

  it('lists a high-risk area as unlinked and at stake', () => {
    const v = verdict(REMAINING, risk(0.9), rootDeletion('test'));
    expect(summary(v)).toEqual({
      findings: [],
      notAssessed: [`${WIDGET} unlinked atStake=true`],
    });
  });

  it('--strict exits 3 for the issue layout', () => {
    const { code, text } = cli(REMAINING, risk(0.9), rootDeletion('test'), [
      '--strict',
    ]);
    expect(code).toBe(3);
    expect(text).toContain(`[unlinked] ${WIDGET} [at stake in this diff]`);
    expect(text).toContain('Abstained on 1 critical area(s)');
    expect(text).toContain(
      `from the root test directory, and ${WIDGET} is high-risk`,
    );
  });

  it('a root tests/ (plural) deletion counts the same', () => {
    const v = verdict({}, risk(0.9), rootDeletion('tests'));
    expect(summary(v).notAssessed).toEqual([`${WIDGET} unlinked atStake=true`]);
  });

  it('exactly 0.7 is high-risk: the boundary abstains', () => {
    const { code } = cli(REMAINING, risk(0.7), rootDeletion('test'), [
      '--strict',
    ]);
    expect(code).toBe(3);
  });

  it('below 0.7 keeps the #1246 rule: unlisted, --strict exits 0', () => {
    const v = verdict(REMAINING, risk(0.69), rootDeletion('test'));
    expect(summary(v)).toEqual({ findings: [], notAssessed: [] });
    const { code, text } = cli(REMAINING, risk(0.69), rootDeletion('test'), [
      '--strict',
    ]);
    expect(code).toBe(0);
    expect(text).not.toContain('[at stake in this diff]');
  });

  it('a remaining test importing the area keeps it clean (exit 0)', () => {
    const files = {
      ...REMAINING,
      'test/widget.unit.test.ts':
        "import { slug } from '../src/services/widgetService.js';\nit('formats a slug', () => {});\n",
    };
    expect(summary(verdict(files, risk(0.9), rootDeletion('test')))).toEqual({
      findings: [],
      notAssessed: [],
    });
  });

  it('a nested test/ dir is not a root test dir', () => {
    const v = verdict(
      {},
      risk(0.9),
      delFile('tools/test/lint.test.ts', ["it('lints', () => {});"]),
    );
    expect(summary(v)).toEqual({ findings: [], notAssessed: [] });
  });
});
