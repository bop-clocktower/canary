/**
 * Ported from tests/unit/test_guardian_diff.py — OpenAPI diff extraction.
 * Asserts the same cases as the Python oracle, plus a few extra branch cases.
 */

import { describe, expect, it } from 'vitest';

import {
  ChangeType,
  classifyChanges,
  extractApiDiff,
} from '../src/guardian/diff-extractor.js';

type Spec = Record<string, unknown>;

const V1_PATHS: Record<string, unknown> = {
  '/v2/members': {
    get: { operationId: 'listMembers', summary: 'List members' },
    post: { operationId: 'createMember', summary: 'Create member' },
  },
  '/v2/members/{id}': {
    get: { operationId: 'getMember', summary: 'Get member' },
    put: { operationId: 'updateMember', summary: 'Update member' },
  },
  '/v2/auth/login': {
    post: { operationId: 'login', summary: 'Login' },
  },
};

const SPEC_V1: Spec = { openapi: '3.0.0', paths: V1_PATHS };

const SPEC_V2_ADD_ENDPOINT: Spec = {
  openapi: '3.0.0',
  paths: {
    ...V1_PATHS,
    '/v2/members/bulk-import': {
      post: { operationId: 'bulkImport', summary: 'Bulk import members' },
    },
  },
};

const SPEC_V2_REMOVE_ENDPOINT: Spec = {
  openapi: '3.0.0',
  paths: {
    '/v2/members': V1_PATHS['/v2/members'],
    '/v2/auth/login': V1_PATHS['/v2/auth/login'],
  },
};

const SPEC_V2_CHANGE_METHOD: Spec = {
  openapi: '3.0.0',
  paths: {
    '/v2/members': {
      get: { operationId: 'listMembers', summary: 'List members — updated' },
      post: { operationId: 'createMember', summary: 'Create member' },
    },
    '/v2/members/{id}': V1_PATHS['/v2/members/{id}'],
    '/v2/auth/login': V1_PATHS['/v2/auth/login'],
  },
};

describe('extractApiDiff', () => {
  it('no changes returns empty', () => {
    const diff = extractApiDiff(SPEC_V1, SPEC_V1);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toEqual([]);
    expect(diff.isEmpty).toBe(true);
  });

  it('detects a new endpoint', () => {
    const diff = extractApiDiff(SPEC_V1, SPEC_V2_ADD_ENDPOINT);
    expect(diff.added).toHaveLength(1);
    const added = diff.added[0]!;
    expect(added.path).toBe('/v2/members/bulk-import');
    expect(added.method).toBe('post');
    expect(added.change_type).toBe(ChangeType.ADDED);
    expect(diff.isEmpty).toBe(false);
  });

  it('detects a removed endpoint', () => {
    const diff = extractApiDiff(SPEC_V1, SPEC_V2_REMOVE_ENDPOINT);
    const removedPaths = new Set(diff.removed.map((c) => c.path));
    expect(removedPaths.has('/v2/members/{id}')).toBe(true);
  });

  it('detects a changed summary', () => {
    const diff = extractApiDiff(SPEC_V1, SPEC_V2_CHANGE_METHOD);
    const changedPaths = new Set(diff.changed.map((c) => c.path));
    expect(changedPaths.has('/v2/members')).toBe(true);
  });

  it('counts multiple methods on the same path separately', () => {
    const v2: Spec = {
      openapi: '3.0.0',
      paths: {
        '/v2/members': {
          get: { operationId: 'listMembers', summary: 'List' },
          // POST removed
        },
      },
    };
    const diff = extractApiDiff(SPEC_V1, v2);
    const removedMethods = new Set(
      diff.removed.map((c) => `${c.path} ${c.method}`),
    );
    expect(removedMethods.has('/v2/members post')).toBe(true);
  });

  it('treats an empty before spec as all-added', () => {
    const diff = extractApiDiff({ openapi: '3.0.0', paths: {} }, SPEC_V1);
    expect(diff.added).toHaveLength(5); // 5 operations total in SPEC_V1
  });

  it('carries the operationId on an added endpoint', () => {
    const diff = extractApiDiff(SPEC_V1, SPEC_V2_ADD_ENDPOINT);
    expect(diff.added[0]!.operation_id).toBe('bulkImport');
  });

  it('falls back to the before operationId when the changed op lacks one', () => {
    const before: Spec = {
      openapi: '3.0.0',
      paths: { '/x': { get: { operationId: 'getX', summary: 'a' } } },
    };
    const after: Spec = {
      openapi: '3.0.0',
      paths: { '/x': { get: { summary: 'b' } } },
    };
    const diff = extractApiDiff(before, after);
    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0]!.operation_id).toBe('getX');
  });

  it('skips falsy (empty-dict) operations like Python `if op:`', () => {
    const after: Spec = {
      openapi: '3.0.0',
      paths: { '/y': { get: {} } },
    };
    const diff = extractApiDiff({ openapi: '3.0.0', paths: {} }, after);
    expect(diff.added).toEqual([]);
    expect(diff.isEmpty).toBe(true);
  });

  it('keeps a present-null operationId as null (does not coerce to "")', () => {
    // Python `dict.get("operationId", "")` returns None on a present-null key;
    // only a MISSING key yields the "" default (asserted by `/z2` below).
    const after: Spec = {
      openapi: '3.0.0',
      paths: {
        '/z': { get: { operationId: null, summary: 's' } },
        '/z2': { get: { summary: 'no id' } },
      },
    };
    const diff = extractApiDiff({ openapi: '3.0.0', paths: {} }, after);
    const byPath = new Map(diff.added.map((c) => [c.path, c]));
    expect(byPath.get('/z')!.operation_id).toBeNull();
    expect(byPath.get('/z')!.summary).toBe('s');
    expect(byPath.get('/z2')!.operation_id).toBe('');
  });
});

describe('classifyChanges', () => {
  it('params only', () => {
    const before = { parameters: [{ name: 'id', in: 'path' }] };
    const after = {
      parameters: [
        { name: 'id', in: 'path' },
        { name: 'q', in: 'query' },
      ],
    };
    expect(classifyChanges(before, after)).toEqual(['params']);
  });

  it('request-body change', () => {
    const before = {
      requestBody: { content: { 'application/json': { schema: { a: 1 } } } },
    };
    const after = {
      requestBody: { content: { 'application/json': { schema: { a: 2 } } } },
    };
    expect(classifyChanges(before, after)).toEqual(['request-body']);
  });

  it('a new response code is status-codes', () => {
    const before = { responses: { '200': { description: 'ok' } } };
    const after = {
      responses: { '200': { description: 'ok' }, '404': { description: 'nf' } },
    };
    expect(classifyChanges(before, after)).toEqual(['status-codes']);
  });

  it('a changed existing response schema is response', () => {
    const before = {
      responses: { '200': { content: { json: { schema: { a: 1 } } } } },
    };
    const after = {
      responses: { '200': { content: { json: { schema: { a: 2 } } } } },
    };
    expect(classifyChanges(before, after)).toEqual(['response']);
  });

  it('a security change is auth', () => {
    const before = { security: [{ apiKey: [] }] };
    const after = { security: [{ bearer: [] }] };
    expect(classifyChanges(before, after)).toEqual(['auth']);
  });

  it('multiple changes are ordered by the vocabulary', () => {
    const before = {
      parameters: [{ name: 'id' }],
      responses: { '200': { schema: { a: 1 } } },
    };
    const after = {
      parameters: [{ name: 'id' }, { name: 'q' }],
      responses: { '200': { schema: { a: 2 } } },
    };
    // VALID_CHANGES order: params before response.
    expect(classifyChanges(before, after)).toEqual(['params', 'response']);
  });

  it('a non-vocabulary change returns empty', () => {
    // A summary/description-only edit is a "changed" op with no contract delta.
    expect(classifyChanges({ summary: 'old' }, { summary: 'new' })).toEqual([]);
  });
});
