/**
 * Unit tests for the adoption report (#459, acceptance criterion 4).
 *
 * The report is a pure function over already-gathered facts, so every case
 * below is expressed as facts rather than a filesystem fixture; the gatherer
 * that collects those facts is covered at CLI level in
 * `canary-migrate-cli.test.ts`.
 */

import { describe, expect, it } from 'vitest';

import {
  buildAdoptionReport,
  type AdoptionInput,
} from '../src/core/adoption.js';
import {
  FreshnessReport,
  SkillFreshnessResult,
  WorkflowInstallResult,
} from '../src/core/migrator.js';
import { EXIT_ABSTAINED } from '../src/core/gate-result.js';

/** A fully-adopted repo: every piece present. */
function adopted(over: Partial<AdoptionInput> = {}): AdoptionInput {
  return {
    shapes: ['e2e_ui'],
    overlayPath: '/overlays/acme',
    freshness: new FreshnessReport(
      'e2e_ui',
      '/overlays/acme',
      [new SkillFreshnessResult('guardian', 'guardian', 'current', 'ok')],
      [
        new WorkflowInstallResult(
          'canary-guardian.yml',
          'guardian',
          'skipped',
          'already current',
        ),
      ],
      ['e2e_ui'],
    ),
    companyJsonPresent: true,
    manifestPresent: true,
    coverageReportPath: 'coverage/lcov.info',
    sutControllersPath: '',
    ...over,
  };
}

function piece(input: AdoptionInput, id: string) {
  const found = buildAdoptionReport(input).pieces.find((p) => p.id === id);
  expect(found, `no piece with id '${id}'`).toBeDefined();
  return found!;
}

describe('buildAdoptionReport -- a fully adopted repo', () => {
  it('reports every piece present and exits 0', () => {
    const report = buildAdoptionReport(adopted());
    expect(report.missing).toEqual([]);
    expect(report.unverifiable).toEqual([]);
    expect(report.checked).toBe(report.pieces.length);
    expect(report.abstained).toBe(false);
    expect(report.exit_code()).toBe(0);
  });

  it('names each piece in the markdown, with no remedy lines', () => {
    const md = buildAdoptionReport(adopted()).to_markdown();
    expect(md).toContain('# Canary Adoption');
    expect(md).toContain('`.canary/company.json`');
    expect(md).toContain('.github/workflows/');
    expect(md).not.toContain('->');
  });
});

describe('buildAdoptionReport -- the reported failure (#459)', () => {
  it('calls a declared-but-uninstalled workflow missing, not present', () => {
    // `dry_run` is what a non-writing install returns for an absent file: the
    // exact partial adoption this issue reports (skills deployed, no workflow,
    // so the guardian never runs).
    const p = piece(
      adopted({
        freshness: new FreshnessReport(
          'e2e_ui',
          '/overlays/acme',
          [new SkillFreshnessResult('guardian', 'guardian', 'current', 'ok')],
          [
            new WorkflowInstallResult(
              'canary-guardian.yml',
              'guardian',
              'dry_run',
              'would install .github/workflows/canary-guardian.yml (v1)',
            ),
          ],
          ['e2e_ui'],
        ),
      }),
      'workflows',
    );
    expect(p.status).toBe('missing');
    expect(p.detail).toContain('canary-guardian.yml');
    expect(p.remedy).toContain('--apply');
  });

  it('exits 1 when a piece is missing', () => {
    const report = buildAdoptionReport(adopted({ companyJsonPresent: false }));
    expect(report.exit_code()).toBe(1);
    expect(report.missing.map((p) => p.id)).toContain('company_json');
  });

  it('counts a consumer-edited workflow as present, never a finding', () => {
    // A repo's CI is its own territory (#459 decision): a workflow that differs
    // from the template is still an ADOPTED workflow. Reporting it missing
    // would nag about the one thing canary has no claim over.
    for (const status of ['conflict', 'outdated', 'updated', 'installed']) {
      const p = piece(
        adopted({
          freshness: new FreshnessReport(
            'e2e_ui',
            '/overlays/acme',
            [new SkillFreshnessResult('guardian', 'guardian', 'current', '')],
            [
              new WorkflowInstallResult(
                'canary-guardian.yml',
                'guardian',
                status,
                'detail',
              ),
            ],
            ['e2e_ui'],
          ),
        }),
        'workflows',
      );
      expect(p.status, `status '${status}'`).toBe('present');
    }
  });

  it('calls a withheld workflow missing and keeps the withholding reason', () => {
    const p = piece(
      adopted({
        freshness: new FreshnessReport(
          'e2e_ui',
          '/overlays/acme',
          [new SkillFreshnessResult('guardian', 'guardian', 'local_edit', '')],
          [
            new WorkflowInstallResult(
              'canary-guardian.yml',
              'guardian',
              'withheld',
              'its skill has local edits',
            ),
          ],
          ['e2e_ui'],
        ),
      }),
      'workflows',
    );
    expect(p.status).toBe('missing');
    expect(p.detail).toContain('withheld');
  });
});

describe('buildAdoptionReport -- what it refuses to claim', () => {
  it('cannot verify skills or workflows without an overlay', () => {
    const input = adopted({ overlayPath: null, freshness: null });
    expect(piece(input, 'overlay').status).toBe('missing');
    expect(piece(input, 'skills').status).toBe('unknown');
    expect(piece(input, 'workflows').status).toBe('unknown');
    // "Cannot verify" is reported, and never counted as verified.
    const report = buildAdoptionReport(input);
    expect(report.unverifiable.map((p) => p.id)).toEqual(
      expect.arrayContaining(['skills', 'workflows']),
    );
    expect(report.checked).toBe(
      report.pieces.length - report.unverifiable.length,
    );
  });

  it('treats a shape that matched zero overlay skills as unverified', () => {
    const p = piece(
      adopted({
        freshness: new FreshnessReport(
          'e2e_ui',
          '/overlays/acme',
          [],
          [],
          ['e2e_ui'],
        ),
      }),
      'skills',
    );
    expect(p.status).toBe('unknown');
    expect(p.detail).toContain('zero');
  });

  it('treats an overlay declaring no workflow template as unverified', () => {
    const p = piece(
      adopted({
        freshness: new FreshnessReport(
          'e2e_ui',
          '/overlays/acme',
          [new SkillFreshnessResult('guardian', 'guardian', 'current', '')],
          [],
          ['e2e_ui'],
        ),
      }),
      'workflows',
    );
    expect(p.status).toBe('unknown');
  });

  it('does not call undeclared path pointers missing', () => {
    // No pointer means the generated workflow falls back to its own default.
    // Whether that default is right for this repo is not knowable from here,
    // so this is an honest "cannot verify", not a finding.
    const p = piece(
      adopted({ coverageReportPath: '', sutControllersPath: '' }),
      'path_pointers',
    );
    expect(p.status).toBe('unknown');
    expect(p.detail).toContain('default');
  });

  it('abstains -- never passes -- when nothing at all was verifiable', () => {
    const report = buildAdoptionReport({
      shapes: [],
      overlayPath: null,
      freshness: null,
      companyJsonPresent: false,
      manifestPresent: false,
      coverageReportPath: '',
      sutControllersPath: '',
    });
    // Findings outrank abstention: the missing pieces ARE verified facts.
    expect(report.abstained).toBe(false);
    expect(report.exit_code()).toBe(1);
    const md = report.to_markdown();
    expect(md).toContain('not verified');
  });

  it('reserves exit 3 for a report that verified nothing', () => {
    // Every piece here is establishable, so this is not the abstention case --
    // it pins the contract that the abstention exit code is the shared 3 and
    // that a report with a real denominator never borrows it.
    const report = buildAdoptionReport(adopted());
    expect(report.checked).toBeGreaterThan(0);
    expect(report.exit_code()).toBe(0);
    expect(report.exit_code()).not.toBe(EXIT_ABSTAINED);
  });
});

describe('buildAdoptionReport -- the machine contract', () => {
  it('emits a versioned, stable JSON payload', () => {
    const d = buildAdoptionReport(adopted()).to_dict();
    expect(d['schema_version']).toBe(1);
    expect(d['adopted']).toBe(true);
    expect(d['checked']).toBe(7);
    expect(d['abstained']).toBe(false);
    expect(d['exit_code']).toBe(0);
    expect(Array.isArray(d['pieces'])).toBe(true);
    expect((d['pieces'] as { id: string }[]).map((p) => p.id)).toEqual([
      'company_json',
      'shape',
      'path_pointers',
      'overlay',
      'skills',
      'manifest',
      'workflows',
    ]);
  });

  it('is not "adopted" when a piece could not be verified', () => {
    const d = buildAdoptionReport(
      adopted({ overlayPath: null, freshness: null }),
    ).to_dict();
    expect(d['adopted']).toBe(false);
  });

  // #579's lesson, applied here before it ships: the shared skip suffix renders
  // every reason inline, so passing whole explanatory sentences turns the
  // summary into a paragraph that repeats the piece lines above it. The full
  // sentence stays on the piece; the summary gets a short token.
  it('keeps the summary line short when pieces are unverifiable', () => {
    const md = buildAdoptionReport(
      adopted({ overlayPath: null, freshness: null }),
    ).to_markdown();
    const summary = md
      .split('\n')
      .find((l) => l.includes('skipped:')) as string;
    expect(summary).toBeDefined();
    expect(summary).toContain('no overlay');
    expect(summary).not.toContain('was not checked');
    expect(summary.length).toBeLessThan(160);
  });
});
