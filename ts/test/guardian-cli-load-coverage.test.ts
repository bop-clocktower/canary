/**
 * `guardian analyze --coverage` -- how a coverage-report file is read.
 *
 * `loadCoverage` is the guardian's tolerance boundary for a file it did not
 * write. Its whole job is to answer "no rows" rather than throw, for every
 * shape a CI producer might hand it: absent, unparseable, or structurally not
 * what the contract promised. That matters because the guardian must still
 * produce an impact summary when the coverage step upstream failed -- but it
 * must not pretend a broken file described full coverage.
 *
 * Every case below asserts the *rendered verdict* for the changed endpoint,
 * because that is where a coverage row actually shows up:
 *
 *   no rows -> "no existing tests"   rows -> "N existing test(s)"
 *
 * An earlier draft asserted only that the emitted api-delta still reported one
 * added endpoint. That number is identical whether coverage loaded or not, so
 * it would have passed against a `loadCoverage` that silently returned the
 * wrong rows -- a test that runs the code without pinning its result.
 *
 * Scope note: this file deliberately covers the pure reading/degradation logic
 * only. `defaultDeps()` -- the production `spawnSync`/`process.stdout` wiring
 * -- is left uncovered on purpose; asserting the shape of that wiring would be
 * coverage theater rather than a behavioral claim.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { invokeGuardian, mkTmp, rmTmp } from './guardian-cli-testkit.js';

let tmp: string;

beforeEach(() => {
  tmp = mkTmp();
});

afterEach(() => {
  rmTmp(tmp);
});

/** A before/after spec pair whose diff adds `POST /members/bulk`. */
function writeSpecs(): [string, string] {
  const before = join(tmp, 'before.json');
  const after = join(tmp, 'after.json');
  writeFileSync(
    before,
    JSON.stringify({
      openapi: '3.0.0',
      paths: { '/members': { get: { operationId: 'list' } } },
    }),
  );
  writeFileSync(
    after,
    JSON.stringify({
      openapi: '3.0.0',
      paths: {
        '/members': { get: { operationId: 'list' } },
        '/members/bulk': { post: { operationId: 'bulk' } },
      },
    }),
  );
  return [before, after];
}

/** Run `analyze` over that diff with `--coverage` pointed at `coveragePath`. */
async function analyzeWithCoverage(
  coveragePath: string,
): Promise<{ code: number; stdout: string }> {
  const [before, after] = writeSpecs();
  const res = await invokeGuardian([
    'analyze',
    'abc1234',
    '--spec-before',
    before,
    '--spec-after',
    after,
    '--coverage',
    coveragePath,
    '--dry-run',
  ]);
  return { code: res.code, stdout: res.stdout };
}

describe('guardian analyze --coverage', () => {
  it('reports the endpoint as covered when the file carries a matching row', async () => {
    const p = join(tmp, 'coverage.json');
    writeFileSync(
      p,
      JSON.stringify({
        endpoints: [{ method: 'POST', path: '/members/bulk', covered: true }],
      }),
    );

    const { code, stdout } = await analyzeWithCoverage(p);

    expect(code).toBe(0);
    // This is the assertion that makes the rest of the file meaningful: it
    // only holds if the row was really parsed and matched to the endpoint.
    expect(stdout).toContain('1 existing test(s)');
    expect(stdout).not.toContain('no existing tests');
  });

  it('still analyzes the diff when the coverage file is absent', async () => {
    // The upstream coverage step failing must not take the impact summary
    // down with it -- the API diff is still knowable without coverage.
    const { code, stdout } = await analyzeWithCoverage(
      join(tmp, 'does-not-exist.json'),
    );

    expect(code).toBe(0);
    expect(stdout).toContain('POST /members/bulk');
    expect(stdout).toContain('no existing tests');
  });

  it('still analyzes the diff when the coverage file is not valid JSON', async () => {
    const p = join(tmp, 'broken.json');
    writeFileSync(p, '{ this is not json');

    const { code, stdout } = await analyzeWithCoverage(p);

    // Degrades to "no coverage rows", never a crash and never a stack trace.
    expect(code).toBe(0);
    expect(stdout).toContain('no existing tests');
  });

  it.each([
    ['a top-level array', '[]'],
    ['an object with no endpoints key', '{"other":1}'],
    ['endpoints that is not an array', '{"endpoints":{"a":1}}'],
    ['a JSON scalar', '"just a string"'],
    ['JSON null', 'null'],
  ])(
    'reads %s as no coverage rather than as coverage',
    async (_label, body) => {
      const p = join(tmp, 'shape.json');
      writeFileSync(p, body);

      const { code, stdout } = await analyzeWithCoverage(p);

      // Each of these is a shape the contract does not promise. None may
      // crash, and -- the part that matters -- none may be reported as though
      // the endpoint had tests behind it.
      expect(code).toBe(0);
      expect(stdout).toContain('no existing tests');
      expect(stdout).not.toContain('existing test(s)');
    },
  );
});
