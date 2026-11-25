/**
 * canary-cry flows.json schema (#608 P1, SC5).
 *
 * Every error names the JSON path at fault, so `validate` and `matrix` exit 2
 * before a matrix exists. Unknown keys are errors: a `write` typed for
 * `writes` would otherwise drop a step out of every write-keyed pattern
 * without a word.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  loadFlows,
  loadTargets,
  validateFlows,
} from '../claude-code/canary-cry/scripts/schema.mjs';

const tmps: string[] = [];
afterEach(() => {
  while (tmps.length) fs.rmSync(tmps.pop()!, { recursive: true, force: true });
});
function writeTmp(name: string, body: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-cry-schema-'));
  tmps.push(dir);
  const file = path.join(dir, name);
  fs.writeFileSync(file, body);
  return file;
}

/** A minimal valid flows document; every test mutates a fresh copy. */
function flowsDoc(): any {
  return {
    version: 1,
    fixtures: { card: '4242424242424242' },
    flows: [
      {
        id: 'checkout',
        risk: 5,
        steps: [
          { id: 'open', action: 'goto', url: '/cart' },
          {
            id: 'card',
            action: 'fill',
            selector: '[name=card]',
            value: '{{fixture.card}}',
          },
          {
            id: 'pay',
            action: 'click',
            selector: 'button[type=submit]',
            writes: true,
            awaitResponse: 'POST /api/orders',
          },
        ],
        invariants: [
          {
            id: 'one-order',
            probe: {
              http: {
                method: 'GET',
                path: '/api/orders?u={{account.A.id}}',
              },
            },
            expect: { jsonPath: '$.length', delta: 1 },
          },
        ],
      },
    ],
  };
}

/** Apply `mutate` to a fresh valid doc and return its errors. */
function errorsAfter(mutate: (doc: any) => void): string[] {
  const doc = flowsDoc();
  mutate(doc);
  return validateFlows(doc);
}

describe('validateFlows', () => {
  it('accepts the spec-shaped document', () => {
    expect(validateFlows(flowsDoc())).toEqual([]);
  });

  it('accepts an empty flows list (the matrix abstains; it is not a schema error)', () => {
    expect(validateFlows({ version: 1, flows: [] })).toEqual([]);
  });

  it('accepts a "//" comment key in any object', () => {
    expect(
      errorsAfter((d) => {
        d['//'] = 'top';
        d.flows[0]['//'] = 'flow';
        d.flows[0].steps[0]['//'] = 'step';
      }),
    ).toEqual([]);
  });

  it('rejects a non-object document', () => {
    expect(validateFlows([])).toEqual(['$: must be an object']);
  });

  it.each<[string, (d: any) => void, string]>([
    ['version', (d) => (d.version = 2), '$.version: must be 1'],
    ['flows', (d) => (d.flows = {}), '$.flows: must be an array'],
    [
      'action',
      (d) => (d.flows[0].steps[0].action = 'hover'),
      '$.flows[0].steps[0].action: must be one of goto, fill, click, select, press, waitFor',
    ],
    [
      'required field',
      (d) => delete d.flows[0].steps[0].url,
      '$.flows[0].steps[0].url: must be a non-empty string',
    ],
    [
      'typo key',
      (d) => (d.flows[0].steps[2].write = true),
      '$.flows[0].steps[2].write: unknown key',
    ],
    [
      'writes',
      (d) => (d.flows[0].steps[2].writes = 'yes'),
      '$.flows[0].steps[2].writes: must be true or false',
    ],
    [
      'awaitResponse',
      (d) => (d.flows[0].steps[2].awaitResponse = 'orders'),
      "$.flows[0].steps[2].awaitResponse: must be '<METHOD> /path', e.g. 'POST /api/orders'",
    ],
    [
      'risk',
      (d) => (d.flows[0].risk = 6),
      '$.flows[0].risk: must be an integer 1-5',
    ],
    [
      'duplicate step id',
      (d) => (d.flows[0].steps[1].id = 'open'),
      "$.flows[0].steps[1].id: duplicate id 'open'",
    ],
    [
      'colon in id',
      (d) => (d.flows[0].id = 'check:out'),
      '$.flows[0].id: must match /^[a-z0-9][a-z0-9-]*$/',
    ],
    [
      'empty steps',
      (d) => (d.flows[0].steps = []),
      '$.flows[0].steps: must be a non-empty array',
    ],
    [
      'undeclared fixture',
      (d) => (d.flows[0].steps[1].value = '{{fixture.cvv}}'),
      "$.flows[0].steps[1].value: fixture 'cvv' is not in $.fixtures",
    ],
    [
      'unknown template',
      (d) => (d.flows[0].steps[1].value = '{{secret.x}}'),
      '$.flows[0].steps[1].value: unknown template {{secret.x}}',
    ],
    [
      'two probe kinds',
      (d) => (d.flows[0].invariants[0].probe.shell = { argv: ['true'] }),
      '$.flows[0].invariants[0].probe: must declare exactly one of http, shell',
    ],
    [
      'shell string',
      (d) =>
        (d.flows[0].invariants[0].probe = { shell: { argv: 'psql -c x' } }),
      '$.flows[0].invariants[0].probe.shell.argv: must be a non-empty array of strings (run with execFile, never as a shell string)',
    ],
    [
      'probe path',
      (d) => (d.flows[0].invariants[0].probe.http.path = 'api/orders'),
      "$.flows[0].invariants[0].probe.http.path: must start with '/'",
    ],
    [
      'probe method',
      (d) => (d.flows[0].invariants[0].probe.http.method = 'FETCH'),
      '$.flows[0].invariants[0].probe.http.method: must be one of GET, HEAD, POST, PUT, PATCH, DELETE',
    ],
    [
      'delta and equals',
      (d) => (d.flows[0].invariants[0].expect.equals = 1),
      '$.flows[0].invariants[0].expect: must declare exactly one of delta, equals',
    ],
    [
      'delta type',
      (d) => (d.flows[0].invariants[0].expect.delta = '1'),
      '$.flows[0].invariants[0].expect.delta: must be a number',
    ],
    [
      'jsonPath',
      (d) => (d.flows[0].invariants[0].expect.jsonPath = 'length'),
      "$.flows[0].invariants[0].expect.jsonPath: must be a string starting with '$'",
    ],
    [
      'symptoms',
      (d) => (d.flows[0].symptoms = { selectors: [] }),
      '$.flows[0].symptoms.selectors: must be a non-empty array',
    ],
    [
      'fixture value',
      (d) => (d.fixtures.card = { n: 1 }),
      '$.fixtures.card: must be a string, number or boolean',
    ],
  ])('names the JSON path of a bad %s', (_label, mutate, expected) => {
    expect(errorsAfter(mutate)).toContain(expected);
  });

  it('allows an empty fill value (clearing a field is a real step)', () => {
    expect(errorsAfter((d) => (d.flows[0].steps[1].value = ''))).toEqual([]);
  });

  it('accepts a shell probe given as an argv array', () => {
    const shell = { argv: ['psql', '-tAc', 'select count(*) from orders'] };
    expect(
      errorsAfter((d) => (d.flows[0].invariants[0].probe = { shell })),
    ).toEqual([]);
  });

  it.each(['toString', 'constructor', 'hasOwnProperty'])(
    'does not resolve the inherited key {{fixture.%s}} as declared',
    (name) => {
      // `fixtures` is parsed JSON: on a plain lookup an inherited key reads as
      // declared, and a typo'd fixture would ship to the runtime unresolved.
      expect(
        errorsAfter((d) => (d.flows[0].steps[1].value = `{{fixture.${name}}}`)),
      ).toContain(
        `$.flows[0].steps[1].value: fixture '${name}' is not in $.fixtures`,
      );
    },
  );
});

describe('loadFlows', () => {
  it('returns the document when it validates', () => {
    const file = writeTmp('flows.json', JSON.stringify(flowsDoc()));
    const r = loadFlows(file);
    expect(r.errors).toEqual([]);
    expect(r.doc.flows[0].id).toBe('checkout');
  });

  it('names a missing file', () => {
    const file = path.join(os.tmpdir(), 'canary-cry-no-such', 'flows.json');
    expect(loadFlows(file)).toEqual({
      doc: null,
      errors: [`flows file not found: ${file}`],
    });
  });

  it('names a file that is not JSON', () => {
    const file = writeTmp('flows.json', '{ "version": 1, ');
    const r = loadFlows(file);
    expect(r.doc).toBeNull();
    expect(r.errors[0]).toMatch(
      new RegExp(`^flows file is not valid JSON: ${file}: `),
    );
  });

  it('prefixes every schema error with the file, and returns no doc', () => {
    const file = writeTmp(
      'flows.json',
      JSON.stringify({ version: 2, flows: [] }),
    );
    expect(loadFlows(file)).toEqual({
      doc: null,
      errors: [`${file}: $.version: must be 1`],
    });
  });
});

describe('loadTargets', () => {
  it('names a missing file', () => {
    const file = path.join(os.tmpdir(), 'canary-cry-no-such', 'targets.json');
    expect(loadTargets(file).errors).toEqual([
      `targets file not found: ${file}`,
    ]);
  });

  it('prefixes schema errors with the file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-cry-targets-'));
    tmps.push(dir);
    const file = path.join(dir, 'targets.json');
    fs.writeFileSync(
      file,
      JSON.stringify({ version: 2, prodHosts: [], targets: {} }),
    );
    expect(loadTargets(file).errors).toContain(`${file}: $.version: must be 1`);
  });
});

describe('the shipped examples', () => {
  const scripts = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'claude-code',
    'canary-cry',
    'scripts',
  );

  it('flows.example.json and targets.example.json validate together', () => {
    const flows = loadFlows(path.join(scripts, 'flows.example.json'));
    expect(flows.errors).toEqual([]);
    const ids = new Set<string>(flows.doc.flows.map((f: any) => f.id));
    const targets = loadTargets(
      path.join(scripts, 'targets.example.json'),
      ids,
    );
    expect(targets.errors).toEqual([]);
  });
});
