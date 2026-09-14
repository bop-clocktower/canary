/**
 * Permission matrix (#857): expand a human-declared grid across acting x target
 * tenants, and never let an undeclared cell pass silently.
 */

import { describe, expect, it } from 'vitest';

import {
  expandMatrix,
  parseMatrix,
  renderPlaywright,
} from '../src/core/permission-matrix.js';

const MODEL = `
roles: [family, staff, examiner]
tenants: [county-a, county-b]
endpoints:
  GET /persons/{id}:
    family: own-tenant
    staff: own-tenant
    examiner: allow
  POST /persons/{id}/deceased:
    family: deny
    staff: deny
    examiner: own-tenant
`;

describe('expandMatrix', () => {
  const { cells, undeclared } = expandMatrix(parseMatrix(MODEL));

  it('expands role x endpoint x acting tenant x target tenant', () => {
    expect(cells).toHaveLength(3 * 2 * 2 * 2);
    expect(undeclared).toEqual([]);
  });

  it('denies cross-tenant cells under own-tenant, allows same-tenant', () => {
    const find = (role: string, acting: string, target: string) =>
      cells.find(
        (c) =>
          c.endpoint === 'GET /persons/{id}' &&
          c.role === role &&
          c.actingTenant === acting &&
          c.targetTenant === target,
      )!;
    expect(find('staff', 'county-a', 'county-a').expect).toBe('allow');
    expect(find('staff', 'county-a', 'county-b').expect).toBe('deny');
    expect(find('examiner', 'county-a', 'county-b').expect).toBe('allow');
  });

  it('reports a missing cell as UNDECLARED, by name', () => {
    const model = parseMatrix(MODEL.replace('    staff: deny\n', ''));
    const r = expandMatrix(model);
    expect(r.undeclared).toEqual(['POST /persons/{id}/deceased × staff']);
    expect(r.cells.filter((c) => c.expect === 'undeclared')).toHaveLength(4);
  });

  it('treats an unknown value as undeclared, not as allow or deny', () => {
    const r = expandMatrix(
      parseMatrix(MODEL.replace('family: deny', 'family: maybe')),
    );
    expect(r.undeclared).toEqual([
      'POST /persons/{id}/deceased × family (unknown value "maybe")',
    ]);
  });
});

describe('parseMatrix', () => {
  it('rejects a model missing roles, tenants or endpoints', () => {
    expect(() => parseMatrix('roles: [a]\ntenants: [t]\n')).toThrow(
      /endpoints/,
    );
    expect(() => parseMatrix('endpoints: {}\ntenants: [t]\n')).toThrow(/roles/);
  });

  it('rejects an endpoint key that is not "METHOD /path"', () => {
    expect(() =>
      parseMatrix(
        'roles: [a]\ntenants: [t]\nendpoints:\n  persons: {a: deny}\n',
      ),
    ).toThrow(/METHOD \/path/);
  });

  it('rejects a path that could break out of the generated template literal', () => {
    expect(() =>
      parseMatrix(
        'roles: [a]\ntenants: [t]\nendpoints:\n  "GET /x`${process.exit()}": {a: deny}\n',
      ),
    ).toThrow(/METHOD \/path/);
  });
});

describe('renderPlaywright', () => {
  const src = renderPlaywright(expandMatrix(parseMatrix(MODEL)).cells);

  it('hits the server through the request context, never a page', () => {
    expect(src).toContain("from '@playwright/test'");
    expect(src).toContain('request.fetch(');
    expect(src).not.toContain('page.');
  });

  it('names every cell in a test title and reads creds from env', () => {
    expect(src).toContain(
      'staff@county-a -> county-b: GET /persons/{id} is denied',
    );
    expect(src).toContain('CANARY_TOKEN_STAFF_COUNTY_A');
    expect(src).toContain('CANARY_ID_COUNTY_B');
    expect(src.match(/\btest\(/g)).toHaveLength(24);
  });

  it('emits undeclared cells as fixme, so they are counted, not dropped', () => {
    const out = renderPlaywright(
      expandMatrix(parseMatrix(MODEL.replace('    staff: deny\n', ''))).cells,
    );
    expect(out.match(/test\.fixme\(/g)).toHaveLength(4);
    expect(out).toContain('UNDECLARED');
  });
});

// Phase 2: a denied caller must not learn whether a record exists.
describe('existence probes', () => {
  const PROBED = `${MODEL}existence_probes:\n  - GET /persons/{id}\n`;

  it('parses the probe list, and rejects a probe naming no declared endpoint', () => {
    expect(parseMatrix(PROBED).existenceProbes).toEqual(['GET /persons/{id}']);
    expect(parseMatrix(MODEL).existenceProbes).toEqual([]);
    expect(() =>
      parseMatrix(`${MODEL}existence_probes:\n  - GET /nope/{id}\n`),
    ).toThrow(/GET \/nope\/\{id\}.*not in endpoints/);
  });

  const model = parseMatrix(PROBED);
  const src = renderPlaywright(
    expandMatrix(model).cells,
    model.existenceProbes,
  );

  it('probes every denied cell of a probed endpoint, and no allowed cell', () => {
    // family + staff are own-tenant: 2 roles x 2 cross-tenant pairs denied.
    // examiner is allow everywhere, so it is never probed.
    expect(src.match(/existence is not revealed/g)).toHaveLength(4);
    expect(src).not.toMatch(/examiner@[^']*existence is not revealed/);
  });

  it('compares status and body shape against a known-absent id', () => {
    expect(src).toContain("env('CANARY_ABSENT_ID')");
    expect(src).toContain('expect(absent.status()).toBe(present.status())');
    expect(src).toContain(
      'expect(await shape(absent)).toEqual(await shape(present))',
    );
  });

  it('adds nothing when no probes are declared', () => {
    const plain = renderPlaywright(expandMatrix(parseMatrix(MODEL)).cells);
    expect(plain).not.toContain('existence');
  });
});
