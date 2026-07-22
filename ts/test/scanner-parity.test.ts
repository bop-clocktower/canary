/**
 * Cross-language parity: the TS core/ scanners must produce the same output as
 * the Python originals (agent/core/{metadata,domain,fixture,static_linter}).
 *
 * Golden fixtures are captured by `scripts/capture_scanner_golden.py`. Both
 * sides scan a COPY of ts/test/fixtures/scanner-project in a fresh temp dir —
 * the committed fixture lives under `ts/test/fixtures/`, and DomainScanner
 * rejects any absolute path containing a "test"/"fixtures" segment, so it must
 * be scanned from a clean path to find anything.
 */

import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DomainScanner } from '../src/core/domain-scanner.js';
import { FixtureScanner } from '../src/core/fixture-scanner.js';
import {
  MetadataScanner,
  detectedLanguages,
} from '../src/core/metadata-scanner.js';
import { StaticLinter, type Finding } from '../src/core/static-linter.js';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE_SRC = join(here, 'fixtures', 'scanner-project');
const GOLDEN_DIR = join(here, 'fixtures', 'scanner-golden');

function golden(name: string): unknown {
  return JSON.parse(readFileSync(join(GOLDEN_DIR, `${name}.json`), 'utf-8'));
}

let projectRoot: string;
let tmpBase: string;

beforeAll(() => {
  tmpBase = mkdtempSync(join(tmpdir(), 'canary-scanner-'));
  projectRoot = join(tmpBase, 'project');
  cpSync(FIXTURE_SRC, projectRoot, { recursive: true });
});

afterAll(() => {
  rmSync(tmpBase, { recursive: true, force: true });
});

describe('scanner parity (TS == Python golden)', () => {
  it('metadata-scanner matches', () => {
    const m = new MetadataScanner().scan(projectRoot);
    const actual = {
      js_dependencies: m.jsDependencies,
      python_packages: m.pythonPackages,
      tsconfig: m.tsconfig,
      detected_languages: [...detectedLanguages(m)].sort(),
    };
    expect(actual).toEqual(golden('metadata'));
  });

  it('domain-scanner matches', () => {
    const ctx = new DomainScanner().scan(projectRoot);
    const actual = {
      source_files: ctx.sourceFiles,
      modules: ctx.modules,
      components: ctx.components,
      functions: ctx.functions,
      api_routes: ctx.apiRoutes,
    };
    expect(actual).toEqual(golden('domain'));
  });

  it('fixture-scanner matches', () => {
    const s = new FixtureScanner().scan(projectRoot);
    const actual = { by_module: s.byModule, files_scanned: s.filesScanned };
    expect(actual).toEqual(golden('fixture'));
  });

  it('static-linter lint() matches', () => {
    const findings = new StaticLinter().lint(
      join(projectRoot, 'tests/lint-target.spec.ts'),
    );
    expect(normalize(findings, projectRoot)).toEqual(golden('lint'));
  });

  it('static-linter flakeCheck() matches', () => {
    const findings = new StaticLinter().flakeCheck(
      join(projectRoot, 'tests/lint-target.spec.ts'),
    );
    expect(normalize(findings, projectRoot)).toEqual(golden('flake'));
  });
});

/** Rewrite the absolute `file` field to the project-relative POSIX path the
 * Python golden used (Python was passed the relative path directly). */
function normalize(findings: Finding[], root: string): Finding[] {
  return findings.map((f) => ({
    ...f,
    file: relative(root, resolve(f.file)).split(/[/\\]/).join('/'),
  }));
}
