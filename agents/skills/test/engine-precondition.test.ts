// The built-engine precondition for this suite (#1221).
//
// canary-cassandra's CLI delegates to the engine in `ts/dist`, so its suite and
// the cassandra rows of gate-conformance need a build. Without one, an unbuilt
// worktree used to report 16 unrelated-looking assertion failures. The
// precondition turns that into ONE error that names the missing build.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import config from '../vitest.config.js';
import { checkEnginePrecondition } from './engine-precondition.js';

const MODULES = ['vacuity-scanner.js', 'test-files.js', 'gate-result.js'];

const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

function mkTmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-precond-'));
  tmps.push(d);
  return d;
}

/** A fake checkout: `<root>/ts/src/x.ts` and a `<root>/ts/dist` engine. */
function fakeCheckout(): { root: string; src: string; dist: string } {
  const root = mkTmp();
  const src = path.join(root, 'ts', 'src');
  const dist = path.join(root, 'ts', 'dist');
  fs.mkdirSync(path.join(src, 'core'), { recursive: true });
  fs.mkdirSync(path.join(dist, 'core'), { recursive: true });
  fs.writeFileSync(path.join(src, 'core', 'vacuity-scanner.ts'), '');
  for (const m of MODULES) fs.writeFileSync(path.join(dist, 'core', m), '');
  return { root, src, dist };
}

function setMtime(file: string, epochSeconds: number): void {
  fs.utimesSync(file, epochSeconds, epochSeconds);
}

describe('engine precondition (#1221)', () => {
  it('fails once, naming the missing build and every directory it tried', () => {
    const missing = path.join(mkTmp(), 'ts', 'dist');
    const other = path.join(mkTmp(), 'dist', 'engine');
    expect(() =>
      checkEnginePrecondition({ candidates: [missing, other] }),
    ).toThrowError(/ts\/dist missing — run `npm run build` in ts\//);
    expect(() =>
      checkEnginePrecondition({ candidates: [missing, other] }),
    ).toThrowError(new RegExp(`${missing}.*${other}`));
  });

  it('treats a dist without the vacuity modules as missing', () => {
    // A half-built or unrelated `dist/` must not satisfy the check: it is the
    // three modules the cassandra CLI imports that the suite needs.
    const { dist } = fakeCheckout();
    fs.rmSync(path.join(dist, 'core', 'gate-result.js'));
    expect(() => checkEnginePrecondition({ candidates: [dist] })).toThrowError(
      /ts\/dist missing/,
    );
  });

  it('returns the resolved engine directory when the build is present', () => {
    const { dist, src } = fakeCheckout();
    expect(
      checkEnginePrecondition({
        candidates: [dist],
        srcDir: src,
        warn: () => {},
      }),
    ).toBe(dist);
  });

  it('warns, without failing, when ts/src is newer than ts/dist', () => {
    const { dist, src } = fakeCheckout();
    for (const m of MODULES) setMtime(path.join(dist, 'core', m), 1_000);
    setMtime(path.join(src, 'core', 'vacuity-scanner.ts'), 2_000);
    const warnings: string[] = [];
    const got = checkEnginePrecondition({
      candidates: [dist],
      srcDir: src,
      warn: (m) => warnings.push(m),
    });
    expect(got).toBe(dist);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/older than ts\/src/);
    expect(warnings[0]).toContain('npm run build');
  });

  it('stays silent when the build is newer than every source file', () => {
    const { dist, src } = fakeCheckout();
    setMtime(path.join(src, 'core', 'vacuity-scanner.ts'), 1_000);
    for (const m of MODULES) setMtime(path.join(dist, 'core', m), 2_000);
    const warnings: string[] = [];
    checkEnginePrecondition({
      candidates: [dist],
      srcDir: src,
      warn: (m) => warnings.push(m),
    });
    expect(warnings).toEqual([]);
  });

  it('skips the staleness check for an engine outside the checkout', () => {
    // CANARY_ENGINE_DIR / a packaged dist/engine has no ts/src beside it to
    // compare against; that is not a reason to warn.
    const { dist } = fakeCheckout();
    const warnings: string[] = [];
    checkEnginePrecondition({
      candidates: [dist],
      srcDir: path.join(mkTmp(), 'no-such-src'),
      warn: (m) => warnings.push(m),
    });
    expect(warnings).toEqual([]);
  });

  it('is registered as the suite globalSetup in vitest.config.ts', () => {
    const setup = config.test?.globalSetup;
    const entries = Array.isArray(setup) ? setup : [setup];
    expect(entries).toContain('test/engine-precondition.ts');
  });
});
