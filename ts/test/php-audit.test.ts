/**
 * `canary php audit` (#1465): `composer audit` as a gate.
 *
 * The denominator is the lockfile's package count, read by canary itself:
 * `composer audit` reports what it found, never how much it looked at, so a
 * missing lockfile or a missing composer must not be allowed to read as clean.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EXIT_ABSTAINED } from '../src/core/gate-result.js';
import type { SubprocessResult } from '../src/main-deps.js';
import { invokeCanary } from './canary-cli-testkit.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'canary-php-audit-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function lockfile(packages: string[], dev: string[] = []): void {
  const entry = (name: string) => ({ name, version: '1.0.0' });
  writeFileSync(
    join(dir, 'composer.lock'),
    JSON.stringify({
      packages: packages.map(entry),
      'packages-dev': dev.map(entry),
    }),
    'utf-8',
  );
}

/** A composer that answers `audit` with *report* and exit *status*. */
function fakeComposer(report: unknown, status = 0) {
  const calls: Array<[string, string[]]> = [];
  const runSubprocess = (cmd: string, args: string[]): SubprocessResult => {
    calls.push([cmd, args]);
    return { status, stdout: JSON.stringify(report), stderr: '' };
  };
  return { calls, runSubprocess };
}

const CLEAN = { advisories: [], abandoned: [] };

async function audit(
  runSubprocess: (cmd: string, args: string[]) => SubprocessResult,
  extra: string[] = [],
) {
  return invokeCanary(['php', 'audit', '--dir', dir, ...extra], {
    deps: { runSubprocess },
  });
}

describe('canary php audit', () => {
  it('passes a clean lockfile, counting prod + dev packages', async () => {
    lockfile(['laminas/laminas-mvc'], ['phpunit/phpunit']);
    const composer = fakeComposer(CLEAN);
    const r = await audit(composer.runSubprocess);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('All 2 run package check(s) passed');
    expect(composer.calls).toEqual([
      [
        'composer',
        [
          'audit',
          '--locked',
          '--format=json',
          '--no-interaction',
          '--working-dir',
          dir,
        ],
      ],
    ]);
  });

  it('reports each advisory with its CVE and fails (exit 1)', async () => {
    lockfile(['acme/soap-client', 'acme/other']);
    const composer = fakeComposer(
      {
        advisories: {
          'acme/soap-client': [
            {
              advisoryId: 'PKSA-1234',
              cve: 'CVE-2026-0001',
              title: 'XXE in WSDL parsing',
              affectedVersions: '<1.2.0',
              link: 'https://example.test/advisory',
            },
          ],
        },
        abandoned: [],
      },
      1,
    );
    const r = await audit(composer.runSubprocess);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('acme/soap-client');
    expect(r.stdout).toContain('CVE-2026-0001');
    expect(r.stdout).toContain('XXE in WSDL parsing');
    expect(r.stdout).toContain('1 finding(s) across 2 checked');
  });

  it('falls back to the advisory id when a finding has no CVE', async () => {
    lockfile(['acme/a']);
    const composer = fakeComposer(
      {
        advisories: {
          'acme/a': [{ advisoryId: 'PKSA-9', cve: null, title: 't' }],
        },
      },
      1,
    );
    expect((await audit(composer.runSubprocess)).stdout).toContain('PKSA-9');
  });

  it('an abandoned package is a finding, naming its replacement', async () => {
    lockfile(['zendframework/zendframework']);
    const composer = fakeComposer(
      {
        advisories: [],
        abandoned: { 'zendframework/zendframework': 'laminas/laminas-mvc' },
      },
      2,
    );
    const r = await audit(composer.runSubprocess);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('abandoned');
    expect(r.stdout).toContain('laminas/laminas-mvc');
  });

  it('--json carries checked, abstained and the findings', async () => {
    lockfile(['acme/a']);
    const r = await audit(fakeComposer(CLEAN).runSubprocess, ['--json']);
    expect(JSON.parse(r.stdout)).toMatchObject({
      checked: 1,
      abstained: false,
      findings: [],
    });
  });
});

describe('canary php audit abstains instead of passing', () => {
  it('no composer.lock: exit 3, says to create one', async () => {
    const composer = fakeComposer(CLEAN);
    const r = await audit(composer.runSubprocess);
    expect(r.code).toBe(EXIT_ABSTAINED);
    expect(r.stdout).toContain('no composer.lock');
    expect(r.stdout).not.toContain('passed');
    expect(composer.calls).toEqual([]);
  });

  it('a lockfile that locks zero packages: exit 3', async () => {
    lockfile([]);
    const r = await audit(fakeComposer(CLEAN).runSubprocess);
    expect(r.code).toBe(EXIT_ABSTAINED);
    expect(r.stdout).toContain('0 packages');
  });

  it('a lockfile that is not JSON: exit 3', async () => {
    writeFileSync(join(dir, 'composer.lock'), '<<<<<<< HEAD', 'utf-8');
    const r = await audit(fakeComposer(CLEAN).runSubprocess);
    expect(r.code).toBe(EXIT_ABSTAINED);
    expect(r.stdout).toContain('not valid JSON');
  });

  it('a lockfile the filesystem refuses: exit 3 naming the errno', async () => {
    mkdirSync(join(dir, 'composer.lock'));
    const r = await audit(fakeComposer(CLEAN).runSubprocess);
    expect(r.code).toBe(EXIT_ABSTAINED);
    expect(r.stdout).toContain('composer.lock is unreadable (EISDIR)');
  });

  it('composer not runnable: exit 3 even with packages locked', async () => {
    lockfile(['acme/a', 'acme/b']);
    const r = await audit(() => ({ status: null, stdout: '', stderr: '' }));
    expect(r.code).toBe(EXIT_ABSTAINED);
    expect(r.stdout).toContain('composer is not runnable');
    expect(r.stdout).not.toContain('passed');
  });

  it('composer output that is not an audit report: exit 3', async () => {
    lockfile(['acme/a']);
    const r = await audit(() => ({
      status: 1,
      stdout: '',
      stderr: 'Command "audit" is not defined.\n',
    }));
    expect(r.code).toBe(EXIT_ABSTAINED);
    expect(r.stdout).toContain('Command "audit" is not defined.');
  });
});
