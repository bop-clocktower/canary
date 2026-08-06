/**
 * #562 -- type-only modules must not raise coverage-verified findings.
 *
 * A `types.ts` holding nothing but interfaces has real lcov rows: every line
 * reports as uncovered, faithfully, because a type declaration does not exist
 * at runtime. The measurement is correct and the finding is still
 * unsatisfiable -- there is no function to call and no branch to take, so a
 * reviewer's only correct response is a thumbs-down. Seven of seven misses in
 * the adjudicated sample behind #562 were this class.
 *
 * Detection is deliberately two-stage (name gate, then content confirmation):
 * the name alone would suppress a `types.ts` that also exports an enum or a
 * const map, which is common in TypeScript and would hide real findings.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { isTypeOnlyModule } from '../src/guardian/coverage.js';
import { invokeGuardian, mkTmp, rmTmp } from './guardian-cli-testkit.js';

let root: string;

function write(rel: string, body: string): string {
  const full = join(root, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, body, 'utf-8');
  return rel;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'canary-type-only-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('isTypeOnlyModule (#562)', () => {
  it('a types.ts holding only interfaces is type-only', () => {
    // The representative case from the adjudicated sample: reported as
    // "lines 1-39: 39 uncovered", coverage-verified, high severity.
    const path = write(
      'src/ConfirmModal/types.ts',
      [
        "import type { ReactNode } from 'react';",
        '',
        'export interface ConfirmModalProps {',
        '  visible: boolean;',
        '  title: string;',
        '  message: ReactNode;',
        '}',
        '',
      ].join('\n'),
    );
    expect(isTypeOnlyModule(path, root)).toBe(true);
  });

  it('a call statement makes it runtime, even with no declaration keyword', () => {
    // The dangerous direction. A keyword denylist misses this entirely --
    // there is no const/function/class here -- and suppressing it would hide
    // real untested code, which is worse than the noise being fixed.
    const path = write(
      'src/types.ts',
      [
        "import { register } from './registry';",
        '',
        'export interface Widget {',
        '  id: string;',
        '}',
        '',
        "register('widget');",
        '',
      ].join('\n'),
    );
    expect(isTypeOnlyModule(path, root)).toBe(false);
  });

  it('an enum is runtime -- a types.ts holding one is NOT suppressed', () => {
    // The over-suppression this design exists to prevent: an enum emits a
    // real object, so uncovered lines in it are a real, satisfiable finding.
    const path = write(
      'src/types.ts',
      ['export enum Role {', '  Admin = 1,', '  User = 2,', '}', ''].join('\n'),
    );
    expect(isTypeOnlyModule(path, root)).toBe(false);
  });

  it('a const map is runtime -- not suppressed', () => {
    const path = write(
      'src/api.types.ts',
      [
        'export interface Cfg {',
        '  url: string;',
        '}',
        '',
        "export const DEFAULTS: Cfg = { url: 'https://x' };",
        '',
      ].join('\n'),
    );
    expect(isTypeOnlyModule(path, root)).toBe(false);
  });

  it('a side-effect import is runtime -- not suppressed', () => {
    // No binding, so TypeScript never elides it.
    const path = write(
      'src/types.ts',
      [
        "import './polyfill';",
        '',
        'export interface A {',
        '  b: string;',
        '}',
        '',
      ].join('\n'),
    );
    expect(isTypeOnlyModule(path, root)).toBe(false);
  });

  it('keywords inside comments do not make a file runtime', () => {
    // Recall guard: "the class applied to the root" is ordinary prose in a
    // Props file, and a keyword denylist would fail every such file.
    const path = write(
      'src/types.ts',
      [
        '/**',
        ' * Props. The class name is applied to the root element, and the',
        ' * onSelect function fires on change.',
        ' */',
        'export interface Props {',
        '  // the class applied to the root',
        '  className: string;',
        '}',
        '',
      ].join('\n'),
    );
    expect(isTypeOnlyModule(path, root)).toBe(true);
  });

  it('a reserved word as a property name does not make a file runtime', () => {
    const path = write(
      'src/types.ts',
      [
        'export interface Props {',
        '  class?: string;',
        '  function?: () => void;',
        '}',
        '',
      ].join('\n'),
    );
    expect(isTypeOnlyModule(path, root)).toBe(true);
  });

  it('generated type aliases are type-only', () => {
    // The `sanity.types.ts` case from the adjudicated sample.
    const path = write(
      'src/sanity-content/sanity.types.ts',
      [
        'export type Post = {',
        '  _id: string;',
        '  title?: string;',
        '};',
        '',
        'export type AllPosts = Array<Post>;',
        '',
      ].join('\n'),
    );
    expect(isTypeOnlyModule(path, root)).toBe(true);
  });

  it('an ordinary source name is never a candidate, whatever it holds', () => {
    // The name gate is what keeps this off the I/O path for every file in
    // the diff; a pure-interface widget.ts simply keeps its finding.
    const path = write(
      'src/widget.ts',
      ['export interface Widget {', '  id: string;', '}', ''].join('\n'),
    );
    expect(isTypeOnlyModule(path, root)).toBe(false);
  });

  it('an unreadable file is unproven, so the finding survives', () => {
    expect(isTypeOnlyModule('src/does-not-exist.types.ts', root)).toBe(false);
  });
});

// The measured end of #562: precision 13/20 against a 0.8 promotion bar, with
// every miss in this class. The unit tests above prove the predicate; these
// prove the pipeline actually consults it.
describe('pr-check suppresses type-only modules (#562)', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkTmp();
  });
  afterEach(() => rmTmp(tmp));

  const DIFF_TYPES = `diff --git a/src/ConfirmModal/types.ts b/src/ConfirmModal/types.ts
index 1111111..2222222 100644
--- a/src/ConfirmModal/types.ts
+++ b/src/ConfirmModal/types.ts
@@ -0,0 +1,4 @@
+export interface ConfirmModalProps {
+  visible: boolean;
+  title: string;
+}
`;

  function seed(): string {
    mkdirSync(join(tmp, 'src', 'ConfirmModal'), { recursive: true });
    writeFileSync(
      join(tmp, 'src', 'ConfirmModal', 'types.ts'),
      'export interface ConfirmModalProps {\n  visible: boolean;\n  title: string;\n}\n',
      'utf-8',
    );
    // lcov faithfully reports every line unhit -- the measurement is correct,
    // which is exactly why the heuristic-tier fix (#413) cannot reach it.
    const lcov = join(tmp, 'lcov.info');
    writeFileSync(
      lcov,
      'SF:src/ConfirmModal/types.ts\nDA:1,0\nDA:2,0\nDA:3,0\nDA:4,0\nend_of_record\n',
      'utf-8',
    );
    return lcov;
  }

  it('raises no finding for a coverage-verified type-only module', async () => {
    const res = await invokeGuardian(
      ['pr-check', '--diff', '-', '--coverage', seed(), '--format', 'json'],
      { input: DIFF_TYPES, cwd: tmp },
    );
    const data = JSON.parse(res.stdout.slice(res.stdout.indexOf('{')));
    expect(data.findings).toEqual([]);
  });

  it('author-plan never proposes writing a test for an interface file', async () => {
    // `buildGaps` keeps its own copy of the filter chain, so the authoring
    // tier can regress independently -- the #565 precedent is that this
    // surface actually did propose `test_conftest_otel.py` on disk.
    seed();
    const res = await invokeGuardian(['author-plan', '--diff', '-', '--json'], {
      input: DIFF_TYPES,
      cwd: tmp,
    });
    const data = JSON.parse(res.stdout.slice(res.stdout.indexOf('{')));
    expect(data.intents).toEqual([]);
  });

  it('reports the suppression as a named skip, never as a pass', async () => {
    // #508/#579: the whole diff was suppressed, so this must abstain and say
    // what it dropped -- silently exiting 0 would be the false green.
    const res = await invokeGuardian(
      ['pr-check', '--diff', '-', '--coverage', seed(), '--format', 'json'],
      { input: DIFF_TYPES, cwd: tmp },
    );
    const data = JSON.parse(res.stdout.slice(res.stdout.indexOf('{')));
    expect(data.skipped).toContainEqual({
      name: 'src/ConfirmModal/types.ts',
      reason: 'type-only module',
    });
  });
});
