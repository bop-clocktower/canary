/**
 * Contract tests for the `route:*` label vocabulary (#1071).
 *
 * `issue-fleet` computes a route for every triaged issue and then discards it:
 * the routed queue — its terminal artifact, and the contract every downstream
 * fleet consumes — survives only as session transcript. Canary owns the WRITE
 * END of that contract, because the write end is this repository's label
 * vocabulary, not harness's. (The skill itself is vendored under
 * `~/.claude/plugins/marketplaces/harness/` and is overwritten by every CLI
 * release, so there is nothing here to patch.)
 *
 * Two failure shapes are pinned here, because both are the SAME false green
 * one stage apart:
 *
 * 1. **A route computed and dropped.** An issue that falls out of every
 *    population is a silent omission. The partition therefore asserts that its
 *    four buckets SUM to the denominator — an issue cannot vanish without
 *    breaking arithmetic.
 *
 * 2. **A denominator built on `gh issue list --label`.** That filter lags
 *    writes and under-reports; it was observed twice during the run that filed
 *    #1071, where a freshly-applied `fleet:claimed` was missing from a list
 *    query but present on a direct `gh issue view`. A report built on it would
 *    under-count and still look green. `denominator is read off the issues`
 *    below proves the mechanism from the stub's recorded argv, not just from
 *    the number — a number alone could match by coincidence.
 *
 * Run as a subprocess against a `gh` stub, like `backfill-type-labels.test.ts`,
 * so a plain `.mjs` stays out of the typecheck graph. `ROUTE_QUEUE_GH_STUB`
 * points the script at a node stub that records its argv and serves canned
 * responses instead of reaching GitHub.
 */

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runCapture } from './subprocess-testkit.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'route-queue.mjs');
const LIB = join(REPO_ROOT, 'scripts', 'lib', 'route-labels.mjs');

interface RouteLabelsModule {
  ROUTE_PREFIX: string;
  UNROUTABLE: string;
  DESTINATIONS: string[];
  ROUTE_LABELS: string[];
  partitionByRoute: (issues: StubIssue[]) => Partition;
}

interface Partition {
  examined: number;
  routed: { number: number; route: string }[];
  unroutable: { number: number }[];
  untriaged: { number: number }[];
  conflicted: { number: number; routes: string[] }[];
}

interface StubIssue {
  number: number;
  title?: string;
  labels: { name: string }[];
}

const lib = (await import(LIB)) as RouteLabelsModule;

const issue = (n: number, ...labels: string[]): StubIssue => ({
  number: n,
  title: `issue ${n}`,
  labels: labels.map((name) => ({ name })),
});

describe('vocabulary', () => {
  it('is exactly the 13 roster-derived labels, all route:-prefixed', () => {
    expect(lib.ROUTE_LABELS).toHaveLength(13);
    for (const label of lib.ROUTE_LABELS) {
      expect(label.startsWith(lib.ROUTE_PREFIX)).toBe(true);
    }
    expect(new Set(lib.ROUTE_LABELS).size).toBe(13);
  });

  it('covers the six destinations the vendored enum already had', () => {
    // `route, // downstream fleet: adr | roadmap | pr | cicd | test | cleanup`
    // — issue-fleet/SKILL.md:78. Regressing below this breaks existing routes.
    for (const d of ['adr', 'roadmap', 'pr', 'cicd', 'test', 'cleanup']) {
      expect(lib.DESTINATIONS).toContain(d);
    }
  });

  it('covers the four #886 identified as having no legal destination', () => {
    for (const d of ['docs', 'security', 'perf', 'craft']) {
      expect(lib.DESTINATIONS).toContain(d);
    }
  });

  it('excludes the conductor and the producer', () => {
    // fleet-command conducts fleets rather than receiving issues; routing an
    // issue to issue-fleet, which is what computed the route, is a cycle.
    expect(lib.DESTINATIONS).not.toContain('fleet-command');
    expect(lib.DESTINATIONS).not.toContain('issue');
  });

  it('carries unroutable as a label, not as an absence', () => {
    // Absence is ambiguous — "not yet triaged" and "triaged, no destination"
    // are different facts, and collapsing them IS the silent drop.
    expect(lib.ROUTE_LABELS).toContain(lib.UNROUTABLE);
    expect(lib.DESTINATIONS).not.toContain('unroutable');
  });
});

describe('partitionByRoute', () => {
  it('reports a denominator equal to what it was given', () => {
    const p = lib.partitionByRoute([
      issue(1, 'route:test'),
      issue(2),
      issue(3),
    ]);
    expect(p.examined).toBe(3);
  });

  it('never drops an issue: the four populations sum to the denominator', () => {
    const issues = [
      issue(1, 'route:test'),
      issue(2, 'route:docs', 'bug'),
      issue(3, 'route:unroutable'),
      issue(4),
      issue(5, 'route:test', 'route:cleanup'),
      issue(6, 'enhancement'),
    ];
    const p = lib.partitionByRoute(issues);
    const total =
      p.routed.length +
      p.unroutable.length +
      p.untriaged.length +
      p.conflicted.length;
    expect(total).toBe(p.examined);
    expect(p.examined).toBe(6);
  });

  it('names which issues are routed and where', () => {
    const p = lib.partitionByRoute([issue(7, 'route:security')]);
    expect(p.routed).toEqual([{ number: 7, route: 'security' }]);
  });

  it('counts an unroutable issue as unroutable, not as untriaged', () => {
    const p = lib.partitionByRoute([issue(8, 'route:unroutable')]);
    expect(p.unroutable.map((i) => i.number)).toEqual([8]);
    expect(p.untriaged).toHaveLength(0);
  });

  it('treats two route labels as conflicted and refuses to pick one', () => {
    const p = lib.partitionByRoute([issue(9, 'route:test', 'route:cleanup')]);
    expect(p.conflicted).toHaveLength(1);
    const [clash] = p.conflicted;
    expect(clash?.number).toBe(9);
    expect(clash?.routes.slice().sort()).toEqual(['cleanup', 'test']);
    expect(p.routed).toHaveLength(0);
  });

  it('ignores non-route labels when deciding a population', () => {
    const p = lib.partitionByRoute([issue(10, 'bug', 'fleet:claimed')]);
    expect(p.untriaged.map((i) => i.number)).toEqual([10]);
  });
});

describe('route-queue.mjs', () => {
  let dir: string;
  let calls: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'canary-route-'));
    calls = join(dir, 'gh-calls.jsonl');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * A `gh` stub that records argv and serves canned responses.
   *
   * `filtered` is what a `--label` query returns and `unfiltered` is what a
   * bare `issue list` returns. Making them DIFFER is the whole point: it is
   * how a report built on the lagging label filter becomes visible as a wrong
   * denominator rather than a plausible one.
   */
  function stubFor(opts: {
    unfiltered?: StubIssue[];
    filtered?: StubIssue[];
    labels?: string[];
    exitCode?: number;
  }): string {
    const stub = join(dir, 'gh-stub.mjs');
    writeFileSync(
      stub,
      [
        `import { appendFileSync } from 'node:fs';`,
        `const argv = process.argv.slice(2);`,
        `appendFileSync(${JSON.stringify(calls)}, JSON.stringify(argv) + '\\n');`,
        `if (${opts.exitCode ?? 0} !== 0) { process.stderr.write('stub failure\\n'); process.exit(${opts.exitCode ?? 0}); }`,
        `if (argv[0] === 'label' && argv[1] === 'list') {`,
        `  process.stdout.write(JSON.stringify(${JSON.stringify(
          (opts.labels ?? []).map((name) => ({ name })),
        )}));`,
        `} else if (argv[0] === 'issue' && argv[1] === 'list') {`,
        `  const filtered = argv.includes('--label');`,
        `  process.stdout.write(JSON.stringify(filtered ? ${JSON.stringify(
          opts.filtered ?? [],
        )} : ${JSON.stringify(opts.unfiltered ?? [])}));`,
        `} else { process.stdout.write(''); }`,
      ].join('\n'),
    );
    return stub;
  }

  function run(stub: string, args: string[]) {
    return runCapture(process.execPath, [SCRIPT, ...args], {
      env: { ...process.env, ROUTE_QUEUE_GH_STUB: stub },
    });
  }

  function ghCalls(): string[][] {
    if (!existsSync(calls)) return [];
    return readFileSync(calls, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as string[]);
  }

  describe('report', () => {
    it('abstains with exit 3 when it examined zero issues', () => {
      const r = run(stubFor({ unfiltered: [] }), ['report']);
      expect(r.status).toBe(3);
      expect(r.output).toMatch(/ABSTENTION/);
    });

    it('does not print a green-looking pass on a zero denominator', () => {
      const r = run(stubFor({ unfiltered: [] }), ['report']);
      // "0 routed" with a 0 exit is the exact false green this repo keeps
      // closing; the abstention must not read like a clean result.
      expect(r.status).not.toBe(0);
    });

    it('builds the denominator off the issues, never the label filter', () => {
      // The filter under-reports: 1 issue where the tracker really has 4.
      const r = run(
        stubFor({
          unfiltered: [
            issue(1, 'route:test'),
            issue(2, 'route:unroutable'),
            issue(3),
            issue(4, 'route:docs'),
          ],
          filtered: [issue(1, 'route:test')],
        }),
        ['report', '--json'],
      );
      expect(r.status).toBe(0);
      expect(JSON.parse(r.stdout).examined).toBe(4);

      // Proving the number is right is not proving the mechanism is right.
      const listCalls = ghCalls().filter(
        (c) => c[0] === 'issue' && c[1] === 'list',
      );
      expect(listCalls.length).toBeGreaterThan(0);
      for (const c of listCalls) expect(c).not.toContain('--label');
    });

    it('names which issues are in each population, not just how many', () => {
      const r = run(
        stubFor({
          unfiltered: [
            issue(1, 'route:test'),
            issue(2, 'route:unroutable'),
            issue(3),
            issue(4, 'route:test', 'route:perf'),
          ],
        }),
        ['report', '--json'],
      );
      const out = JSON.parse(r.stdout) as Partition;
      expect(out.routed).toEqual([{ number: 1, route: 'test' }]);
      expect(out.unroutable.map((i) => i.number)).toEqual([2]);
      expect(out.untriaged.map((i) => i.number)).toEqual([3]);
      expect(out.conflicted.map((i) => i.number)).toEqual([4]);
    });

    it('surfaces the unroutable count in the human-readable line', () => {
      const r = run(
        stubFor({ unfiltered: [issue(1, 'route:unroutable'), issue(2)] }),
        ['report'],
      );
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/2 open issue/);
      expect(r.stdout).toMatch(/1 unroutable/);
    });

    it('exits 2 when gh fails, so a dead tracker is not an empty one', () => {
      const r = run(stubFor({ exitCode: 1 }), ['report']);
      expect(r.status).toBe(2);
    });
  });

  describe('ensure-labels', () => {
    it('is a dry run by default and creates nothing', () => {
      const r = run(stubFor({ labels: [] }), ['ensure-labels']);
      expect(r.status).toBe(0);
      expect(ghCalls().some((c) => c[0] === 'label' && c[1] === 'create')).toBe(
        false,
      );
      expect(r.stdout).toMatch(/dry run/);
    });

    it('creates only the labels genuinely missing', () => {
      const present = lib.ROUTE_LABELS.slice(0, 10);
      const r = run(stubFor({ labels: present }), ['ensure-labels', '--apply']);
      expect(r.status).toBe(0);
      const created = ghCalls()
        .filter((c) => c[0] === 'label' && c[1] === 'create')
        .map((c) => c[2]);
      expect(created.sort()).toEqual(lib.ROUTE_LABELS.slice(10).sort());
    });

    it('never deletes or edits a label', () => {
      const r = run(stubFor({ labels: [] }), ['ensure-labels', '--apply']);
      expect(r.status).toBe(0);
      for (const c of ghCalls()) {
        if (c[0] === 'label') expect(['list', 'create']).toContain(c[1]);
      }
    });

    it('reports the vocabulary as complete when nothing is missing', () => {
      const r = run(stubFor({ labels: lib.ROUTE_LABELS }), ['ensure-labels']);
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/complete/i);
    });
  });

  it('exits 2 on an unknown subcommand rather than doing nothing quietly', () => {
    const r = run(stubFor({}), ['frobnicate']);
    expect(r.status).toBe(2);
  });
});
