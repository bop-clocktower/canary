/**
 * Acceptance tests for the canary QA contract validator (#1151): spec
 * success criteria 1, 2, 3, 4, 16, 17, 18, one describe each. Every refusal
 * asserts the error PATH (fork H), and every refusal has a planted-valid
 * control so no test can pass vacuously.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, it, expect } from 'vitest';

import { validateDocument, validateText } from '../lib/contracts/validate.mjs';

const FIXTURES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'contracts',
);
const LAYERS = ['run', 'assessment', 'site'];
type Doc = Record<string, any>;
const valid = (layer: string): Doc =>
  JSON.parse(
    fs.readFileSync(path.join(FIXTURES, `${layer}.valid.json`), 'utf8'),
  );

function refusedPaths(doc: unknown, opts = {}): string[] {
  const res = validateDocument(doc, opts);
  expect(res.valid).toBe(false);
  return res.errors.map((e: { path: string }) => e.path);
}

describe('valid corpus (planted positives)', () => {
  it('holds one valid document per layer (a zero denominator is not a pass)', () => {
    const corpus = fs
      .readdirSync(FIXTURES)
      .filter((f) => f.endsWith('.valid.json'))
      .sort();
    expect(corpus).toEqual([
      'assessment.valid.json',
      'run.valid.json',
      'site.valid.json',
    ]);
  });

  it.each(LAYERS)('accepts the valid %s document with zero errors', (layer) => {
    const res = validateDocument(valid(layer));
    expect(res.errors).toEqual([]);
    expect(res).toMatchObject({
      valid: true,
      contract: `canary.${layer}/1`,
    });
  });

  it('reports its denominator: a site feed counts its nested records', () => {
    expect(validateDocument(valid('run')).checked).toBe(1);
    // feed + 2 runs + 1 assessment + 1 flaky row + 1 register row (#1154 S8)
    expect(validateDocument(valid('site')).checked).toBe(1 + 2 + 1 + 1 + 1);
  });

  it('counts flaky[] and register[] rows, not scopes[] or suites[] (#1154 S8)', () => {
    const doc = valid('site');
    doc.flaky.push({ ...doc.flaky[0], title: 'second flaky' });
    doc.register.push({ ...doc.register[0], title: 'second row' });
    doc.scopes.push({ id: 'other', env: 'ci' });
    doc.suites.push({ ...doc.suites[0], suite: 'other' });
    expect(validateDocument(doc).checked).toBe(1 + 2 + 1 + 2 + 2);
  });
});

describe('criterion 1: contract field and major version', () => {
  it.each(LAYERS)(
    'refuses a %s record with no contract field, naming contract',
    (layer) => {
      const doc = valid(layer);
      delete doc.contract;
      expect(refusedPaths(doc)).toEqual(['contract']);
    },
  );

  it('refuses an unknown major version, naming contract', () => {
    const res = validateDocument({
      ...valid('run'),
      contract: 'canary.run/2',
    });
    expect(res.errors).toEqual([
      {
        path: 'contract',
        message: expect.stringMatching(/unknown major version 2/),
      },
    ]);
  });

  it('refuses an unknown layer and a non-string contract, naming contract', () => {
    expect(
      refusedPaths({ ...valid('run'), contract: 'canary.signal/1' }),
    ).toEqual(['contract']);
    expect(refusedPaths({ ...valid('run'), contract: 1 })).toEqual([
      'contract',
    ]);
  });

  it('refuses an unknown major nested in a site feed, naming runs[0].contract', () => {
    const doc = valid('site');
    doc.runs[0].contract = 'canary.run/2';
    expect(refusedPaths(doc)).toEqual(['runs[0].contract']);
  });

  it('refuses a root that is not an object, naming $', () => {
    expect(refusedPaths([valid('run')])).toEqual(['$']);
    expect(refusedPaths(null)).toEqual(['$']);
  });
});

describe('criterion 2: not-assessed and observed (D4)', () => {
  const base = () => valid('assessment');

  it('refuses not-assessed carrying a value, naming value', () => {
    expect(
      refusedPaths({
        ...base(),
        status: 'not-assessed',
        value: 0,
        reason: 'no inventory',
      }),
    ).toEqual(['value']);
  });

  it('refuses not-assessed without a reason, naming reason', () => {
    expect(
      refusedPaths({
        ...base(),
        status: 'not-assessed',
        value: null,
        reason: null,
      }),
    ).toEqual(['reason']);
  });

  it('refuses observed with a null value, naming value', () => {
    expect(
      refusedPaths({ ...base(), status: 'observed', value: null }),
    ).toEqual(['value']);
  });

  it.each(['healthy', 'degraded', 'critical'])(
    'refuses %s with a null value (fork D: value null iff not-assessed)',
    (status) => {
      expect(refusedPaths({ ...base(), status, value: null })).toEqual([
        'value',
      ]);
    },
  );

  it('refuses a reason on an assessed status (fork D: reason iff not-assessed)', () => {
    expect(refusedPaths({ ...base(), reason: 'looks fine' })).toEqual([
      'reason',
    ]);
  });

  it('accepts a well-formed not-assessed and a valued observed (controls)', () => {
    expect(
      validateDocument({
        ...base(),
        status: 'not-assessed',
        value: null,
        reason: 'no inventory',
        evidence: { tier: null, denominator: null },
      }).errors,
    ).toEqual([]);
    expect(
      validateDocument({ ...base(), status: 'observed', value: 3 }).errors,
    ).toEqual([]);
  });
});

describe('criterion 3: producer-supplied verified (D5)', () => {
  it.each([true, false, null])(
    'refuses verified: %s (fork G: key presence, not truthiness)',
    (v) => {
      expect(refusedPaths({ ...valid('assessment'), verified: v })).toEqual([
        'verified',
      ]);
    },
  );

  it('refuses verified inside a site feed, naming assessments[0].verified', () => {
    const doc = valid('site');
    doc.assessments[0].verified = true;
    expect(refusedPaths(doc)).toEqual(['assessments[0].verified']);
  });
});

describe('criterion 4: totals.total equals results.length', () => {
  it('refuses a run whose totals.total differs from results.length, naming totals.total', () => {
    const doc = valid('run');
    doc.results.pop();
    expect(refusedPaths(doc)).toEqual(['totals.total']);
  });

  it('refuses results: [] against totals.total 1 (empty is not absent)', () => {
    const doc = valid('site').runs[1];
    doc.results = [];
    expect(refusedPaths(doc)).toEqual(['totals.total']);
  });

  it('accepts results: null whatever the totals (fork A: not carried)', () => {
    expect(validateDocument({ ...valid('run'), results: null }).errors).toEqual(
      [],
    );
  });

  it('refuses a mismatched run nested in a site feed, naming runs[1].totals.total', () => {
    const doc = valid('site');
    doc.runs[1].results = [];
    expect(refusedPaths(doc)).toEqual(['runs[1].totals.total']);
  });
});

describe('criterion 16: scope (D2)', () => {
  const drops: [string, (d: Doc) => void][] = [
    ['scope', (d) => delete d.scope],
    ['scope.id', (d) => delete d.scope.id],
    ['scope.env', (d) => delete d.scope.env],
  ];
  for (const layer of ['run', 'assessment']) {
    it.each(drops)(
      `refuses a ${layer} record missing %s, naming it`,
      (field, drop) => {
        const doc = valid(layer);
        drop(doc);
        expect(refusedPaths(doc)).toEqual([field]);
      },
    );
  }

  it('refuses a blank env: opaque, but never empty', () => {
    const doc = valid('run');
    doc.scope.env = '';
    expect(refusedPaths(doc)).toEqual(['scope.env']);
  });

  it('refuses a bare-string scope in a site feed (fork B), naming suites[0].scope', () => {
    const doc = valid('site');
    doc.suites[0].scope = 'canary';
    expect(refusedPaths(doc)).toEqual(['suites[0].scope']);
  });
});

describe('criterion 17: verified_by / verified_at pairing (D5)', () => {
  it('refuses verified_by without verified_at, naming verified_at', () => {
    expect(
      refusedPaths({ ...valid('assessment'), verified_by: 'qa-lead' }),
    ).toEqual(['verified_at']);
  });

  it('refuses verified_at without verified_by, naming verified_by', () => {
    expect(
      refusedPaths({
        ...valid('assessment'),
        verified_at: '2026-10-05T16:00:00Z',
      }),
    ).toEqual(['verified_by']);
  });

  it('accepts both set (control)', () => {
    expect(
      validateDocument({
        ...valid('assessment'),
        verified_by: 'qa-lead',
        verified_at: '2026-10-05T16:00:00Z',
      }).errors,
    ).toEqual([]);
  });
});

describe('criterion 18: unparseable input is refused', () => {
  it.each(['{', '', 'undefined', "{'contract':'canary.run/1'}"])(
    'refuses %j, naming $',
    (text) => {
      const res = validateText(text);
      expect(res.valid).toBe(false);
      expect(res.checked).toBe(0);
      expect(res.errors).toEqual([
        { path: '$', message: expect.stringMatching(/^not parseable JSON/) },
      ]);
    },
  );

  it('accepts the same document once it parses (control)', () => {
    expect(validateText(JSON.stringify(valid('run'))).valid).toBe(true);
  });
});

describe('fork C (amended): no author identity in a public feed', () => {
  it.each(['who', 'author'])(
    'refuses a register row carrying %s, even null, naming that key',
    (key) => {
      const doc = valid('site');
      doc.register[0][key] = null;
      expect(refusedPaths(doc)).toEqual([`register[0].${key}`]);
    },
  );
});

describe('fork E: unknown fields tolerated, wrong layer refused', () => {
  it('tolerates an unknown field (a minor version adds optional fields, D3)', () => {
    expect(
      validateDocument({ ...valid('run'), later_minor_field: { x: 1 } }).errors,
    ).toEqual([]);
  });

  it('refuses an assessment validated as layer run, naming contract', () => {
    const res = validateDocument(valid('assessment'), { layer: 'run' });
    expect(res.errors).toEqual([
      {
        path: 'contract',
        message: expect.stringMatching(/expected canary\.run\/1/),
      },
    ]);
  });
});
