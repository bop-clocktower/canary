/**
 * Ported from tests/unit/test_guardian_delta.py — the api-delta.json v1 artifact.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ApiDiff,
  ChangeType,
  EndpointChange,
} from '../src/guardian/diff-extractor.js';
import { buildApiDelta, writeApiDelta } from '../src/guardian/delta-emitter.js';

function diffWithChanges(): ApiDiff {
  const added = new EndpointChange({
    path: '/challenges/{id}/enroll',
    method: 'post',
    change_type: ChangeType.ADDED,
    after: { responses: { '200': {} } },
  });
  const changed = new EndpointChange({
    path: '/rewards',
    method: 'get',
    change_type: ChangeType.CHANGED,
    before: {
      parameters: [{ name: 'id' }],
      responses: { '200': { schema: { a: 1 } } },
    },
    after: {
      parameters: [{ name: 'id' }, { name: 'q' }],
      responses: { '200': { schema: { a: 2 } } },
    },
  });
  return new ApiDiff([added], [], [changed]);
}

describe('buildApiDelta', () => {
  it('carries counts and schema version', () => {
    const delta = buildApiDelta(
      diffWithChanges(),
      'abc1234',
      'api',
      '2026-07-01T00:00:00Z',
    );
    expect(delta.schema_version).toBe(1);
    expect(delta.sut).toEqual({ sha: 'abc1234', suite: 'api' });
    expect(delta.generated).toBe('2026-07-01T00:00:00Z');
    expect(delta.summary).toEqual({
      added: 1,
      removed: 0,
      changed: 1,
      total: 2,
    });
  });

  it('upper-cases methods and keeps paths verbatim', () => {
    const delta = buildApiDelta(diffWithChanges(), 'x', 'api', 't');
    expect(delta.endpoints.added[0]).toEqual({
      method: 'POST',
      path: '/challenges/{id}/enroll',
    });
    expect(delta.endpoints.changed[0]!.method).toBe('GET');
    expect(delta.endpoints.changed[0]!.path).toBe('/rewards');
  });

  it('carries classified changes on a changed endpoint', () => {
    const delta = buildApiDelta(diffWithChanges(), 'x', 'api', 't');
    // params + response both changed on /rewards, ordered by VALID_CHANGES.
    expect(delta.endpoints.changed[0]!.changes).toEqual(['params', 'response']);
  });

  it('emits removed endpoints (method upper-cased)', () => {
    const removed = new EndpointChange({
      path: '/legacy',
      method: 'delete',
      change_type: ChangeType.REMOVED,
      before: { responses: { '204': {} } },
    });
    const delta = buildApiDelta(
      new ApiDiff([], [removed], []),
      'x',
      'api',
      't',
    );
    expect(delta.summary).toEqual({
      added: 0,
      removed: 1,
      changed: 0,
      total: 1,
    });
    expect(delta.endpoints.removed[0]).toEqual({
      method: 'DELETE',
      path: '/legacy',
    });
  });

  it('yields total zero for an empty diff', () => {
    const delta = buildApiDelta(new ApiDiff([], [], []), 'x', 'api', 't');
    expect(delta.summary.total).toBe(0);
    expect(delta.endpoints).toEqual({ added: [], removed: [], changed: [] });
  });
});

describe('writeApiDelta', () => {
  it('round-trips through the filesystem', () => {
    const dir = mkdtempSync(join(tmpdir(), 'guardian-delta-'));
    try {
      const delta = buildApiDelta(diffWithChanges(), 'x', 'api', 't');
      const out = join(dir, 'api-delta.json');
      writeApiDelta(delta, out);
      expect(JSON.parse(readFileSync(out, 'utf-8'))).toEqual(delta);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
