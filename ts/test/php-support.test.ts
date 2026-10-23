/**
 * PHP framework support (#1465): registry entries, detection probes, scaffold,
 * classifier hint and execution, each through the real module rather than a
 * re-derived expectation.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  extractFrameworkHint,
  TestClassifier,
} from '../src/core/classifier.js';
import { CanaryTestExecutor } from '../src/core/executor.js';
import { probeFramework } from '../src/core/framework-probes.js';
import { FrameworkRegistry } from '../src/core/framework-registry.js';
import { FrameworkRecommender } from '../src/core/recommender.js';
import { Scaffolder } from '../src/core/scaffolder.js';
import { detectWorkspace } from '../src/core/workspace-detect.js';

const ALL = ['config', 'content', 'scripts', 'dependency', 'language'] as const;
const PKG = ['config', 'content', 'scripts', 'dependency'] as const;

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'canary-php-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function composer(manifest: Record<string, unknown>): void {
  writeFileSync(join(root, 'composer.json'), JSON.stringify(manifest), 'utf-8');
}

describe('registry', () => {
  const registry = new FrameworkRegistry();

  it('registers phpunit as a PHP runner via vendor/bin', () => {
    const f = registry.findByName('phpunit');
    expect(f?.languages).toEqual(['php']);
    expect(f?.file_extensions).toEqual(['php']);
    // Not 'preferred': preferred ranks first in every language-blind api
    // recommendation, which would push phpunit at Python and JS users.
    expect(f?.status).toBe('supported');
    expect(f?.execution_command).toBe('vendor/bin/phpunit {file}');
  });

  it('registers pest as a supported PHP runner via vendor/bin', () => {
    const f = registry.findByName('pest');
    expect(f?.languages).toEqual(['php']);
    expect(f?.execution_command).toBe('vendor/bin/pest {file}');
  });

  it('phpunit is full tier (scaffold + execute); pest is executable only', () => {
    expect(registry.capabilities('phpunit')?.tier).toBe('full');
    // `pest --init` owns Pest's scaffold; canary does not duplicate it.
    expect(registry.capabilities('pest')?.tier).toBe('executable');
  });
});

describe('detection probes', () => {
  it.each(['phpunit.xml.dist', 'phpunit.xml'])(
    'detects phpunit from %s at the config tier',
    (file) => {
      writeFileSync(join(root, file), '<phpunit/>', 'utf-8');
      expect(probeFramework(root, {}, [...PKG])).toEqual([
        'phpunit',
        'api',
        file,
        'config',
      ]);
    },
  );

  it('a phpunit.xml beside tests/Pest.php is refined to pest', () => {
    writeFileSync(join(root, 'phpunit.xml'), '<phpunit/>', 'utf-8');
    mkdirSync(join(root, 'tests'));
    writeFileSync(join(root, 'tests', 'Pest.php'), '<?php\n', 'utf-8');
    expect(probeFramework(root, {}, [...PKG])).toEqual([
      'pest',
      'api',
      'phpunit.xml',
      'content',
    ]);
  });

  it('the Pest refinement also applies to a nested package', () => {
    const pkg = join(root, 'apps', 'api');
    mkdirSync(join(pkg, 'tests'), { recursive: true });
    writeFileSync(join(pkg, 'phpunit.xml.dist'), '<phpunit/>', 'utf-8');
    writeFileSync(join(pkg, 'tests', 'Pest.php'), '<?php\n', 'utf-8');
    const [framework, , source] = probeFramework(root, {}, ['nested-config']);
    expect(framework).toBe('pest');
    expect(source).toContain('apps/api/phpunit.xml.dist');
  });

  it('detects phpunit from composer.json require-dev', () => {
    composer({ 'require-dev': { 'phpunit/phpunit': '^12.0' } });
    expect(probeFramework(root, {}, [...PKG])).toEqual([
      'phpunit',
      'api',
      'composer.json (require-dev: phpunit/phpunit)',
      'content',
    ]);
  });

  it('detects pest from composer.json even when phpunit is also required', () => {
    // pestphp/pest depends on phpunit; a repo requiring both runs Pest.
    composer({
      require: { 'phpunit/phpunit': '^11.0' },
      'require-dev': { 'pestphp/pest': '^3.0' },
    });
    expect(probeFramework(root, {}, [...PKG])[0]).toBe('pest');
  });

  it('a package.json test script still wins in a mixed JS + PHP repo', () => {
    // Pre-#1465 answer for e.g. a framework app with a vitest frontend.
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ scripts: { test: 'vitest run' } }),
      'utf-8',
    );
    composer({ 'require-dev': { 'phpunit/phpunit': '^12.0' } });
    expect(probeFramework(root, {}, [...PKG])[0]).toBe('vitest');
  });

  it('a composer.json with no test runner detects nothing', () => {
    composer({ require: { 'laminas/laminas-mvc': '^3.8' } });
    expect(probeFramework(root, {}, [...PKG])).toEqual([
      null,
      'unknown',
      'none',
      'none',
    ]);
  });

  it('malformed composer.json detects nothing rather than throwing', () => {
    writeFileSync(join(root, 'composer.json'), '{ not json', 'utf-8');
    expect(probeFramework(root, {}, [...PKG])[0]).toBeNull();
  });

  it('maps language: php to phpunit only when the language tier runs', () => {
    expect(probeFramework(root, { language: 'php' }, [...ALL])).toEqual([
      'phpunit',
      'api',
      'harness.config.json (language: php)',
      'language',
    ]);
    expect(probeFramework(root, { language: 'php' }, [...PKG])[0]).toBeNull();
  });
});

describe('detection: review findings (#1465)', () => {
  it('the nested walk never reads a dependency suite under vendor/', () => {
    // A composer install vendors packages that ship their own phpunit.xml.
    const lib = join(root, 'vendor', 'acme', 'lib');
    mkdirSync(lib, { recursive: true });
    writeFileSync(join(lib, 'phpunit.xml.dist'), '<phpunit/>', 'utf-8');
    expect(probeFramework(root, {}, ['nested-config'])[0]).toBeNull();
  });

  it('workspace detection applies the same Pest refinement', () => {
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ workspaces: ['apps/*'] }),
      'utf-8',
    );
    const pkg = join(root, 'apps', 'api');
    mkdirSync(join(pkg, 'tests'), { recursive: true });
    writeFileSync(join(pkg, 'package.json'), '{}', 'utf-8');
    writeFileSync(join(pkg, 'phpunit.xml'), '<phpunit/>', 'utf-8');
    writeFileSync(join(pkg, 'tests', 'Pest.php'), '<?php\n', 'utf-8');
    expect(detectWorkspace(root, {})?.findings).toEqual([
      {
        dir: 'apps/api',
        framework: 'pest',
        shape: 'api',
        source: 'phpunit.xml',
        confidence: 'content',
      },
    ]);
  });
});

describe('scaffold', () => {
  it('writes phpunit.xml.dist + tests/, and the result detects as phpunit', () => {
    const result = new Scaffolder().scaffold('phpunit', root);
    expect(result['created_files']).toContain('phpunit.xml.dist');
    expect(result['created_dirs']).toContain('tests');
    const xml = readFileSync(join(root, 'phpunit.xml.dist'), 'utf-8');
    expect(xml).toContain('<directory>tests</directory>');
    expect(xml).toContain('vendor/autoload.php');
    // Round trip: what canary scaffolds, canary must recognise.
    expect(probeFramework(root, {}, [...PKG]).slice(0, 2)).toEqual([
      'phpunit',
      'api',
    ]);
  });
});

describe('classifier + recommender', () => {
  it('a phpunit prompt hints phpunit, which is recommended first', () => {
    const prompt = 'write a phpunit test for the signin controller';
    expect(extractFrameworkHint(prompt)).toBe('phpunit');
    const cls = new TestClassifier().classify(prompt);
    expect(cls.test_type).toBe('api');
    const top = new FrameworkRecommender().recommend(cls, null, 'phpunit')[0];
    expect(top?.framework).toBe('phpunit');
    expect(top?.file_extension).toBe('php');
  });

  it('"pest" is not a hint: the hint regex is leftmost-first and case-blind', () => {
    // As a hint, the English word would steal this prompt from playwright.
    const prompt = 'test the pest-control booking page with playwright';
    expect(extractFrameworkHint(prompt)).toBe('playwright');
  });
});

describe('execution', () => {
  it('runs vendor/bin/phpunit relative to the project cwd', () => {
    // A stub runner stands in for a Composer install: it proves canary spawns
    // the project-local binary with the file as one argv element.
    const bin = join(root, 'vendor', 'bin');
    mkdirSync(bin, { recursive: true });
    const stub = join(bin, 'phpunit');
    writeFileSync(stub, '#!/bin/sh\necho "ran: $1"\n', 'utf-8');
    chmodSync(stub, 0o755);
    const [code, stdout] = new CanaryTestExecutor().execute(
      'tests/Signin Test.php',
      'phpunit',
      10,
      { cwd: root },
    );
    expect(code).toBe(0);
    expect(stdout.trim()).toBe('ran: tests/Signin Test.php');
    expect(existsSync(stub)).toBe(true);
  });
});
