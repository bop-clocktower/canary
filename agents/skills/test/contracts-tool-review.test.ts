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

  it('accepts job only, quality only, and both set', () => {
    const doc = valid();
    expect(doc.findings[0]).toMatchObject({ job: null, quality: 'Q2' });
    expect(doc.findings[1].job).not.toBeNull();
    expect(doc.findings[1].quality).not.toBeNull();
    doc.findings[0].job = 'report.read-release-status-at-a-glance';
    doc.findings[0].quality = null;
    expect(validateToolReview(doc).valid).toBe(true);
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
