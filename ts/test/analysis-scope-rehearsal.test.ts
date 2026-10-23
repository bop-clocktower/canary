/**
 * Live rehearsals of what the architecture gates actually analyse (#1443).
 *
 * `harness-config-denominator.test.ts` proves offline that the layer patterns
 * cover the source roots. That is a statement about our glob reading, not
 * about the harness CLI. This file asks the real CLI, on a throwaway project
 * built from the real `harness.config.json`, the two questions #1443 found
 * answered wrongly:
 *
 * 1. Does `harness check-deps` read `npm/src`? It analyses exactly the union
 *    of files the layer patterns match, and no pattern matched `npm/src`, so it
 *    reported 468 modules and passed with a cycle planted there. The
 *    denominator here is the module count it prints, which must equal the
 *    tracked `npm/src` count, and a planted cycle or layer breach must fail it.
 *
 * 2. Do the arch and entropy analyzers skip test fixtures? A deliberately
 *    broken fixture (cycle, dead exports, oversized module) moved both
 *    blocking ratchets, dot-directories included: the arch walker matches
 *    excludes with `dot: true`, the entropy one without, so `**​/test/fixtures/**`
 *    alone leaves `.dir/` fixtures counted by entropy. A planted fixture must
 *    leave every count where it was, AND the same plant under `ts/src` must
 *    move them — without that positive control, "nothing moved" could just as
 *    well mean the instrument saw nothing.
 *
 * Runs only where the harness CLI is on PATH (local, or `HARNESS_BIN`). The
 * `ts-validate` CI job does not install it, so there this file abstains out
 * loud rather than passing on nothing; the offline half still runs there.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { reportAbstention, reportVerified } from './abstention-testkit.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HARNESS = process.env.HARNESS_BIN ?? 'harness';

function harnessAvailable(): boolean {
  const probe = spawnSync(HARNESS, ['--version'], { encoding: 'utf-8' });
  return !probe.error && probe.status === 0;
}

const LIVE = harnessAvailable();
if (!LIVE) {
  reportAbstention(
    'analysis-scope',
    `harness CLI not found (${HARNESS}); the live check-deps, check-arch and ` +
      'cleanup rehearsals did not run. Nothing about what those gates read ' +
      'was proven here.',
  );
}

interface Harness {
  status: number;
  stdout: string;
  out: string;
}

function harness(cwd: string, args: string[]): Harness {
  const r = spawnSync(HARNESS, args, { cwd, encoding: 'utf-8' });
  if (r.error) throw r.error;
  return {
    status: r.status ?? 1,
    stdout: r.stdout,
    out: `${r.stdout}${r.stderr}`,
  };
}

const REAL_CONFIG = JSON.parse(
  readFileSync(join(REPO_ROOT, 'harness.config.json'), 'utf-8'),
) as {
  architecture?: unknown;
  entropy?: { excludePatterns?: string[] };
};

const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

function project(config: object, files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'analysis-scope-'));
  tempDirs.push(dir);
  writeFileSync(join(dir, 'harness.config.json'), JSON.stringify(config));
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(join(dir, dirname(file)), { recursive: true });
    writeFileSync(join(dir, file), text);
  }
  execFileSync('git', ['init', '-q'], { cwd: dir });
  return dir;
}

/** A broken module set: a value cycle, a dead export, and one over-size file. */
function brokenModule(at: string): Record<string, string> {
  const big = Array.from(
    { length: 2000 },
    (_, i) => `export const v${i} = ${i};`,
  ).join('\n');
  return {
    [`${at}/a.ts`]: "import { b } from './b.js';\nexport const a = () => b;\n",
    [`${at}/b.ts`]: "import { a } from './a.js';\nexport const b = () => a;\n",
    [`${at}/big.ts`]: `${big}\n`,
  };
}

describe.skipIf(!LIVE)(
  'fixtures are outside the arch and entropy denominators (#1443)',
  () => {
    // The real exclusion config, on a project small enough to run in a second.
    // Layers and entry points are replaced because the real ones name files
    // that do not exist here; the keys under test are copied verbatim.
    const config = {
      version: 1,
      name: 'analysis-scope-rehearsal',
      layers: [{ name: 'src', pattern: 'ts/src/**', allowedDependencies: [] }],
      architecture: REAL_CONFIG.architecture,
      entropy: {
        excludePatterns: REAL_CONFIG.entropy?.excludePatterns,
        entryPoints: ['ts/src/main.ts'],
      },
    };
    const SOURCE = {
      'ts/src/main.ts':
        "import { used } from './lib.js';\nconsole.log(used);\n",
      'ts/src/lib.ts': 'export const used = 1;\n',
    };
    const FIXTURE_PLANTS = [
      'ts/test/fixtures/planted',
      'ts/test/fixtures/.planted-dot',
      'ts/test/fixtures/nested/.planted-dot',
      'agents/skills/test/fixtures/planted',
    ];

    /** Every arch category value plus the entropy finding count. */
    function counts(dir: string): Record<string, number> {
      const arch = harness(dir, ['check-arch', '--json']);
      const report = JSON.parse(arch.stdout) as {
        measurements: Array<{ category: string; value: number }>;
      };
      const out: Record<string, number> = {};
      for (const m of report.measurements) {
        out[m.category] = (out[m.category] ?? 0) + m.value;
      }
      const cleanup = harness(dir, ['cleanup', '--findings-json']);
      const line = /\{"findings":(\d+)[^\n]*"check":"cleanup"\}/.exec(
        cleanup.out,
      );
      // A missing contract line is an abstention, never a zero.
      expect(line, `no cleanup contract line:\n${cleanup.out}`).not.toBeNull();
      out.entropy = Number(line![1]);
      return out;
    }

    // Measured in beforeAll, not at collection: a skipped suite's body still
    // runs to register its tests, and must not spawn a CLI that is not there.
    let base: Record<string, number> = {};
    beforeAll(() => {
      base = counts(project(config, SOURCE));
    });

    it('measures a non-empty base (the instrument read the source)', () => {
      expect(base['module-size']).toBeGreaterThan(0);
    });

    it('a broken module under ts/src moves the counts (positive control)', () => {
      const planted = counts(
        project(config, { ...SOURCE, ...brokenModule('ts/src/planted') }),
      );
      expect(planted['circular-deps']).toBeGreaterThan(base['circular-deps']!);
      expect(planted.entropy).toBeGreaterThan(base.entropy!);
      expect(planted['module-size']).toBeGreaterThan(base['module-size']!);
    });

    it('the same breakage planted as fixtures, dot-dirs included, moves nothing', () => {
      const files: Record<string, string> = { ...SOURCE };
      for (const at of FIXTURE_PLANTS) Object.assign(files, brokenModule(at));
      expect(counts(project(config, files))).toEqual(base);
      reportVerified(
        'analysis-scope',
        `${FIXTURE_PLANTS.length} broken fixture dirs planted, counts unchanged`,
      );
    });
  },
);

describe.skipIf(!LIVE)('check-deps reads npm/src (#1443)', () => {
  const npmFiles = execFileSync('git', ['ls-files', '-z', 'npm/src'], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
  })
    .split('\0')
    .filter((f) => f.endsWith('.ts'));

  /** A temp copy of npm/src under the real config, plus `extra` files. */
  function npmProject(extra: Record<string, string> = {}): string {
    const dir = project(
      JSON.parse(readFileSync(join(REPO_ROOT, 'harness.config.json'), 'utf-8')),
      extra,
    );
    for (const f of npmFiles) {
      mkdirSync(join(dir, dirname(f)), { recursive: true });
      copyFileSync(join(REPO_ROOT, f), join(dir, f));
    }
    return dir;
  }

  it('has a non-empty npm/src denominator', () => {
    expect(npmFiles.length).toBeGreaterThan(0);
  });

  /**
   * The count check-deps prints. Upstream counts every path a layer glob
   * matches, and a `**` glob matches directories too, so this is the tracked
   * file count PLUS the directories under npm/src (3 today). Hence the
   * assertions below are `>=` the file count and exact only as a delta.
   */
  function analysed(out: string): number {
    const m = /Analyzed (\d+) module/.exec(out);
    expect(m, out).not.toBeNull();
    return Number(m![1]);
  }

  let baseCount = 0;
  beforeAll(() => {
    baseCount = analysed(harness(npmProject(), ['check-deps']).out);
  });

  it('analyses every npm/src module and passes on the real tree', () => {
    const r = harness(npmProject(), ['check-deps']);
    expect(analysed(r.out)).toBeGreaterThanOrEqual(npmFiles.length);
    expect(r.status, r.out).toBe(0);
  });

  it.each([
    {
      shape: 'a value cycle',
      files: {
        'npm/src/planted-a.ts':
          "import { b } from './planted-b.js';\nexport const a = () => b;\n",
        'npm/src/planted-b.ts':
          "import { a } from './planted-a.js';\nexport const b = () => a;\n",
      },
    },
    {
      shape: 'an `import type` cycle',
      files: {
        'npm/src/planted-a.ts':
          "import type { B } from './planted-b.js';\nexport type A = B[];\n",
        'npm/src/planted-b.ts':
          "import type { A } from './planted-a.js';\nexport type B = A[];\n",
      },
    },
    {
      shape: 'the published reporter importing the runtime CLI',
      files: {
        'npm/src/reporters/planted-breach.ts':
          "import { flavorOn } from '../voice.js';\nexport const x = flavorOn;\n",
      },
    },
  ])('fails on $shape planted in npm/src', ({ files }) => {
    const r = harness(npmProject(files), ['check-deps']);
    expect(r.status, r.out).not.toBe(0);
    // A non-zero exit alone also covers "analysed 0 modules, refusing to
    // report clean" — the abstention this issue is about. The failure must
    // be the plant itself, over a full denominator.
    // Every plant goes in an existing directory, so the delta is exact.
    expect(analysed(r.out) - baseCount).toBe(Object.keys(files).length);
    expect(r.out).toMatch(/planted-(a|b|breach)\.ts/);
  });
});
