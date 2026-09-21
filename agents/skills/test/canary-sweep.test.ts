/**
 * canary-sweep — component-level dedup for axe findings (#594).
 *
 * The skill is a POST-PROCESSOR: someone else ran axe, this collapses what
 * they produced. So the assertions that matter are about what it refuses to
 * claim, not about scanning:
 *
 *   - a node it cannot attribute is UNATTRIBUTED with a count, never quietly
 *     folded into a neighbouring component (that would manufacture the dedup
 *     the skill exists to perform honestly)
 *   - a results set in which no rule was evaluated ABSTAINS, because an axe
 *     document with `violations: []` and nothing else in it means "axe never
 *     ran here", not "this page is clean"
 *   - a genuinely clean scan prints its DENOMINATOR next to the zero
 *
 * Fixtures are hand-authored and synthetic. No real axe output from any real
 * site is copied in — the identifier leak gate scans fixtures too.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { main } from '../claude-code/canary-sweep/scripts/cli.mjs';
import {
  attributeNode,
  DEFAULT_ATTRS,
} from '../claude-code/canary-sweep/scripts/component.mjs';
import { mapWcag, fixFor } from '../claude-code/canary-sweep/scripts/wcag.mjs';
import { ingest } from '../claude-code/canary-sweep/scripts/ingest.mjs';
import { buildReport } from '../claude-code/canary-sweep/scripts/report.mjs';

const EXIT_ABSTAINED = 3;

const dirs: string[] = [];
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-sweep-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** Run the CLI in-process, capturing everything it writes. */
function run(argv: string[]): { code: number; out: string } {
  const out: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    out.push(a.join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
    out.push(a.join(' '));
  });
  const write = vi.spyOn(process.stdout, 'write').mockImplementation(((
    chunk: string,
  ) => {
    out.push(String(chunk));
    return true;
  }) as never);
  const code = main(argv);
  write.mockRestore();
  vi.restoreAllMocks();
  return { code, out: out.join('\n') };
}

interface NodeSpec {
  html: string;
  target?: string[];
}

/** One axe violation entry. */
function violation(
  id: string,
  nodes: NodeSpec[],
  extra: Record<string, unknown> = {},
) {
  return {
    id,
    impact: 'serious',
    tags: ['cat.color', 'wcag2aa', 'wcag143'],
    help: `${id} help text`,
    helpUrl: `https://example.invalid/rules/${id}`,
    description: `${id} description`,
    nodes: nodes.map((n) => ({
      html: n.html,
      target: n.target ?? [n.html],
      failureSummary: 'Fix any of the following: ...',
    })),
    ...extra,
  };
}

/** One axe result document, with a non-empty `passes` so it is not vacuous. */
function page(url: string, violations: unknown[], evaluated = 12) {
  return {
    url,
    violations,
    passes: Array.from({ length: evaluated }, (_, i) => ({
      id: `passed-${i}`,
    })),
    incomplete: [],
    inapplicable: [],
  };
}

/** Write a JSON fixture into a fresh directory and return that directory. */
function fixtureDir(docs: unknown): string {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'axe.json'), JSON.stringify(docs), 'utf8');
  return dir;
}

const BUTTON = (component: string) =>
  `<button data-component="${component}" class="x">Go</button>`;

describe('component attribution (D1/D2)', () => {
  it('reads the default attribute priority order', () => {
    expect(DEFAULT_ATTRS[0]).toBe('data-component');
    const hit = attributeNode(
      { html: '<b data-testid="Chip" data-qa="other">x</b>', target: ['b'] },
      DEFAULT_ATTRS,
    );
    expect(hit).toEqual({ component: 'Chip', source: 'data-testid' });
  });

  it('prefers the earlier attribute when several are present', () => {
    const hit = attributeNode(
      {
        html: '<b data-testid="Chip" data-component="Card">x</b>',
        target: ['b'],
      },
      DEFAULT_ATTRS,
    );
    expect(hit.component).toBe('Card');
  });

  it('honours an overridden attribute list', () => {
    const hit = attributeNode(
      { html: '<b data-qa="Q" data-component="C">x</b>', target: ['b'] },
      ['data-qa'],
    );
    expect(hit).toEqual({ component: 'Q', source: 'data-qa' });
  });

  it('falls back to an attribute selector in the target path (D2)', () => {
    const hit = attributeNode(
      {
        html: '<button>Go</button>',
        target: ['[data-component="SiteHeader"] > button'],
      },
      DEFAULT_ATTRS,
    );
    expect(hit).toEqual({
      component: 'SiteHeader',
      source: 'data-component (target path)',
    });
  });

  it('returns null rather than inventing a component from tag or class', () => {
    const hit = attributeNode(
      {
        html: '<button class="btn btn-primary">Go</button>',
        target: ['div > button.btn'],
      },
      DEFAULT_ATTRS,
    );
    expect(hit).toEqual({ component: null, source: null });
  });

  it('ignores a marker that belongs to a DESCENDANT, not the failing element', () => {
    // axe's `html` is the failing element's OUTER HTML, so it contains the
    // children too. A shared icon's marker inside an unmarked button is NOT
    // that button's identity: attributing it would merge two structurally
    // different buttons into one finding with one fix line, and the reader
    // would remediate one site and believe the other was covered.
    const hit = attributeNode(
      {
        html: '<button class="btn"><span data-testid="icon-chevron">v</span></button>',
        target: ['div > button.btn'],
      },
      DEFAULT_ATTRS,
    );
    expect(hit).toEqual({ component: null, source: null });
  });

  it('prefers the failing element own marker over a descendant marker', () => {
    const hit = attributeNode(
      {
        html: '<button data-component="PrimaryCta"><span data-component="Icon">v</span></button>',
        target: ['button'],
      },
      DEFAULT_ATTRS,
    );
    expect(hit).toEqual({ component: 'PrimaryCta', source: 'data-component' });
  });

  it('reads the opening tag even when an earlier attribute value contains >', () => {
    const hit = attributeNode(
      {
        html: '<button title="a > b" data-testid="Chip">Go</button>',
        target: ['button'],
      },
      DEFAULT_ATTRS,
    );
    expect(hit).toEqual({ component: 'Chip', source: 'data-testid' });
  });

  it('reads the opening tag when an attribute value contains a quote of the other kind', () => {
    const hit = attributeNode(
      {
        html: `<button title='say "hi" > now' data-qa="Q">Go</button>`,
        target: ['button'],
      },
      DEFAULT_ATTRS,
    );
    expect(hit).toEqual({ component: 'Q', source: 'data-qa' });
  });

  it('still resolves a self-closing element marker', () => {
    const hit = attributeNode(
      { html: '<img data-testid="Avatar" alt=""/>', target: ['img'] },
      DEFAULT_ATTRS,
    );
    expect(hit.component).toBe('Avatar');
  });

  it('flattens a nested (iframe) target path', () => {
    const hit = attributeNode(
      {
        html: '<button>Go</button>',
        target: [['#frame', '[data-testid="Inner"] button']] as never,
      },
      DEFAULT_ATTRS,
    );
    expect(hit.component).toBe('Inner');
  });
});

describe('WCAG mapping (D3) and fix snippets (D4)', () => {
  it('parses the criterion and level from axe tags', () => {
    expect(mapWcag(['cat.color', 'wcag2aa', 'wcag143'])).toEqual({
      criteria: ['1.4.3'],
      level: 'AA',
      labelled: true,
    });
  });

  it('parses a two-digit criterion segment', () => {
    expect(mapWcag(['wcag21aa', 'wcag1410']).criteria).toEqual(['1.4.10']);
  });

  it('reports a best-practice rule as carrying no WCAG criterion', () => {
    const got = mapWcag(['cat.semantics', 'best-practice']);
    expect(got.labelled).toBe(false);
    expect(got.criteria).toEqual([]);
    expect(got.level).toBeNull();
  });

  it('gives a curated snippet for a known rule', () => {
    expect(fixFor('image-alt', 'h', 'u')).toMatch(/alt=/);
  });

  it('falls back to axe help rather than inventing a snippet', () => {
    const fix = fixFor(
      'not-a-real-rule',
      'Use a thing',
      'https://example.invalid/x',
    );
    expect(fix).toMatch(/no canary snippet/i);
    expect(fix).toContain('Use a thing');
    expect(fix).toContain('https://example.invalid/x');
  });
});

describe('ingest (input shapes)', () => {
  it('accepts a single axe result object', () => {
    const got = ingest(fixtureDir(page('/', [])));
    expect(got.documents).toHaveLength(1);
    expect(got.ruleEvaluations).toBe(12);
  });

  it('accepts an array of result objects', () => {
    const got = ingest(fixtureDir([page('/', []), page('/pricing', [])]));
    expect(got.documents).toHaveLength(2);
  });

  it('accepts a {results: [...]} envelope', () => {
    const got = ingest(fixtureDir({ results: [page('/', [])] }));
    expect(got.documents).toHaveLength(1);
  });

  it('accepts a single file path as well as a directory', () => {
    const dir = fixtureDir(page('/', []));
    const got = ingest(path.join(dir, 'axe.json'));
    expect(got.documents).toHaveLength(1);
  });

  it('names the file in the error when JSON is malformed', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'bad.json'), '{not json', 'utf8');
    expect(() => ingest(dir)).toThrow(/bad\.json/);
  });

  it('ignores non-JSON files in the directory', () => {
    const dir = fixtureDir(page('/', []));
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'hello', 'utf8');
    expect(ingest(dir).documents).toHaveLength(1);
  });
});

describe('component-level dedup — the load-bearing idea', () => {
  it('collapses one rule on one component across many pages into one finding', () => {
    const nodes = Array.from({ length: 20 }, () => ({
      html: BUTTON('SiteHeader'),
    }));
    const dir = fixtureDir([
      page('/', [violation('color-contrast', nodes)]),
      page('/pricing', [violation('color-contrast', nodes)]),
    ]);
    const report = buildReport(ingest(dir), { attrs: DEFAULT_ATTRS });

    expect(report.findings).toHaveLength(1);
    expect(report.findings[0].component).toBe('SiteHeader');
    expect(report.findings[0].occurrences).toBe(40);
    expect(report.findings[0].pages).toEqual(['/', '/pricing']);
    expect(report.summary.components).toBe(1);
  });

  it('keeps two different components on the same rule apart', () => {
    const dir = fixtureDir(
      page('/', [
        violation('color-contrast', [
          { html: BUTTON('SiteHeader') },
          { html: BUTTON('Footer') },
        ]),
      ]),
    );
    const report = buildReport(ingest(dir), { attrs: DEFAULT_ATTRS });
    expect(report.findings).toHaveLength(2);
    expect(
      report.findings.map((f: { component: string }) => f.component).sort(),
    ).toEqual(['Footer', 'SiteHeader']);
  });

  it('keeps two rules on the same component apart', () => {
    const dir = fixtureDir(
      page('/', [
        violation('color-contrast', [{ html: BUTTON('SiteHeader') }]),
        violation('button-name', [{ html: BUTTON('SiteHeader') }]),
      ]),
    );
    const report = buildReport(ingest(dir), { attrs: DEFAULT_ATTRS });
    expect(report.findings).toHaveLength(2);
  });
});

describe('unattributed nodes are counted, never bucketed', () => {
  it('reports unattributed nodes under their own count', () => {
    const dir = fixtureDir(
      page('/', [
        violation('color-contrast', [
          { html: BUTTON('SiteHeader') },
          { html: '<button class="btn">Go</button>' },
          { html: '<a href="#">x</a>' },
        ]),
      ]),
    );
    const report = buildReport(ingest(dir), { attrs: DEFAULT_ATTRS });

    expect(report.summary.unattributed_nodes).toBe(2);
    const named = report.findings.filter(
      (f: { component: string | null }) => f.component,
    );
    expect(named).toHaveLength(1);
    expect(named[0].occurrences).toBe(1);
  });

  it('counts a node whose only marker is on a DESCENDANT as unattributed', () => {
    // The counter that tells a reader how much of the report to trust must not
    // be deflated by the nodes whose attribution is least trustworthy.
    const dir = fixtureDir(
      page('/', [
        violation('color-contrast', [
          {
            html: '<button class="btn"><span data-testid="icon-chevron">v</span></button>',
            target: ['div > button.btn'],
          },
          {
            html: '<button class="cta"><span data-testid="icon-chevron">v</span></button>',
            target: ['main > button.cta'],
          },
        ]),
      ]),
    );
    const report = buildReport(ingest(dir), { attrs: DEFAULT_ATTRS });

    expect(report.summary.unattributed_nodes).toBe(2);
    expect(report.summary.components).toBe(0);
    expect(
      report.findings.filter((f: { component: string | null }) => f.component),
    ).toHaveLength(0);
  });

  it('surfaces the unattributed count in the Markdown', () => {
    const dir = fixtureDir(
      page('/', [
        violation('color-contrast', [
          { html: '<button class="b">Go</button>' },
        ]),
      ]),
    );
    const { code, out } = run(['--results', dir]);
    expect(code).toBe(0);
    expect(out).toMatch(/unattributed/i);
    expect(out).toContain('1');
  });
});

describe('abstention (D5) — zero findings is not a pass', () => {
  it('abstains loudly when no axe document was read', () => {
    const { code, out } = run(['--results', tmp()]);
    expect(out.toLowerCase()).toContain('abstained');
    expect(out).not.toContain('0 violations across');
    expect(code).toBe(0);
  });

  it('inherits exit 3 under --strict on an empty results set', () => {
    expect(run(['--results', tmp(), '--strict']).code).toBe(EXIT_ABSTAINED);
  });

  it('abstains when documents were read but no rule was evaluated', () => {
    const dir = fixtureDir([
      {
        url: '/',
        violations: [],
        passes: [],
        incomplete: [],
        inapplicable: [],
      },
    ]);
    const { out } = run(['--results', dir]);
    expect(out.toLowerCase()).toContain('abstained');
    expect(out).toContain('1');
    expect(run(['--results', dir, '--strict']).code).toBe(EXIT_ABSTAINED);
  });

  it('reports a genuinely clean scan WITH its denominator', () => {
    const dir = fixtureDir([page('/', []), page('/pricing', [])]);
    const { code, out } = run(['--results', dir]);
    expect(code).toBe(0);
    expect(out.toLowerCase()).not.toContain('abstained');
    expect(out).toContain('0 violations across');
    expect(out).toContain('2 page');
    expect(out).toContain('24');
  });
});

describe('route coverage (D6)', () => {
  it('names routes that were listed but never scanned', () => {
    const dir = fixtureDir([page('/', [])]);
    const routes = path.join(dir, 'routes.txt');
    fs.writeFileSync(routes, '/\n/billing\n/help\n', 'utf8');

    const { out } = run(['--results', dir, '--routes', routes]);
    expect(out).toContain('/billing');
    expect(out).toContain('/help');
    expect(out).toMatch(/unscanned/i);
  });

  it('accepts a JSON array route list and reports full coverage', () => {
    const dir = fixtureDir([page('/', [])]);
    const routes = path.join(dir, 'routes.json');
    fs.writeFileSync(routes, JSON.stringify(['/']), 'utf8');
    const report = buildReport(ingest(dir), {
      attrs: DEFAULT_ATTRS,
      routesPath: routes,
    });
    expect(report.coverage!.routes_unscanned).toEqual([]);
    expect(report.coverage!.routes_expected).toBe(1);
  });

  it('has no coverage section when no route list was given', () => {
    const report = buildReport(ingest(fixtureDir([page('/', [])])), {
      attrs: DEFAULT_ATTRS,
    });
    expect(report.coverage).toBeNull();
  });
});

describe('CLI surface', () => {
  it('writes Markdown and JSON to files', () => {
    const dir = fixtureDir(
      page('/', [
        violation('color-contrast', [{ html: BUTTON('SiteHeader') }]),
      ]),
    );
    const md = path.join(dir, 'report.md');
    const json = path.join(dir, 'report.json');
    const { code } = run([
      '--results',
      dir,
      '--markdown-out',
      md,
      '--json-out',
      json,
    ]);

    expect(code).toBe(0);
    expect(fs.readFileSync(md, 'utf8')).toContain('SiteHeader');
    const parsed = JSON.parse(fs.readFileSync(json, 'utf8'));
    expect(parsed.version).toBe(1);
    expect(parsed.findings[0].wcag.criteria).toEqual(['1.4.3']);
    expect(parsed.summary.abstained).toBe(false);
  });

  it('exits 1 under --strict when violations were found', () => {
    const dir = fixtureDir(
      page('/', [
        violation('color-contrast', [{ html: BUTTON('SiteHeader') }]),
      ]),
    );
    expect(run(['--results', dir, '--strict']).code).toBe(1);
  });

  it('exits 0 under --strict on a clean, non-vacuous scan', () => {
    expect(
      run(['--results', fixtureDir([page('/', [])]), '--strict']).code,
    ).toBe(0);
  });

  it('reports a missing results path without a stack trace', () => {
    const { code, out } = run(['--results', path.join(tmp(), 'nope')]);
    expect(code).toBe(1);
    expect(out).toContain('canary-sweep:');
    expect(out).toContain('nope');
  });

  it('reports malformed JSON as an error, not as a clean scan', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'bad.json'), 'nope', 'utf8');
    const { code, out } = run(['--results', dir]);
    expect(code).toBe(1);
    expect(out).toContain('bad.json');
  });

  it('accepts --component-attr as an override', () => {
    const dir = fixtureDir(
      page('/', [
        violation('color-contrast', [{ html: '<b data-widget="Chip">x</b>' }]),
      ]),
    );
    const { out } = run(['--results', dir, '--component-attr', 'data-widget']);
    expect(out).toContain('Chip');
  });
});

// NOTE: the shebang, the exec bit, the --help contract, unknown-flag rejection
// and the process.exitCode wiring are NOT asserted here on purpose.
// `skill-cli-conformance.test.ts` discovers every SKILL.md declaring `cli:` and
// asserts all of them for this skill automatically. A per-skill copy is exactly
// what drifted last time and passed against buggy code.
