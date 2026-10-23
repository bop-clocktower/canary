/**
 * `canary php floor` (#1465): the PHP2Shell runtime-floor gate.
 *
 * The version strings are the ones a runtime actually reports. A distro build
 * keeps the upstream number in `PHP_VERSION` and backports the fix under its
 * own suffix, so "8.3.6-1ubuntu..." must abstain rather than fail: the number
 * alone cannot prove the patch is missing.
 */

import { describe, expect, it } from 'vitest';

import { EXIT_ABSTAINED } from '../src/core/gate-result.js';
import { evaluateRuntimes, PHP2SHELL } from '../src/core/php-floor.js';
import type { SubprocessResult } from '../src/main-deps.js';
import { invokeCanary } from './canary-cli-testkit.js';

describe('evaluateRuntimes', () => {
  it.each(['8.2.35', '8.3.36', '8.4.27', '8.5.12', '8.4.30'])(
    '%s is at or above its branch floor',
    (v) => {
      const r = evaluateRuntimes([{ version: v }]);
      expect(r).toMatchObject({ checked: 1, findings: [] });
    },
  );

  it.each([
    ['8.2.34', '8.2.35'],
    ['8.3.35', '8.3.36'],
    ['8.4.26', '8.4.27'],
    ['8.5.11', '8.5.12'],
    ['8.3.9', '8.3.36'], // numeric, not lexical: 9 < 36
  ])('%s is below floor %s', (v, floor) => {
    const r = evaluateRuntimes([{ version: v }]);
    expect(r.checked).toBe(1);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]).toMatchObject({ version: v, floor });
    expect(r.findings[0]!.detail).toContain('CVE-2026-109618');
    expect(r.findings[0]!.detail).toContain('CVE-2026-109619');
  });

  it('an upstream pre-release compares on its number', () => {
    expect(evaluateRuntimes([{ version: '8.5.0RC1' }]).findings).toHaveLength(
      1,
    );
  });

  it.each(['8.1.31', '8.0.30', '7.4.33'])(
    'upstream %s is a finding: its branch has no upstream fix',
    (v) => {
      const [f] = evaluateRuntimes([{ version: v }]).findings;
      expect(f?.floor).toBeNull();
      expect(f?.detail).toMatch(/no upstream fix/);
    },
  );

  it('a vendor build on a fixed branch abstains: the number cannot prove it', () => {
    const r = evaluateRuntimes([{ version: '8.3.6-1ubuntu2.14' }]);
    expect(r.checked).toBe(0);
    expect(r.findings).toEqual([]);
    expect(r.skipped?.[0]?.name).toBe('8.3.6-1ubuntu2.14');
    expect(r.skipped?.[0]?.reason).toMatch(/vendor build/);
  });

  it('a vendor build on an upstream-unfixed branch abstains too', () => {
    // LTS vendors ship 8.1 backports; only the vendor can say if this has one.
    expect(evaluateRuntimes([{ version: '8.1.2-1ubuntu2.20' }]).checked).toBe(
      0,
    );
  });

  it('7.3 and older are findings even as vendor builds: no fix exists', () => {
    const r = evaluateRuntimes([{ version: '7.3.33-1+deb10u5' }]);
    expect(r.checked).toBe(1);
    expect(r.findings[0]?.detail).toMatch(/no fix/);
  });

  it.each([
    ['9.0.0', /not covered/],
    ['banana', /not a PHP version/],
  ])('%s is skipped, not passed', (v, reason) => {
    const r = evaluateRuntimes([{ version: v }]);
    expect(r.checked).toBe(0);
    expect(r.skipped?.[0]?.reason).toMatch(reason);
  });

  it('notes the CVE-2026-109619 stopgap state when the ini value is known', () => {
    const on = evaluateRuntimes([{ version: '8.3.30', uploadProgress: '1' }]);
    expect(on.findings[0]!.detail).toContain(
      'session.upload_progress.enabled=1',
    );
    const off = evaluateRuntimes([{ version: '8.3.30', uploadProgress: '0' }]);
    expect(off.findings[0]!.detail).toMatch(/CVE-2026-109618 is still open/);
  });

  it('the advisory table names both CVEs and the 2026-10-21 release', () => {
    expect(PHP2SHELL.cves).toEqual(['CVE-2026-109618', 'CVE-2026-109619']);
    expect(PHP2SHELL.published).toBe('2026-10-21');
  });
});

/** A `php` binary that reports *version* and the upload-progress ini value. */
function fakePhp(version: string, uploadProgress = '1') {
  const calls: Array<[string, string[]]> = [];
  const runSubprocess = (cmd: string, args: string[]): SubprocessResult => {
    calls.push([cmd, args]);
    return {
      status: 0,
      stdout: JSON.stringify([version, uploadProgress]),
      stderr: '',
    };
  };
  return { calls, runSubprocess };
}

describe('canary php floor', () => {
  it('passes an explicit patched version without probing a binary', async () => {
    const php = fakePhp('8.3.1');
    const r = await invokeCanary(['php', 'floor', '--php-version', '8.4.27'], {
      deps: { runSubprocess: php.runSubprocess },
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('All 1 run runtime check(s) passed');
    expect(php.calls).toEqual([]);
  });

  it('checks every --php-version given, failing on any below the floor', async () => {
    const r = await invokeCanary([
      'php',
      'floor',
      '--php-version',
      '8.4.27',
      '8.3.30',
    ]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('8.3.30');
    expect(r.stdout).toContain('8.3.36');
    expect(r.stdout).toContain('1 finding(s) across 2 checked');
  });

  it('probes the --php binary when no version is given', async () => {
    const php = fakePhp('8.3.30');
    const r = await invokeCanary(['php', 'floor', '--php', '/opt/php83'], {
      deps: { runSubprocess: php.runSubprocess },
    });
    expect(r.code).toBe(1);
    expect(php.calls[0]?.[0]).toBe('/opt/php83');
    expect(php.calls[0]?.[1][0]).toBe('-r');
    expect(r.stdout).toContain('session.upload_progress.enabled=1');
  });

  it('a binary that cannot run abstains (exit 3) and names the fix', async () => {
    const r = await invokeCanary(['php', 'floor'], {
      deps: { runSubprocess: () => ({ status: null, stdout: '', stderr: '' }) },
    });
    expect(r.code).toBe(EXIT_ABSTAINED);
    expect(r.stdout).toContain('Abstained');
    expect(r.stdout).toContain('--php-version');
    expect(r.stdout).not.toContain('passed');
  });

  it('a probe that prints no version abstains rather than guessing', async () => {
    const r = await invokeCanary(['php', 'floor'], {
      deps: {
        runSubprocess: () => ({
          status: 255,
          stdout: 'Parse error',
          stderr: '',
        }),
      },
    });
    expect(r.code).toBe(EXIT_ABSTAINED);
    expect(r.stdout).toContain("'php' probe failed (exit 255)");
  });

  it('--json carries checked, abstained and the findings', async () => {
    const r = await invokeCanary([
      'php',
      'floor',
      '--json',
      '--php-version',
      '8.5.11',
    ]);
    expect(r.code).toBe(1);
    const payload = JSON.parse(r.stdout) as Record<string, unknown>;
    expect(payload).toMatchObject({
      advisory: 'PHP2Shell',
      checked: 1,
      abstained: false,
    });
    expect(payload['findings']).toHaveLength(1);
  });
});
