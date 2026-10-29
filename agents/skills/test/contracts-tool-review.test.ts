/**
 * canary.tool-review/1 (ADR 0045): the report canary-blackalice writes.
 * Criteria 11, 12 and 15 of docs/changes/canary-blackalice/proposal.md. Each
 * named rule has its own invalid fixture whose ONLY error is that rule, so no
 * rule can pass vacuously, and every refusal asserts the error path.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, it, expect } from 'vitest';

import { validateToolReview } from '../lib/contracts/tool-review.mjs';

const FIXTURES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'contracts',
);

type Doc = Record<string, any>;
const load = (name: string): Doc =>
  JSON.parse(
    fs.readFileSync(path.join(FIXTURES, `tool-review.${name}.json`), 'utf8'),
  );
const valid = () => load('valid');
const paths = (doc: unknown) =>
  validateToolReview(doc).errors.map((e: { path: string }) => e.path);

describe('tool-review contract: schema', () => {
  it('accepts the valid fixture and counts the report, its ledger rows and its findings', () => {
    expect(validateToolReview(valid())).toEqual({
      valid: true,
      checked: 1 + 5 + 2,
      errors: [],
    });
  });

  it.each(['evidence', 'cost', 'persona'])(
    'refuses a finding without %s (criterion 11)',
    (field) => {
      const doc = valid();
      delete doc.findings[0][field];
      expect(validateToolReview(doc).errors).toEqual([
        { path: `findings[0].${field}`, message: 'missing required field' },
      ]);
    },
  );

  it('refuses a blank cost: a plain-language cost is required, not just a key', () => {
    const doc = valid();
    doc.findings[0].cost = '   ';
    expect(validateToolReview(doc).errors).toEqual([
      { path: 'findings[0].cost', message: 'must not be blank' },
    ]);
  });

  it('refuses a persona outside the six', () => {
    const doc = valid();
    doc.findings[0].persona = 'tester';
    expect(paths(doc)).toEqual(['findings[0].persona']);
  });

  it('refuses a report without not_assessed (criterion 12)', () => {
    const doc = valid();
    delete doc.not_assessed;
    expect(validateToolReview(doc).errors).toEqual([
      { path: 'not_assessed', message: 'missing required field' },
    ]);
  });

  it('accepts not_assessed as [] (none) or as run-level reasons (criterion 12)', () => {
    expect(valid().not_assessed).toEqual([]);
    const doc = valid();
    doc.not_assessed = ['walk skipped: no browser driver'];
    expect(validateToolReview(doc).valid).toBe(true);
  });

  it('refuses not_assessed: null, because [] is how a report says "none"', () => {
    const doc = valid();
    doc.not_assessed = null;
    expect(paths(doc)).toEqual(['not_assessed']);
  });

  it('refuses a pending ledger row: a report row ends in one of four states', () => {
    const doc = valid();
    doc.ledger[0].state = 'pending';
    expect(paths(doc)).toEqual(['ledger[0].state']);
  });

  it('refuses another contract string, including another major', () => {
    const doc = valid();
    doc.contract = 'canary.tool-review/2';
    expect(validateToolReview(doc).errors).toEqual([
      { path: 'contract', message: 'must be "canary.tool-review/1"' },
    ]);
  });

  it('refuses a reviewed_at without a time and zone', () => {
    const doc = valid();
    doc.reviewed_at = '2026-10-28';
    expect(paths(doc)).toEqual(['reviewed_at']);
  });

  it.each(['2026-13-45T25:61:61Z', '2025-02-29T12:00:00Z'])(
    'refuses a reviewed_at that matches the pattern but is not a real date: %s (rule real-dates)',
    (stamp) => {
      const doc = valid();
      doc.reviewed_at = stamp;
      expect(validateToolReview(doc).errors).toEqual([
        {
          path: 'reviewed_at',
          message: `${JSON.stringify(stamp)} matches the timestamp pattern but is not a real date`,
        },
      ]);
    },
  );

  it('accepts a real leap day: 2024-02-29 exists', () => {
    const doc = valid();
    doc.reviewed_at = '2024-02-29T12:00:00+02:00';
    expect(validateToolReview(doc).valid).toBe(true);
  });

  it('refuses the real-dates invalid fixture with only that error', () => {
    expect(paths(load('real-dates.invalid'))).toEqual(['reviewed_at']);
  });

  it('refuses a report that is not an object, and still counts it', () => {
    expect(paths([])).toEqual(['$']);
    expect(paths(null)).toEqual(['$']);
    expect(validateToolReview(null).checked).toBe(1);
  });

  it('names every missing top-level field of an empty object', () => {
    expect(paths({})).toEqual([
      'contract',
      'tool',
      'reviewed_at',
      'catalog_version',
      'overlay_sha',
      'ledger',
      'findings',
      'not_assessed',
    ]);
  });
});

describe('rule jobOrQuality (criterion 11)', () => {
  it('refuses the invalid fixture: a finding with both job and quality null', () => {
    expect(validateToolReview(load('job-or-quality.invalid')).errors).toEqual([
      {
        path: 'findings[0]',
        message:
          'names neither a job nor a quality; set job, quality or both (rule jobOrQuality)',
      },
    ]);
  });

  it.each([
    ['job only', 'report.read-release-status-at-a-glance', null],
    ['quality only', null, 'Q2'],
    ['both set', 'report.read-release-status-at-a-glance', 'Q2'],
  ])('accepts a finding with %s', (_case, job, quality) => {
    const doc = valid();
    doc.findings[0].job = job;
    doc.findings[0].quality = quality;
    expect(validateToolReview(doc)).toMatchObject({ valid: true, errors: [] });
  });

  it('leaves an absent job to the schema: one error, not two', () => {
    const doc = load('job-or-quality.invalid');
    delete doc.findings[0].job;
    expect(paths(doc)).toEqual(['findings[0].job']);
  });

  it('skips a finding that is not an object, which the schema reports', () => {
    const doc = valid();
    doc.findings = [7];
    expect(paths(doc)).toEqual(['findings[0]']);
  });
});

describe('rule noCompositeScore (criterion 15)', () => {
  it('refuses the invalid fixture: a score on the report and a rating on a finding', () => {
    expect(paths(load('no-composite-score.invalid'))).toEqual([
      'score',
      'findings[1].rating',
    ]);
  });

  it.each(['score', 'overall', 'composite', 'rating'])(
    'refuses %s on the report and on a finding, even as null (key presence)',
    (key) => {
      const doc = valid();
      doc[key] = null;
      doc.findings[1][key] = 9;
      const { errors } = validateToolReview(doc);
      expect(errors.map((e: { path: string }) => e.path)).toEqual([
        key,
        `findings[1].${key}`,
      ]);
      for (const e of errors) expect(e.message).toMatch(/noCompositeScore/);
    },
  );

  it.each(['score', 'overall', 'composite', 'rating'])(
    'tolerates %s on a ledger row and on tool: the rule covers the report and findings only',
    (key) => {
      const doc = valid();
      doc.ledger[0][key] = 7;
      doc.tool[key] = 'A+';
      expect(validateToolReview(doc)).toMatchObject({
        valid: true,
        errors: [],
      });
    },
  );

  it('still tolerates other unknown fields (ADR 0035 D3)', () => {
    const doc = valid();
    doc.notes = 'second pass after the redesign';
    doc.findings[0].notes = 'seen on two browsers';
    expect(validateToolReview(doc).valid).toBe(true);
  });
});

describe('rule evidenceRequired (criterion 11)', () => {
  it('refuses the invalid fixture: a finding with an empty evidence list', () => {
    expect(
      validateToolReview(load('evidence-required.invalid')).errors,
    ).toEqual([
      {
        path: 'findings[1].evidence',
        message:
          'is empty; a finding cites at least one screenshot, snapshot or file (rule evidenceRequired)',
      },
    ]);
  });

  it('leaves a non-array evidence to the schema: one error, not two', () => {
    const doc = valid();
    doc.findings[1].evidence = 'see the screenshot';
    expect(paths(doc)).toEqual(['findings[1].evidence']);
  });

  it('does not apply to ledger rows: not-assessed and not-applicable carry []', () => {
    const doc = valid();
    expect(doc.ledger[2]).toMatchObject({
      state: 'not-assessed',
      evidence: [],
    });
    expect(validateToolReview(doc).valid).toBe(true);
  });
});

describe('rule ledgerCompanion (ledger table)', () => {
  const WALKED =
    'cites no snapshot or screenshot; a walked row was driven live in the browser (rule ledgerCompanion)';
  const MAPPED =
    'cites no file; a mapped row is judged from code and docs (rule ledgerCompanion)';
  const NOT_ASSESSED =
    'is null; a not-assessed row says why it was not examined (rule ledgerCompanion)';
  const NOT_APPLICABLE =
    "is null; a not-applicable row carries the overlay's reason (rule ledgerCompanion)";

  it('refuses the invalid fixture: a walked row with file-only evidence and a not-assessed row with a null reason', () => {
    expect(validateToolReview(load('ledger-companion.invalid')).errors).toEqual(
      [
        { path: 'ledger[0].evidence', message: WALKED },
        { path: 'ledger[2].reason', message: NOT_ASSESSED },
      ],
    );
  });

  it('refuses a walked row with no evidence at all', () => {
    const doc = valid();
    doc.ledger[4].evidence = [];
    expect(validateToolReview(doc).errors).toEqual([
      { path: 'ledger[4].evidence', message: WALKED },
    ]);
  });

  it.each(['snapshot', 'screenshot'])(
    'accepts a walked row whose live evidence is a %s, alongside a file',
    (kind) => {
      const doc = valid();
      doc.ledger[0].evidence = [
        { kind: 'file', ref: 'src/routes/release.ts:9' },
        { kind, ref: 'walk/release-status' },
      ];
      expect(validateToolReview(doc).valid).toBe(true);
    },
  );

  it('refuses a mapped row with no file evidence, even with a snapshot', () => {
    const doc = valid();
    doc.ledger[1].evidence = [{ kind: 'snapshot', ref: 'snapshots/x.md' }];
    expect(validateToolReview(doc).errors).toEqual([
      { path: 'ledger[1].evidence', message: MAPPED },
    ]);
  });

  it('refuses a not-applicable row with a null reason', () => {
    const doc = valid();
    doc.ledger[3].reason = null;
    expect(validateToolReview(doc).errors).toEqual([
      { path: 'ledger[3].reason', message: NOT_APPLICABLE },
    ]);
  });

  it('leaves a blank reason to the schema (non-blank): one error, not two', () => {
    const doc = valid();
    doc.ledger[2].reason = '   ';
    expect(validateToolReview(doc).errors).toEqual([
      { path: 'ledger[2].reason', message: 'must not be blank' },
    ]);
  });

  it('leaves malformed evidence and an unknown state to the schema: one error, not two', () => {
    const doc = valid();
    doc.ledger[0].evidence = 'see the walk';
    doc.ledger[1].evidence = [7];
    doc.ledger[4].evidence = [{ kind: 'video', ref: 'walk.mp4' }];
    doc.ledger[2].state = 'skipped';
    doc.ledger[2].reason = null;
    expect(paths(doc)).toEqual([
      'ledger[0].evidence',
      'ledger[1].evidence[0]',
      'ledger[2].state',
      'ledger[4].evidence[0].kind',
    ]);
  });

  it('leaves an evidence item with a known kind but no ref to the schema: one error, not two', () => {
    const doc = valid();
    doc.ledger[0].evidence = [{ kind: 'file' }];
    expect(paths(doc)).toEqual(['ledger[0].evidence[0].ref']);
  });

  it('skips a ledger row that is not an object, which the schema reports', () => {
    const doc = valid();
    doc.ledger = [null];
    expect(paths(doc)).toEqual(['ledger[0]']);
  });
});

describe('rule idsUnique', () => {
  it('refuses the invalid fixture: two findings that share an id', () => {
    expect(validateToolReview(load('ids-unique.invalid')).errors).toEqual([
      {
        path: 'findings[1].id',
        message:
          'duplicates findings[0].id "f-001"; ids are unique within findings (rule idsUnique)',
      },
    ]);
  });

  it('refuses ledger rows that share an id, naming each repeat', () => {
    const doc = valid();
    doc.ledger[1].id = doc.ledger[0].id;
    doc.ledger[3].id = doc.ledger[0].id;
    expect(validateToolReview(doc).errors).toEqual(
      [1, 3].map((i) => ({
        path: `ledger[${i}].id`,
        message:
          'duplicates ledger[0].id "report.read-release-status-at-a-glance"; ids are unique within ledger (rule idsUnique)',
      })),
    );
  });

  it('keeps findings and ledger as separate namespaces: a finding may share a row id', () => {
    const doc = valid();
    doc.findings[0].id = doc.ledger[0].id;
    expect(validateToolReview(doc).valid).toBe(true);
  });

  it('does not check that finding.job names a ledger row (documented as unchecked)', () => {
    const doc = valid();
    doc.findings[1].job = 'no.such-job';
    expect(validateToolReview(doc).valid).toBe(true);
  });

  it('leaves a missing, non-string or blank id to the schema: one error each, not two', () => {
    const doc = valid();
    delete doc.findings[0].id;
    delete doc.findings[1].id;
    doc.ledger[0].id = 7;
    doc.ledger[1].id = 7;
    doc.ledger[2].id = ' ';
    doc.ledger[3].id = ' ';
    expect(paths(doc)).toEqual([
      'ledger[0].id',
      'ledger[1].id',
      'ledger[2].id',
      'ledger[3].id',
      'findings[0].id',
      'findings[1].id',
    ]);
  });
});
