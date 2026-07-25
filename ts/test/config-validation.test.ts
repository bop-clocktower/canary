/**
 * Tests for the `config-validation` port (`agent/core/config_validation.py`).
 *
 * The Python module has no dedicated unit test in the source tree; these pin
 * the three-way "absent / malformed / ok" contract the callers depend on.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readJsonWithWarning } from '../src/core/config-validation.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'canary-cfg-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('readJsonWithWarning', () => {
  it('absent file → [null, null] (not an error)', () => {
    const [data, warning] = readJsonWithWarning(join(dir, 'nope.json'));
    expect(data).toBeNull();
    expect(warning).toBeNull();
  });

  it('valid JSON → [data, null]', () => {
    const path = join(dir, 'ok.json');
    writeFileSync(path, JSON.stringify({ a: 1, b: [2, 3] }), 'utf-8');
    const [data, warning] = readJsonWithWarning(path);
    expect(data).toEqual({ a: 1, b: [2, 3] });
    expect(warning).toBeNull();
  });

  it('malformed JSON → [null, warning] (never raises)', () => {
    const path = join(dir, 'broken.json');
    writeFileSync(path, '{ not: valid json', 'utf-8');
    const [data, warning] = readJsonWithWarning(path);
    expect(data).toBeNull();
    expect(warning).not.toBeNull();
    expect(warning).toContain('not valid JSON');
    expect(warning).toContain(path);
  });
});
