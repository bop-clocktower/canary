/**
 * #1290 remainder: three more ways a contract change read as "no API change".
 *
 * - `trace` operations were never iterated, so adding/removing one vanished.
 * - Top-level `security` applies to every operation that does not declare its
 *   own; changing it is an `auth` change on each of those operations.
 * - A local `$ref` was compared as its pointer string, so retyping the target
 *   schema changed nothing the diff could see.
 *
 * Each case asserts the endpoint AND its classified changes, since the
 * api-delta artifact carries both.
 */

import { describe, expect, it } from 'vitest';

import {
  classifyChanges,
  extractApiDiff,
} from '../src/guardian/diff-extractor.js';

type Spec = Record<string, unknown>;

/** `METHOD path [changes]` for every changed endpoint. */
function changedSummary(before: Spec, after: Spec): string[] {
  return extractApiDiff(before, after).changed.map(
    (c) =>
      `${c.method} ${c.path} [${classifyChanges(c.before, c.after).join(',')}]`,
  );
}

describe('trace operations (#1290)', () => {
  it('an added trace operation is reported as added', () => {
    const before: Spec = { paths: { '/x': { get: { operationId: 'g' } } } };
    const after: Spec = {
      paths: {
        '/x': { get: { operationId: 'g' }, trace: { operationId: 't' } },
      },
    };
    const diff = extractApiDiff(before, after);
    expect(diff.added.map((c) => `${c.method} ${c.path}`)).toEqual([
      'trace /x',
    ]);
  });
});

describe('global security (#1290)', () => {
  const spec = (scheme: string, ownSecurity?: unknown): Spec => ({
    security: [{ [scheme]: [] }],
    paths: {
      '/a': { get: { operationId: 'a' } },
      '/b': {
        get:
          ownSecurity === undefined
            ? { operationId: 'b' }
            : { operationId: 'b', security: ownSecurity },
      },
    },
  });

  it('changing top-level security is an auth change on every inheriting operation', () => {
    expect(changedSummary(spec('apiKey'), spec('oauth'))).toEqual([
      'get /a [auth]',
      'get /b [auth]',
    ]);
  });

  it('an operation that declares its own security (even []) does not inherit', () => {
    expect(changedSummary(spec('apiKey', []), spec('oauth', []))).toEqual([
      'get /a [auth]',
    ]);
  });

  it('moving a requirement from global to the operation is not a change', () => {
    const before: Spec = {
      security: [{ apiKey: [] }],
      paths: { '/a': { get: { operationId: 'a' } } },
    };
    const after: Spec = {
      paths: {
        '/a': { get: { operationId: 'a', security: [{ apiKey: [] }] } },
      },
    };
    expect(extractApiDiff(before, after).isEmpty).toBe(true);
  });
});

// Built from shallow pieces: the arch check caps literal nesting per function.
const ref = (pointer: string) => ({ $ref: pointer });
const typed = (type: string) => ({ schema: { type } });
const userSchema = (idType: string) => ({
  type: 'object',
  properties: { id: { type: idType } },
});
const NODE_SCHEMA = {
  type: 'object',
  properties: { next: ref('#/components/schemas/Node') },
};
const JSON_USER = {
  'application/json': { schema: ref('#/components/schemas/User') },
};
const GET_U = {
  operationId: 'getU',
  parameters: [ref('#/components/parameters/Q')],
  responses: { '200': { content: JSON_USER } },
};

/** A spec with one GET at `path`, optional path-level params, and components. */
function oneGet(
  path: string,
  op: unknown,
  components: unknown = {},
  shared?: unknown,
): Spec {
  const item =
    shared === undefined ? { get: op } : { parameters: shared, get: op };
  return { paths: { [path]: item }, components };
}

describe('local $ref targets (#1290)', () => {
  const refSpec = (idType: string, qType = 'string'): Spec =>
    oneGet('/u', GET_U, {
      parameters: { Q: { name: 'q', in: 'query', ...typed(qType) } },
      schemas: { User: userSchema(idType) },
    });

  it('retyping a referenced response schema is a response change', () => {
    expect(changedSummary(refSpec('string'), refSpec('integer'))).toEqual([
      'get /u [response]',
    ]);
  });

  it('retyping a referenced parameter is a params change', () => {
    expect(
      changedSummary(refSpec('string', 'string'), refSpec('string', 'integer')),
    ).toEqual(['get /u [params]']);
  });

  it('a referenced path-level parameter is overridden by the operation (name + in)', () => {
    const own = {
      parameters: [{ name: 'id', in: 'path', ...typed('string') }],
    };
    const mk = (pathType: string): Spec =>
      oneGet(
        '/u/{id}',
        own,
        { parameters: { Id: { name: 'id', in: 'path', ...typed(pathType) } } },
        [ref('#/components/parameters/Id')],
      );
    expect(extractApiDiff(mk('string'), mk('integer')).isEmpty).toBe(true);
  });

  it('a self-referencing schema terminates and still compares equal', () => {
    const op = {
      responses: { '200': { schema: ref('#/components/schemas/Node') } },
    };
    const recursive = (): Spec =>
      oneGet('/n', op, { schemas: { Node: NODE_SCHEMA } });
    expect(extractApiDiff(recursive(), recursive()).isEmpty).toBe(true);
  });

  it('an unresolvable or external $ref is compared as written', () => {
    const mk = (pointer: string): Spec =>
      oneGet('/e', { requestBody: ref(pointer) });
    expect(changedSummary(mk('other.yaml#/A'), mk('other.yaml#/A'))).toEqual(
      [],
    );
    expect(changedSummary(mk('#/missing/A'), mk('#/missing/B'))).toEqual([
      'get /e [request-body]',
    ]);
  });
});
