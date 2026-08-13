/**
 * Faithful TypeScript port of `tests/unit/test_guardian_coverage.py`.
 *
 * Phase 1 (deterministic, agent-free). SC-3: highest-available-fidelity
 * resolution per changed unit (report > graph > heuristic), each labeled.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  type ChangedUnit,
  type CoverageResult,
  Fidelity,
  coverageLimits,
  fidelityRank,
  resolveCoverage,
  resolveFromGraph,
  resolveFromReport,
  resolveFromHeuristic,
} from '../src/guardian/coverage.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'canary-cov-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, body, 'utf-8');
  return path;
}

function ndjson(...records: unknown[]): string {
  return records.map((r) => JSON.stringify(r)).join('\n') + '\n';
}

function byPath(results: CoverageResult[]): Record<string, CoverageResult> {
  return Object.fromEntries(results.map((r) => [r.unit.path, r]));
}

// ---------------------------------------------------------------------------

describe('shapes', () => {
  it('fidelity rank order — lower rank == higher fidelity', () => {
    expect(fidelityRank(Fidelity.CoverageVerified)).toBeLessThan(
      fidelityRank(Fidelity.GraphVerified),
    );
    expect(fidelityRank(Fidelity.GraphVerified)).toBeLessThan(
      fidelityRank(Fidelity.Heuristic),
    );
  });

  it('fidelity string values', () => {
    expect(Fidelity.CoverageVerified).toBe('coverage-verified');
    expect(Fidelity.GraphVerified).toBe('graph-verified');
    expect(Fidelity.Heuristic).toBe('heuristic');
  });

  it('changed unit fields', () => {
    const unit: ChangedUnit = {
      path: 'agent/core/foo.py',
      added_ranges: [[12, 28]],
    };
    expect(unit.path).toBe('agent/core/foo.py');
    expect(unit.added_ranges).toEqual([[12, 28]]);
    expect(unit.symbol).toBeUndefined();
  });

  it('coverage result fields', () => {
    const unit: ChangedUnit = {
      path: 'agent/core/foo.py',
      added_ranges: [[1, 3]],
    };
    const result: CoverageResult = {
      unit,
      covered: false,
      fidelity: Fidelity.Heuristic,
      evidence: 'no test references foo',
      uncovered_lines: [1, 2, 3],
    };
    expect(result.unit).toBe(unit);
    expect(result.covered).toBe(false);
    expect(result.fidelity).toBe(Fidelity.Heuristic);
    expect(result.evidence).toBe('no test references foo');
    expect(result.uncovered_lines).toEqual([1, 2, 3]);
  });

  it('uncovered_lines defaults to empty via the module builders', () => {
    // TS has no dataclass default; the graph tier never sets uncovered_lines,
    // so a graph result carries the [] default the Python field(default_factory)
    // would have supplied.
    const graph = write(
      'graph.json',
      ndjson({
        kind: 'node',
        type: 'file',
        id: 'file:x.py',
        path: 'x.py',
      }),
    );
    const results = resolveFromGraph(
      [{ path: 'x.py', added_ranges: [[1, 1]] }],
      graph,
    );
    expect(results).not.toBeNull();
    expect(results![0]!.uncovered_lines).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

const LCOV_FIXTURE = `SF:pkg/foo.py
DA:12,3
DA:13,1
DA:14,0
DA:15,2
end_of_record
SF:pkg/bar.py
DA:1,5
DA:2,4
end_of_record
`;

const JSON_FIXTURE = {
  files: {
    'pkg/foo.py': { covered_lines: [12, 13, 15] },
    'pkg/bar.py': { covered_lines: [1, 2] },
  },
};

const COBERTURA_FIXTURE = `<?xml version="1.0" ?>
<coverage version="1.0">
  <sources><source>.</source></sources>
  <packages>
    <package name="pkg">
      <classes>
        <class name="foo" filename="pkg/foo.py">
          <lines>
            <line number="12" hits="3"/>
            <line number="13" hits="1"/>
            <line number="14" hits="0"/>
            <line number="15" hits="2"/>
          </lines>
        </class>
        <class name="bar" filename="pkg/bar.py">
          <lines>
            <line number="1" hits="5"/>
            <line number="2" hits="4"/>
          </lines>
        </class>
      </classes>
    </package>
  </packages>
</coverage>
`;

const COBERTURA_DEEP_PATH_FIXTURE = `<?xml version="1.0" ?>
<coverage>
  <packages><package name="com.foo"><classes>
    <class filename="src/main/java/com/foo/Bar.java">
      <lines>
        <line number="7" hits="2"/>
        <line number="8" hits="0"/>
      </lines>
    </class>
  </classes></package></packages>
</coverage>
`;

const NON_COVERAGE_XML = `<?xml version="1.0" ?>
<testsuite name="unit" tests="3" failures="0">
  <testcase classname="pkg.foo" name="test_a"/>
</testsuite>
`;

const COBERTURA_WITH_DOCTYPE = `<?xml version="1.0" ?>
<!DOCTYPE coverage SYSTEM 'http://cobertura.sourceforge.net/xml/coverage-04.dtd'>
<coverage version="6.5.0">
  <packages><package name="pkg"><classes>
    <class filename="pkg/foo.py"><lines>
      <line number="12" hits="1"/>
      <line number="14" hits="0"/>
    </lines></class>
  </classes></package></packages>
</coverage>
`;

const COBERTURA_ENTITY_BOMB = `<?xml version="1.0" ?>
<!DOCTYPE coverage [
  <!ENTITY lol "lol">
  <!ENTITY lol2 "&lol;&lol;&lol;&lol;">
]>
<coverage><packages><package><classes>
  <class filename="pkg/foo.py"><lines>
    <line number="12" hits="&lol2;"/>
  </lines></class>
</classes></package></packages></coverage>
`;

describe('resolveFromReport', () => {
  const units = (): [ChangedUnit, ChangedUnit] => [
    { path: 'pkg/foo.py', added_ranges: [[12, 15]] },
    { path: 'pkg/bar.py', added_ranges: [[1, 2]] },
  ];

  it('lcov covered and uncovered', () => {
    const report = write('lcov.info', LCOV_FIXTURE);
    const [foo, bar] = units();
    const results = resolveFromReport([foo, bar], report);
    expect(results).not.toBeNull();
    const by = byPath(results!);

    expect(by['pkg/foo.py']!.covered).toBe(false);
    expect(by['pkg/foo.py']!.uncovered_lines).toEqual([14]);
    expect(by['pkg/foo.py']!.fidelity).toBe(Fidelity.CoverageVerified);

    expect(by['pkg/bar.py']!.covered).toBe(true);
    expect(by['pkg/bar.py']!.uncovered_lines).toEqual([]);
    expect(by['pkg/bar.py']!.fidelity).toBe(Fidelity.CoverageVerified);
  });

  it('json covered and uncovered', () => {
    const report = write('coverage.json', JSON.stringify(JSON_FIXTURE));
    const [foo, bar] = units();
    const results = resolveFromReport([foo, bar], report);
    expect(results).not.toBeNull();
    const by = byPath(results!);

    expect(by['pkg/foo.py']!.covered).toBe(false);
    expect(by['pkg/foo.py']!.uncovered_lines).toEqual([14]);
    expect(by['pkg/bar.py']!.covered).toBe(true);
  });

  it('unrecognized format returns null', () => {
    const report = write('results.xml', NON_COVERAGE_XML);
    const [foo] = units();
    expect(resolveFromReport([foo], report)).toBeNull();
  });

  it('missing file returns null', () => {
    const [foo] = units();
    expect(resolveFromReport([foo], join(dir, 'nope.json'))).toBeNull();
  });

  it('malformed json returns null rather than throwing', () => {
    // Found by canary's own guardian once it was finally handed a coverage
    // report (#655): this branch and the one below had never been executed by
    // any test, on either side of the port.
    const report = write('coverage.json', '{"files": {');
    const [foo] = units();
    expect(resolveFromReport([foo], report)).toBeNull();
  });

  it('an extension matching no parser returns null', () => {
    // Not `.json`, `.info`/lcov, or `.xml` — no parser claims it, so the reader
    // abstains and the orchestrator falls through to a lower-fidelity tier.
    const report = write('coverage.txt', 'TN:\nSF:pkg/foo.py\n');
    const [foo] = units();
    expect(resolveFromReport([foo], report)).toBeNull();
  });

  it('cobertura covered and uncovered', () => {
    const report = write('coverage.xml', COBERTURA_FIXTURE);
    const [foo, bar] = units();
    const results = resolveFromReport([foo, bar], report);
    expect(results).not.toBeNull();
    const by = byPath(results!);

    expect(by['pkg/foo.py']!.covered).toBe(false);
    expect(by['pkg/foo.py']!.uncovered_lines).toEqual([14]);
    expect(by['pkg/foo.py']!.fidelity).toBe(Fidelity.CoverageVerified);

    expect(by['pkg/bar.py']!.covered).toBe(true);
    expect(by['pkg/bar.py']!.uncovered_lines).toEqual([]);
    expect(by['pkg/bar.py']!.fidelity).toBe(Fidelity.CoverageVerified);
  });

  it('cobertura deep source root path match', () => {
    const report = write('cobertura.xml', COBERTURA_DEEP_PATH_FIXTURE);
    const unit: ChangedUnit = {
      path: 'com/foo/Bar.java',
      added_ranges: [[7, 8]],
    };
    const results = resolveFromReport([unit], report);
    expect(results).not.toBeNull();
    expect(results!.length).toBe(1);
    expect(results![0]!.covered).toBe(false);
    expect(results![0]!.uncovered_lines).toEqual([8]);
    expect(results![0]!.fidelity).toBe(Fidelity.CoverageVerified);
  });

  it('cobertura non-coverage xml returns null', () => {
    const report = write('coverage.xml', NON_COVERAGE_XML);
    const [foo] = units();
    expect(resolveFromReport([foo], report)).toBeNull();
  });

  it('cobertura malformed xml returns null', () => {
    const report = write('coverage.xml', '<coverage><packages></coverage');
    const [foo] = units();
    expect(resolveFromReport([foo], report)).toBeNull();
  });

  it('cobertura system doctype allowed', () => {
    const report = write('coverage.xml', COBERTURA_WITH_DOCTYPE);
    const unit: ChangedUnit = { path: 'pkg/foo.py', added_ranges: [[12, 14]] };
    const results = resolveFromReport([unit], report);
    expect(results).not.toBeNull();
    expect(results!.length).toBe(1);
    expect(results![0]!.covered).toBe(false);
    // Line 13 has no `<line>` record in the fixture, so it is not coverable and
    // is scored by neither side (#655). This assertion read `[13, 14]` before
    // that fix — the subject here is doctype acceptance, and the extra line was
    // incidental to it, so it had encoded the defect without ever testing for it.
    expect(results![0]!.uncovered_lines).toEqual([14]);
    expect(results![0]!.fidelity).toBe(Fidelity.CoverageVerified);
  });

  it('cobertura entity bomb rejected', () => {
    const report = write('coverage.xml', COBERTURA_ENTITY_BOMB);
    const [foo] = units();
    expect(resolveFromReport([foo], report)).toBeNull();
  });

  it('cobertura entity bomb past 4k window rejected', () => {
    // A leading comment pushes the DOCTYPE past byte 4096; a windowed guard
    // would miss it. The full-text scan must still reject it.
    const payload =
      '<?xml version="1.0" ?>\n' +
      '<!-- ' +
      'x'.repeat(5000) +
      ' -->\n' +
      '<!DOCTYPE coverage [\n' +
      '  <!ENTITY a "aaaaaaaaaa">\n' +
      '  <!ENTITY b "&a;&a;&a;&a;&a;">\n]>\n' +
      '<coverage><packages><package><classes>' +
      '<class filename="pkg/foo.py"><lines>' +
      '<line number="12" hits="&b;"/></lines></class>' +
      '</classes></package></packages></coverage>';
    expect(payload.indexOf('<!DOCTYPE')).toBeGreaterThan(4096); // guard the guard
    const report = write('coverage.xml', payload);
    const [foo] = units();
    expect(resolveFromReport([foo], report)).toBeNull();
  });

  it('cobertura windows separators match', () => {
    const xml =
      '<?xml version="1.0" ?><coverage><packages><package><classes>' +
      '<class filename="pkg\\foo.py"><lines>' +
      '<line number="12" hits="1"/><line number="13" hits="0"/>' +
      '</lines></class></classes></package></packages></coverage>';
    const report = write('coverage.xml', xml);
    const unit: ChangedUnit = { path: 'pkg/foo.py', added_ranges: [[12, 13]] };
    const results = resolveFromReport([unit], report);
    expect(results).not.toBeNull();
    expect(results!.length).toBe(1);
    expect(results![0]!.uncovered_lines).toEqual([13]);
    expect(results![0]!.fidelity).toBe(Fidelity.CoverageVerified);
  });

  it('report non-utf8 returns null', () => {
    // A non-UTF-8 report must fall through, not raise, out of the gate.
    const path = join(dir, 'coverage.xml');
    writeFileSync(
      path,
      Buffer.from([
        ...Buffer.from('<coverage>'),
        0xff,
        0xfe,
        ...Buffer.from('<class filename="pkg/foo.py"/></coverage>'),
      ]),
    );
    const [foo] = units();
    expect(resolveFromReport([foo], path)).toBeNull();
  });

  it('cobertura oversize rejected', () => {
    // Shrink the size cap so the fixture trips it without a huge file (analog of
    // the Python monkeypatch on _MAX_REPORT_BYTES).
    const original = coverageLimits.maxReportBytes;
    coverageLimits.maxReportBytes = 32;
    try {
      const report = write('coverage.xml', COBERTURA_FIXTURE);
      const [foo] = units();
      expect(resolveFromReport([foo], report)).toBeNull();
    } finally {
      coverageLimits.maxReportBytes = original;
    }
  });

  // FIX 1: malformed XML that ET.fromstring would reject must return null (fall
  // through), NOT have coverage scraped out of it by a lenient scanner.
  it.each([
    [
      'stray unclosed tag',
      '<coverage><class filename="a.py"><line number="1" hits="1"/></class><oops></coverage>',
    ],
    [
      'unquoted attribute',
      '<coverage x=1><class filename="a.py"><line number="1" hits="1"/></class></coverage>',
    ],
    [
      'raw ampersand in text',
      '<coverage><class filename="a.py"><line number="1" hits="1"/></class><note>a & b</note></coverage>',
    ],
  ])('cobertura malformed (%s) returns null', (_label, xml) => {
    const report = write('coverage.xml', xml);
    const unit: ChangedUnit = { path: 'a.py', added_ranges: [[1, 1]] };
    expect(resolveFromReport([unit], report)).toBeNull();
  });

  // FIX 2: a self-closing <class .../> must not steal the NEXT class's lines.
  it('cobertura self-closing class does not mis-attribute lines', () => {
    const xml =
      '<coverage><packages><package><classes>' +
      '<class filename="x.py"/>' +
      '<class filename="y.py"><lines><line number="5" hits="1"/></lines></class>' +
      '</classes></package></packages></coverage>';
    const report = write('coverage.xml', xml);
    const xUnit: ChangedUnit = { path: 'x.py', added_ranges: [[5, 5]] };
    const yUnit: ChangedUnit = { path: 'y.py', added_ranges: [[5, 5]] };
    const results = resolveFromReport([xUnit, yUnit], report);
    expect(results).not.toBeNull();
    // Line 5 binds to y.py (Python: {"y.py": {5: 1}}); x.py contributes no lines
    // and so is absent from the index → skipped (no result).
    expect(results!.length).toBe(1);
    expect(results![0]!.unit.path).toBe('y.py');
    expect(results![0]!.covered).toBe(true);
    expect(results![0]!.uncovered_lines).toEqual([]);
  });

  it('exact report path preferred over suffix', () => {
    const report = write(
      'coverage.json',
      JSON.stringify({
        files: {
          'models/foo.py': { covered_lines: [1] }, // hit
          'utils/foo.py': { covered_lines: [] }, // line 1 unhit
        },
      }),
    );
    const unit: ChangedUnit = { path: 'utils/foo.py', added_ranges: [[1, 1]] };
    const results = resolveFromReport([unit], report);
    expect(results).not.toBeNull();
    const by = byPath(results!);
    expect(by['utils/foo.py']!.covered).toBe(false); // not models/foo.py's hit
  });

  it('report suffix requires separator boundary', () => {
    const report = write(
      'coverage.json',
      JSON.stringify({ files: { 'lib/foobar.py': { covered_lines: [1] } } }),
    );
    const unit: ChangedUnit = { path: 'bar.py', added_ranges: [[1, 1]] };
    const results = resolveFromReport([unit], report);
    // No boundary match → no report signal for bar.py → skipped (falls through).
    expect(results).toEqual([]);
  });

  it('report ambiguous basename skips', () => {
    const report = write(
      'coverage.json',
      JSON.stringify({
        files: {
          'a/foo.py': { covered_lines: [1] },
          'b/foo.py': { covered_lines: [1] },
        },
      }),
    );
    const unit: ChangedUnit = { path: 'foo.py', added_ranges: [[1, 1]] };
    const results = resolveFromReport([unit], report);
    expect(results).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

const GRAPH_FIXTURE = ndjson(
  { kind: 'node', type: 'file', id: 'file:pkg/foo.py', path: 'pkg/foo.py' },
  {
    kind: 'node',
    type: 'function',
    id: 'function:pkg/foo.py:do_it',
    path: 'pkg/foo.py',
  },
  { kind: 'node', type: 'file', id: 'file:pkg/bar.py', path: 'pkg/bar.py' },
  {
    kind: 'node',
    type: 'file',
    id: 'file:tests/test_foo.py',
    path: 'tests/test_foo.py',
  },
  {
    kind: 'edge',
    from: 'file:pkg/foo.py',
    to: 'function:pkg/foo.py:do_it',
    type: 'contains',
  },
  {
    kind: 'edge',
    from: 'file:tests/test_foo.py',
    to: 'function:pkg/foo.py:do_it',
    type: 'calls',
  },
);

describe('resolveFromGraph', () => {
  it('covered via test calls edge', () => {
    const graph = write('graph.json', GRAPH_FIXTURE);
    const foo: ChangedUnit = { path: 'pkg/foo.py', added_ranges: [[1, 5]] };
    const bar: ChangedUnit = { path: 'pkg/bar.py', added_ranges: [[1, 5]] };
    const results = resolveFromGraph([foo, bar], graph);
    expect(results).not.toBeNull();
    const by = byPath(results!);

    expect(by['pkg/foo.py']!.covered).toBe(true);
    expect(by['pkg/foo.py']!.fidelity).toBe(Fidelity.GraphVerified);
    expect(by['pkg/foo.py']!.evidence).toContain('tests/test_foo.py');

    expect(by['pkg/bar.py']!.covered).toBe(false);
    expect(by['pkg/bar.py']!.fidelity).toBe(Fidelity.GraphVerified);
  });

  it('direct file import edge covers', () => {
    const graph = write(
      'graph.json',
      ndjson(
        {
          kind: 'node',
          type: 'file',
          id: 'file:pkg/baz.py',
          path: 'pkg/baz.py',
        },
        {
          kind: 'node',
          type: 'file',
          id: 'file:tests/test_baz.py',
          path: 'tests/test_baz.py',
        },
        {
          kind: 'edge',
          from: 'file:tests/test_baz.py',
          to: 'file:pkg/baz.py',
          type: 'imports',
        },
      ),
    );
    const baz: ChangedUnit = { path: 'pkg/baz.py', added_ranges: [[1, 3]] };
    const results = resolveFromGraph([baz], graph);
    expect(results).not.toBeNull();
    expect(results![0]!.covered).toBe(true);
  });

  it('missing graph returns null', () => {
    const foo: ChangedUnit = { path: 'pkg/foo.py', added_ranges: [[1, 5]] };
    expect(resolveFromGraph([foo], join(dir, 'absent.json'))).toBeNull();
  });

  it('empty graph returns null', () => {
    const graph = write('graph.json', '');
    const foo: ChangedUnit = { path: 'pkg/foo.py', added_ranges: [[1, 5]] };
    expect(resolveFromGraph([foo], graph)).toBeNull();
  });

  it('non-dict ndjson lines ignored (FIX 3)', () => {
    const graph = write(
      'graph.json',
      [
        '{"kind": "node", "type": "file", "id": "file:pkg/foo.py", "path": "pkg/foo.py"}',
        '5',
        '[1, 2]',
        'null',
        '"a bare string"',
        '{"kind": "node", "type": "file", "id": "file:tests/test_foo.py", "path": "tests/test_foo.py"}',
        '{"kind": "edge", "from": "file:tests/test_foo.py", "to": "file:pkg/foo.py", "type": "imports"}',
      ].join('\n') + '\n',
    );
    const foo: ChangedUnit = { path: 'pkg/foo.py', added_ranges: [[1, 3]] };
    const results = resolveFromGraph([foo], graph);
    expect(results).not.toBeNull();
    expect(results![0]!.covered).toBe(true);
  });

  it('graph suffix requires separator boundary (FIX 6)', () => {
    const graph = write(
      'graph.json',
      ndjson(
        {
          kind: 'node',
          type: 'file',
          id: 'file:x/foobar.py',
          path: 'x/foobar.py',
        },
        {
          kind: 'node',
          type: 'file',
          id: 'file:tests/test_x.py',
          path: 'tests/test_x.py',
        },
        {
          kind: 'edge',
          from: 'file:tests/test_x.py',
          to: 'file:x/foobar.py',
          type: 'imports',
        },
      ),
    );
    const unit: ChangedUnit = { path: 'bar.py', added_ranges: [[1, 3]] };
    expect(resolveFromGraph([unit], graph)).toEqual([]);
  });

  it('graph ambiguous basename not unioned (FIX 6)', () => {
    const graph = write(
      'graph.json',
      ndjson(
        { kind: 'node', type: 'file', id: 'file:a/foo.py', path: 'a/foo.py' },
        { kind: 'node', type: 'file', id: 'file:b/foo.py', path: 'b/foo.py' },
        {
          kind: 'node',
          type: 'file',
          id: 'file:tests/test_a.py',
          path: 'tests/test_a.py',
        },
        {
          kind: 'edge',
          from: 'file:tests/test_a.py',
          to: 'file:a/foo.py',
          type: 'imports',
        },
      ),
    );
    const unit: ChangedUnit = { path: 'foo.py', added_ranges: [[1, 3]] };
    expect(resolveFromGraph([unit], graph)).toEqual([]);
  });
});

// A DIRECT test→source edge: test_foo.py imports foo.py straight (one hop).
const DIRECT_EDGE_GRAPH = ndjson(
  { kind: 'node', type: 'file', id: 'file:pkg/foo.py', path: 'pkg/foo.py' },
  {
    kind: 'node',
    type: 'file',
    id: 'file:tests/test_foo.py',
    path: 'tests/test_foo.py',
  },
  {
    kind: 'edge',
    from: 'file:tests/test_foo.py',
    to: 'file:pkg/foo.py',
    type: 'imports',
  },
);

// A PURELY-TRANSITIVE reach: test_a imports b, b imports foo. No direct
// test→foo edge — only an indirect two-hop path.
const TRANSITIVE_GRAPH = ndjson(
  { kind: 'node', type: 'file', id: 'file:pkg/foo.py', path: 'pkg/foo.py' },
  { kind: 'node', type: 'file', id: 'file:pkg/b.py', path: 'pkg/b.py' },
  {
    kind: 'node',
    type: 'file',
    id: 'file:tests/test_a.py',
    path: 'tests/test_a.py',
  },
  {
    kind: 'edge',
    from: 'file:tests/test_a.py',
    to: 'file:pkg/b.py',
    type: 'imports',
  },
  {
    kind: 'edge',
    from: 'file:pkg/b.py',
    to: 'file:pkg/foo.py',
    type: 'imports',
  },
);

describe('resolveFromGraph depth (#320)', () => {
  it('direct edge covered at depth 1', () => {
    const graph = write('graph.json', DIRECT_EDGE_GRAPH);
    const foo: ChangedUnit = { path: 'pkg/foo.py', added_ranges: [[1, 3]] };
    const results = resolveFromGraph([foo], graph, 1);
    expect(results).not.toBeNull();
    expect(results![0]!.covered).toBe(true);
    expect(results![0]!.fidelity).toBe(Fidelity.GraphVerified);
  });

  it('purely transitive uncovered at depth 1', () => {
    const graph = write('graph.json', TRANSITIVE_GRAPH);
    const foo: ChangedUnit = { path: 'pkg/foo.py', added_ranges: [[1, 3]] };

    const bounded = resolveFromGraph([foo], graph, 1);
    expect(bounded).not.toBeNull();
    expect(bounded![0]!.covered).toBe(false);

    const unbounded = resolveFromGraph([foo], graph, null);
    expect(unbounded).not.toBeNull();
    expect(unbounded![0]!.covered).toBe(true);
  });

  it('depth boundary two hops', () => {
    const graph = write('graph.json', TRANSITIVE_GRAPH);
    const foo: ChangedUnit = { path: 'pkg/foo.py', added_ranges: [[1, 3]] };

    const at2 = resolveFromGraph([foo], graph, 2);
    expect(at2).not.toBeNull();
    expect(at2![0]!.covered).toBe(true);

    const at1 = resolveFromGraph([foo], graph, 1);
    expect(at1).not.toBeNull();
    expect(at1![0]!.covered).toBe(false);
  });

  it('shortest-path BFS not DFS at depth 3', () => {
    // #320 FIX 1: the reverse traversal must be a genuine shortest-path BFS.
    // Shortest test→s0 path: s0 <- s3(1) <- s1(2) <- t0(3) == depth 3.
    const graph = write(
      'graph.json',
      ndjson(
        { kind: 'node', type: 'file', id: 'file:pkg/s0.py', path: 'pkg/s0.py' },
        { kind: 'node', type: 'file', id: 'file:pkg/s1.py', path: 'pkg/s1.py' },
        { kind: 'node', type: 'file', id: 'file:pkg/s2.py', path: 'pkg/s2.py' },
        { kind: 'node', type: 'file', id: 'file:pkg/s3.py', path: 'pkg/s3.py' },
        { kind: 'node', type: 'file', id: 'file:pkg/s4.py', path: 'pkg/s4.py' },
        { kind: 'node', type: 'file', id: 'file:pkg/s5.py', path: 'pkg/s5.py' },
        {
          kind: 'node',
          type: 'file',
          id: 'file:tests/t0.test.ts',
          path: 'tests/t0.test.ts',
        },
        {
          kind: 'edge',
          from: 'file:pkg/s2.py',
          to: 'file:pkg/s0.py',
          type: 'imports',
        },
        {
          kind: 'edge',
          from: 'file:pkg/s3.py',
          to: 'file:pkg/s0.py',
          type: 'imports',
        },
        {
          kind: 'edge',
          from: 'file:pkg/s5.py',
          to: 'file:pkg/s0.py',
          type: 'imports',
        },
        {
          kind: 'edge',
          from: 'file:tests/t0.test.ts',
          to: 'file:pkg/s1.py',
          type: 'imports',
        },
        {
          kind: 'edge',
          from: 'file:pkg/s2.py',
          to: 'file:pkg/s1.py',
          type: 'imports',
        },
        {
          kind: 'edge',
          from: 'file:pkg/s5.py',
          to: 'file:pkg/s1.py',
          type: 'imports',
        },
        {
          kind: 'edge',
          from: 'file:pkg/s1.py',
          to: 'file:pkg/s3.py',
          type: 'imports',
        },
        {
          kind: 'edge',
          from: 'file:pkg/s1.py',
          to: 'file:pkg/s4.py',
          type: 'imports',
        },
        {
          kind: 'edge',
          from: 'file:pkg/s2.py',
          to: 'file:pkg/s5.py',
          type: 'imports',
        },
        {
          kind: 'edge',
          from: 'file:pkg/s4.py',
          to: 'file:pkg/s5.py',
          type: 'imports',
        },
        {
          kind: 'edge',
          from: 'file:pkg/s5.py',
          to: 'file:pkg/s3.py',
          type: 'imports',
        },
        {
          kind: 'edge',
          from: 'file:pkg/s5.py',
          to: 'file:tests/t0.test.ts',
          type: 'imports',
        },
      ),
    );
    const s0: ChangedUnit = { path: 'pkg/s0.py', added_ranges: [[1, 3]] };

    const at3 = resolveFromGraph([s0], graph, 3);
    expect(at3).not.toBeNull();
    expect(at3![0]!.covered).toBe(true);

    const at2 = resolveFromGraph([s0], graph, 2);
    expect(at2).not.toBeNull();
    expect(at2![0]!.covered).toBe(false);

    const none = resolveFromGraph([s0], graph, null);
    expect(none).not.toBeNull();
    expect(none![0]!.covered).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe('resolveFromHeuristic', () => {
  function buildRepo(): string {
    mkdirSync(join(dir, 'pkg'));
    mkdirSync(join(dir, 'tests'));
    writeFileSync(
      join(dir, 'pkg', 'foo.py'),
      'def do_it():\n    return 1\n',
      'utf-8',
    );
    writeFileSync(
      join(dir, 'pkg', 'bar.py'),
      'def other():\n    return 2\n',
      'utf-8',
    );
    writeFileSync(
      join(dir, 'tests', 'test_foo.py'),
      'from pkg import foo\n\ndef test_do_it():\n    assert foo.do_it() == 1\n',
      'utf-8',
    );
    return dir;
  }

  it('stem referenced by test is covered', () => {
    const repo = buildRepo();
    const foo: ChangedUnit = { path: 'pkg/foo.py', added_ranges: [[1, 2]] };
    const results = resolveFromHeuristic([foo], repo);
    expect(results[0]!.covered).toBe(true);
    expect(results[0]!.fidelity).toBe(Fidelity.Heuristic);
    expect(results[0]!.evidence).toContain('test_foo.py');
  });

  it('unreferenced unit is uncovered', () => {
    const repo = buildRepo();
    const bar: ChangedUnit = { path: 'pkg/bar.py', added_ranges: [[1, 2]] };
    const results = resolveFromHeuristic([bar], repo);
    expect(results[0]!.covered).toBe(false);
    expect(results[0]!.fidelity).toBe(Fidelity.Heuristic);
  });

  it('symbol name reference covers', () => {
    mkdirSync(join(dir, 'pkg'));
    mkdirSync(join(dir, 'tests'));
    writeFileSync(
      join(dir, 'pkg', 'widget.py'),
      'class GadgetMaker:\n    pass\n',
      'utf-8',
    );
    writeFileSync(
      join(dir, 'tests', 'test_things.py'),
      'from pkg.widget import GadgetMaker\n\ndef test_it():\n    assert GadgetMaker()\n',
      'utf-8',
    );
    const unit: ChangedUnit = { path: 'pkg/widget.py', added_ranges: [[1, 2]] };
    const results = resolveFromHeuristic([unit], dir);
    expect(results[0]!.covered).toBe(true);
  });

  it('always returns one result per unit', () => {
    const repo = buildRepo();
    const units: ChangedUnit[] = [
      { path: 'pkg/foo.py', added_ranges: [[1, 2]] },
      { path: 'pkg/bar.py', added_ranges: [[1, 2]] },
    ];
    const results = resolveFromHeuristic(units, repo);
    expect(results.length).toBe(2);
    expect(results.every((r) => r.fidelity === Fidelity.Heuristic)).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe('resolveCoverage (SC-3 ladder: report > graph > heuristic)', () => {
  function buildRepo(): { graph: string; report: string } {
    mkdirSync(join(dir, 'pkg'));
    mkdirSync(join(dir, 'tests'));
    writeFileSync(
      join(dir, 'pkg', 'foo.py'),
      'def do_it():\n    return 1\n',
      'utf-8',
    );
    writeFileSync(
      join(dir, 'tests', 'test_foo.py'),
      'from pkg import foo\n\ndef test_do_it():\n    assert foo.do_it() == 1\n',
      'utf-8',
    );
    const graph = write(
      'graph.json',
      ndjson(
        {
          kind: 'node',
          type: 'file',
          id: 'file:pkg/foo.py',
          path: 'pkg/foo.py',
        },
        {
          kind: 'node',
          type: 'file',
          id: 'file:tests/test_foo.py',
          path: 'tests/test_foo.py',
        },
        {
          kind: 'edge',
          from: 'file:tests/test_foo.py',
          to: 'file:pkg/foo.py',
          type: 'imports',
        },
      ),
    );
    const report = write(
      'coverage.json',
      JSON.stringify({ files: { 'pkg/foo.py': { covered_lines: [1, 2] } } }),
    );
    return { graph, report };
  }

  it('report wins when all present', () => {
    const { graph, report } = buildRepo();
    const unit: ChangedUnit = { path: 'pkg/foo.py', added_ranges: [[1, 2]] };
    const results = resolveCoverage([unit], {
      coveragePath: report,
      graphPath: graph,
      repoRoot: dir,
    });
    expect(results.length).toBe(1);
    expect(results[0]!.fidelity).toBe(Fidelity.CoverageVerified);
  });

  it('graph wins when no report', () => {
    const { graph } = buildRepo();
    const unit: ChangedUnit = { path: 'pkg/foo.py', added_ranges: [[1, 2]] };
    const results = resolveCoverage([unit], {
      coveragePath: null,
      graphPath: graph,
      repoRoot: dir,
    });
    expect(results.length).toBe(1);
    expect(results[0]!.fidelity).toBe(Fidelity.GraphVerified);
  });

  it('heuristic when no report no graph', () => {
    buildRepo();
    const unit: ChangedUnit = { path: 'pkg/foo.py', added_ranges: [[1, 2]] };
    const results = resolveCoverage([unit], {
      coveragePath: null,
      graphPath: join(dir, 'absent.json'),
      repoRoot: dir,
    });
    expect(results.length).toBe(1);
    expect(results[0]!.fidelity).toBe(Fidelity.Heuristic);
  });

  it('exactly one result per unit', () => {
    const { graph, report } = buildRepo();
    const units: ChangedUnit[] = [
      { path: 'pkg/foo.py', added_ranges: [[1, 2]] },
      { path: 'pkg/missing.py', added_ranges: [[1, 2]] },
    ];
    const results = resolveCoverage(units, {
      coveragePath: report,
      graphPath: graph,
      repoRoot: dir,
    });
    expect(results.length).toBe(units.length);
    expect(results.map((r) => r.unit.path)).toEqual(units.map((u) => u.path));
  });

  it('unit absent from report falls through per unit (FIX 2)', () => {
    const report = write(
      'coverage.json',
      JSON.stringify({ files: { 'pkg/a.py': { covered_lines: [1] } } }),
    );
    const graph = write(
      'graph.json',
      ndjson(
        {
          kind: 'node',
          type: 'file',
          id: 'file:pkg/NEW.py',
          path: 'pkg/NEW.py',
        },
        {
          kind: 'node',
          type: 'file',
          id: 'file:tests/test_new.py',
          path: 'tests/test_new.py',
        },
        {
          kind: 'edge',
          from: 'file:tests/test_new.py',
          to: 'file:pkg/NEW.py',
          type: 'imports',
        },
      ),
    );
    const reported: ChangedUnit = { path: 'pkg/a.py', added_ranges: [[1, 1]] };
    const newUnit: ChangedUnit = { path: 'pkg/NEW.py', added_ranges: [[1, 3]] };

    const results = resolveCoverage([reported, newUnit], {
      coveragePath: report,
      graphPath: graph,
      repoRoot: dir,
    });
    const by = byPath(results);

    expect(by['pkg/a.py']!.fidelity).toBe(Fidelity.CoverageVerified);
    expect(by['pkg/NEW.py']!.fidelity).toBe(Fidelity.GraphVerified);
    expect(by['pkg/NEW.py']!.covered).toBe(true);
  });

  it('graph max depth threaded to graph resolver (#320)', () => {
    const graph = write('graph.json', TRANSITIVE_GRAPH);
    const foo: ChangedUnit = { path: 'pkg/foo.py', added_ranges: [[1, 3]] };

    const bounded = resolveCoverage([foo], {
      coveragePath: null,
      graphPath: graph,
      repoRoot: dir,
      graphMaxDepth: 1,
    });
    expect(bounded[0]!.fidelity).toBe(Fidelity.GraphVerified);
    expect(bounded[0]!.covered).toBe(false);

    const unbounded = resolveCoverage([foo], {
      coveragePath: null,
      graphPath: graph,
      repoRoot: dir,
      graphMaxDepth: null,
    });
    expect(unbounded[0]!.fidelity).toBe(Fidelity.GraphVerified);
    expect(unbounded[0]!.covered).toBe(true);
  });
});

/**
 * Non-coverable changed lines (#655).
 *
 * A changed line with no record in the report was never instrumented —
 * comments, imports, `interface`/`type` declarations, blank lines, closing
 * braces. Scoring it as a miss made a wholly-new, fully-tested file read as
 * almost entirely uncovered at the highest-trust tier: every line of a new file
 * is a changed line, so the finding's size was `file length − instrumented
 * lines`. Reported downstream against `canary-test-cli@6.7.0` with the
 * arithmetic reproduced exactly (156 − 20 = 136, 46 − 12 = 34).
 *
 * The rule is per-format, because absence does not mean the same thing in each:
 *
 *   - lcov / Cobertura enumerate every *instrumented* line, so a missing record
 *     means NOT COVERABLE — excluded from numerator and denominator both.
 *   - coverage-json's frozen v1 contract says the opposite in as many words:
 *     "a line absent from both fields is treated as uncovered (hits = 0)".
 *     That is not a bug to fix here; changing it would break the contract.
 *
 * The per-file version of this rule already existed one level up — a unit whose
 * path is absent from the report emits no coverage-verified result rather than
 * assuming zero. These are the same rule at line granularity.
 */
describe('non-coverable lines (#655)', () => {
  // A new module: 20 lines changed, but only 10-12 carry DA records — the rest
  // are imports, types and blanks. All three instrumented lines are hit.
  const LCOV_SPARSE = `SF:pkg/new_module.py
DA:10,1
DA:11,2
DA:12,1
end_of_record
`;

  it('does not count an uninstrumented changed line as uncovered', () => {
    const report = write('lcov.info', LCOV_SPARSE);
    const unit: ChangedUnit = {
      path: 'pkg/new_module.py',
      added_ranges: [[1, 20]],
    };

    const results = resolveFromReport([unit], report);

    expect(results).not.toBeNull();
    expect(results![0]!.uncovered_lines).toEqual([]);
    expect(results![0]!.covered).toBe(true);
    expect(results![0]!.fidelity).toBe(Fidelity.CoverageVerified);
  });

  it('reports the coverable denominator, not the changed-line count', () => {
    // "all covered" over 20 changed lines and over 3 coverable ones are very
    // different claims; the evidence has to say which one was checked.
    const report = write('lcov.info', LCOV_SPARSE);
    const unit: ChangedUnit = {
      path: 'pkg/new_module.py',
      added_ranges: [[1, 20]],
    };

    const evidence = resolveFromReport([unit], report)![0]!.evidence;

    expect(evidence).toContain('3');
  });

  it('still reports an instrumented line the run never hit', () => {
    // The narrowness is the point: DA:13,0 is real evidence of a real miss and
    // must survive a fix aimed at records that do not exist.
    const report = write(
      'lcov.info',
      `${LCOV_SPARSE}`.replace('DA:12,1\n', 'DA:12,1\nDA:13,0\n'),
    );
    const unit: ChangedUnit = {
      path: 'pkg/new_module.py',
      added_ranges: [[1, 20]],
    };

    const results = resolveFromReport([unit], report);

    expect(results![0]!.uncovered_lines).toEqual([13]);
    expect(results![0]!.covered).toBe(false);
  });

  it('emits no coverage-verified result when no changed line is coverable', () => {
    // Zero coverable lines is an abstention for this unit, never a clean pass
    // and never a critical finding. Emitting nothing lets the orchestrator fall
    // through to the graph/heuristic tier, exactly as an absent path does.
    const report = write('lcov.info', LCOV_SPARSE);
    const unit: ChangedUnit = {
      path: 'pkg/new_module.py',
      added_ranges: [[1, 4]],
    };

    const results = resolveFromReport([unit], report);

    expect(results).toEqual([]);
  });

  it('applies the same rule to Cobertura, which also enumerates lines', () => {
    const report = write(
      'coverage.xml',
      `<?xml version="1.0" ?>
<coverage version="1.0">
  <sources><source>.</source></sources>
  <packages>
    <package name="pkg">
      <classes>
        <class name="new_module" filename="pkg/new_module.py">
          <lines>
            <line number="10" hits="1"/>
            <line number="11" hits="2"/>
          </lines>
        </class>
      </classes>
    </package>
  </packages>
</coverage>
`,
    );
    const unit: ChangedUnit = {
      path: 'pkg/new_module.py',
      added_ranges: [[1, 20]],
    };

    const results = resolveFromReport([unit], report);

    expect(results![0]!.uncovered_lines).toEqual([]);
    expect(results![0]!.covered).toBe(true);
  });

  it('leaves coverage-json on its frozen contract: absent means uncovered', () => {
    // NOT the same input. coverage-json's v1 contract states that a line absent
    // from both fields is uncovered, and `covered_lines` cannot express an
    // unhit line at all. Applying the lcov rule here would silently rewrite a
    // frozen contract and blind every producer that uses the shorthand.
    const report = write(
      'coverage.json',
      JSON.stringify({
        files: { 'pkg/new_module.py': { covered_lines: [10] } },
      }),
    );
    const unit: ChangedUnit = {
      path: 'pkg/new_module.py',
      added_ranges: [[10, 12]],
    };

    const results = resolveFromReport([unit], report);

    expect(results![0]!.uncovered_lines).toEqual([11, 12]);
    expect(results![0]!.covered).toBe(false);
  });
});

/**
 * `instrumented_lines` — coverage-json can now say what it measured (#657).
 *
 * #655 fixed the per-line rule for lcov and Cobertura, which enumerate every
 * instrumented line, and deliberately left coverage-json alone: its v1 contract
 * says a line absent from both fields is *uncovered*, and `covered_lines`
 * cannot express an unhit line, so absence is the only way a producer using the
 * shorthand can report one.
 *
 * That left a real trap. The contract had no way to say "this line was never
 * instrumented", so a producer transcoding lcov into it reproduced #655
 * exactly: the non-instrumented lines it dropped came back as coverage gaps, at
 * the `coverage-verified` label.
 *
 * The fix is additive and stays on v1. A file entry may declare
 * `instrumented_lines`; when it does, that set is what the report can speak to
 * and absence outside it means NOT COVERABLE — the lcov rule, opted into
 * per-file. When it does not, v1 semantics are untouched, so no existing
 * producer changes behaviour and no existing document is re-read.
 */
describe('instrumented_lines (#657)', () => {
  const unit = (added: [number, number][]): ChangedUnit => ({
    path: 'pkg/new_module.py',
    added_ranges: added,
  });

  const report = (entry: Record<string, unknown>): string =>
    write(
      'coverage.json',
      JSON.stringify({ files: { 'pkg/new_module.py': entry } }),
    );

  it('excludes a changed line the producer never instrumented', () => {
    // Lines 1-9 are imports and types: absent from the declared set, so the
    // report cannot speak to them and they are scored by neither side. Under
    // v1 semantics every one of them would have counted as a miss.
    const path = report({
      line_hits: { '10': 3, '11': 2 },
      instrumented_lines: [10, 11],
    });

    const results = resolveFromReport([unit([[1, 11]])], path);

    expect(results![0]!.uncovered_lines).toEqual([]);
    expect(results![0]!.covered).toBe(true);
    expect(results![0]!.coverable_lines).toBe(2);
  });

  it('counts an instrumented line with no hit record as uncovered', () => {
    // The point of the field: 12 was measured and never ran. Declaring it is
    // how a producer reports a miss without listing it in line_hits.
    const path = report({
      line_hits: { '10': 3 },
      instrumented_lines: [10, 11, 12],
    });

    const results = resolveFromReport([unit([[1, 20]])], path);

    expect(results![0]!.uncovered_lines).toEqual([11, 12]);
    expect(results![0]!.covered).toBe(false);
    expect(results![0]!.coverable_lines).toBe(3);
  });

  it('keeps line_hits authoritative over the declared set', () => {
    // `{"11": 0}` is an explicit unhit line and stays uncovered; listing 11 in
    // covered_lines must not upgrade it. That rule is frozen and predates this
    // field — declaring instrumentation must not become a way around it.
    const path = report({
      line_hits: { '10': 3, '11': 0 },
      covered_lines: [11],
      instrumented_lines: [10, 11],
    });

    const results = resolveFromReport([unit([[1, 20]])], path);

    expect(results![0]!.uncovered_lines).toEqual([11]);
  });

  it('treats a line_hits key outside the declared set as coverable', () => {
    // A producer contradicting itself: it recorded a hit count for a line it
    // did not declare. Real measurement outranks the declaration, so the line
    // is coverable. The validator warns about the contradiction separately.
    const path = report({
      line_hits: { '10': 3, '50': 0 },
      instrumented_lines: [10],
    });

    const results = resolveFromReport([unit([[1, 60]])], path);

    expect(results![0]!.uncovered_lines).toEqual([50]);
    expect(results![0]!.coverable_lines).toBe(2);
  });

  it('abstains when no changed line is coverable', () => {
    // Never a clean pass and never a finding — the report has nothing to say
    // about this unit, so it falls through to the graph/heuristic tier.
    const path = report({
      line_hits: { '10': 3 },
      instrumented_lines: [10],
    });

    expect(resolveFromReport([unit([[1, 5]])], path)).toEqual([]);
  });

  it('leaves a document without the field on v1 semantics', () => {
    // The compatibility guarantee. No field means the producer said nothing
    // about instrumentation, so absence still means uncovered exactly as the
    // frozen contract states — existing producers are not re-read.
    const path = report({ covered_lines: [10] });

    const results = resolveFromReport([unit([[10, 12]])], path);

    expect(results![0]!.uncovered_lines).toEqual([11, 12]);
    expect(results![0]!.covered).toBe(false);
  });

  it('ignores a malformed declaration rather than dropping the file', () => {
    // Leniency matches the rest of the parser: one bad field degrades that
    // field, never the whole entry. A non-array declaration means "not
    // declared", so the entry falls back to v1 semantics.
    const path = report({
      line_hits: { '10': 3 },
      instrumented_lines: 'all of them',
    });

    const results = resolveFromReport([unit([[10, 11]])], path);

    expect(results![0]!.uncovered_lines).toEqual([11]);
  });
});
