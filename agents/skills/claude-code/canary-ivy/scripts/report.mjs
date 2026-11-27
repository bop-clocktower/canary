// report -- assemble the three sections into the report object (spec D4, D8,
// D9). Pure: raw results in, report out. Markdown lives in render.mjs.
//
// Every input-derived string passes through `plain` here, so the JSON and any
// stderr line see only cleaned values; render.mjs applies `md` on top.
//
// The copy is held by the deletion-vocabulary test (SC1): no line here, fixed
// or derived, may recommend that a test go.

import { CAVEAT } from './coverage.mjs';
import { THRESHOLDS } from './runtime.mjs';
import { plain } from './text.mjs';

const SCHEMA_VERSION = 1;

const notAssessed = (reason, denominator = {}) => ({
  status: 'not_assessed',
  reason: plain(reason, 400),
  denominator,
});

const cleanLocation = (l) => ({
  file: plain(l.file),
  line: l.line,
  name: plain(l.name),
});

const cleanGroup = (g) => ({
  kind: g.kind,
  body_lines: g.body_lines,
  first_line: plain(g.first_line),
  locations: g.locations.map(cleanLocation),
});

function fixturesSection(scan) {
  const notRead = scan.unread.map((u) => ({
    file: plain(u.file),
    reason: plain(u.reason),
  }));
  const denominator = {
    files_scanned: scan.filesScanned,
    setup_blocks: scan.setupBlocks,
    files_not_read: notRead.length,
  };
  if (!scan.filesScanned) {
    const why = notRead.length
      ? `no test file could be read (${notRead.length} over the size limits)`
      : 'no test file found under the given paths';
    return { ...notAssessed(why, denominator), not_read: notRead };
  }
  return {
    status: 'assessed',
    denominator,
    groups: scan.groups.map(cleanGroup),
    not_read: notRead,
  };
}

const cleanOverlap = (g) => ({
  tests: g.tests.map((t) => plain(t)),
  line_count: g.line_count,
  shared_lines: g.shared_lines.map((s) => ({
    file: plain(s.file),
    ranges: plain(s.ranges, 400),
  })),
  caveat: CAVEAT,
});

function coverageSection(coverage) {
  if (!coverage) {
    return notAssessed(
      'no per-test coverage given (--coverage); overlap is not assessed ' +
        'until a source is named',
    );
  }
  const { overlaps, note } = coverage;
  const denominator = { tests_with_coverage: overlaps.testsWithCoverage };
  if (note) return notAssessed(note, denominator);
  if (overlaps.testsWithCoverage < 2) {
    return notAssessed('fewer than two tests carry coverage', denominator);
  }
  return {
    status: 'assessed',
    denominator,
    caveat: CAVEAT,
    groups: overlaps.groups.map(cleanOverlap),
  };
}

const plainOrNull = (v) => (v === null ? null : plain(v));

const cleanCreep = (c) => ({
  ...c,
  file: plain(c.file),
  test: plainOrNull(c.test),
  grew_at: {
    timestamp: plainOrNull(c.grew_at.timestamp),
    commit_sha: plainOrNull(c.grew_at.commit_sha),
    run_id: plainOrNull(c.grew_at.run_id),
  },
});

function runtimeSection(runtime) {
  if (runtime.dark) return notAssessed(runtime.dark, { runs: 0 });
  const { denominator, where_time_went, creep } = runtime.analysis;
  if (!denominator.timed_tests) {
    return notAssessed(
      `no test in ${denominator.runs} run(s) carries duration_ms`,
      denominator,
    );
  }
  return {
    status: 'assessed',
    denominator,
    thresholds: { ...THRESHOLDS },
    where_time_went: where_time_went.map((w) => ({
      ...w,
      file: plain(w.file),
    })),
    creep: creep.map(cleanCreep),
  };
}

/**
 * @param {{fixtures: object, coverage: object|null, runtime: object}} raw
 */
export function assembleReport(raw) {
  const sections = {
    fixtures: fixturesSection(raw.fixtures),
    coverage: coverageSection(raw.coverage),
    runtime: runtimeSection(raw.runtime),
  };
  const abstained = Object.values(sections).every(
    (s) => s.status === 'not_assessed',
  );
  return {
    schema_version: SCHEMA_VERSION,
    tool: 'canary-ivy',
    abstained,
    sections,
  };
}

export const renderJson = (report) => JSON.stringify(report, null, 2);
