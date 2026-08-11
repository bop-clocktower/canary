const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { checkPluginVersion } = require('../../dist/engine-checks.js');

/**
 * `engine:plugin-version` — staleness detection for the Claude Code plugin
 * (#522).
 *
 * Canary ships through two independent version streams and, before this check,
 * only the CLI had staleness detection. `canary upgrade` bumps the CLI and
 * silently leaves the plugin behind, so a user can be up to date by every
 * signal Canary gives them while running a plugin two majors old — which is
 * how a real consuming project sat on 4.0.0 for six weeks, concluding that
 * half of Canary's agents simply did not exist.
 *
 * Purely local file reads, so unlike `engine:version` this cannot fail offline.
 */

function home(installed, marketplace) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-plugin-'));
  if (installed !== undefined) {
    const p = path.join(dir, '.claude', 'plugins');
    fs.mkdirSync(p, { recursive: true });
    fs.writeFileSync(
      path.join(p, 'installed_plugins.json'),
      typeof installed === 'string' ? installed : JSON.stringify(installed),
    );
  }
  if (marketplace !== undefined) {
    const p = path.join(
      dir,
      '.claude',
      'plugins',
      'marketplaces',
      'bop-clocktower',
      '.claude-plugin',
    );
    fs.mkdirSync(p, { recursive: true });
    fs.writeFileSync(
      path.join(p, 'plugin.json'),
      typeof marketplace === 'string'
        ? marketplace
        : JSON.stringify(marketplace),
    );
  }
  return dir;
}

/** The real manifest shape, verified against a live install on 2026-08-10. */
function installedAt(version) {
  return {
    version: 1,
    plugins: {
      'canary@bop-clocktower': [
        {
          scope: 'user',
          installPath: `/somewhere/canary/${version}`,
          version,
          installedAt: '2026-08-02T22:56:14.803Z',
        },
      ],
    },
  };
}

describe('checkPluginVersion', () => {
  it('passes when the installed plugin matches the marketplace', () => {
    const r = checkPluginVersion({
      homeDir: home(installedAt('6.7.1'), { name: 'canary', version: '6.7.1' }),
    });
    assert.equal(r.id, 'engine:plugin-version');
    assert.equal(r.status, 'pass');
    assert.match(r.label, /6\.7\.1/);
  });

  it('fails when the installed plugin is behind the marketplace', () => {
    const r = checkPluginVersion({
      homeDir: home(installedAt('6.4.0'), { name: 'canary', version: '6.7.1' }),
    });
    assert.equal(r.status, 'fail');
    assert.match(r.label, /6\.4\.0/);
    assert.match(r.label, /6\.7\.1/);
  });

  it('emits BOTH update commands, because either alone is a no-op', () => {
    // `/plugin marketplace update` refreshes the clone but leaves the cached
    // plugin in place; `/plugin install` without it reinstalls the same stale
    // version. A remedy naming one command sends the user in a circle.
    const r = checkPluginVersion({
      homeDir: home(installedAt('6.4.0'), { name: 'canary', version: '6.7.1' }),
    });
    assert.match(r.remedy, /\/plugin marketplace update bop-clocktower/);
    assert.match(r.remedy, /\/plugin install canary@bop-clocktower/);
  });

  it('skips when no plugin install is present (CLI-only users)', () => {
    const r = checkPluginVersion({ homeDir: home(undefined, undefined) });
    assert.equal(r.status, 'skip');
  });

  it('skips when the manifest exists but holds no canary entry', () => {
    const r = checkPluginVersion({
      homeDir: home({ version: 1, plugins: { 'other@elsewhere': [] } }, undefined),
    });
    assert.equal(r.status, 'skip');
  });

  it('is informational when the marketplace clone is unreadable', () => {
    // Mirrors how engine:version degrades when offline: unknown is not failure.
    const r = checkPluginVersion({
      homeDir: home(installedAt('6.4.0'), undefined),
    });
    assert.equal(r.status, 'info');
    assert.match(r.label, /6\.4\.0/);
  });

  it('is informational rather than throwing on malformed JSON', () => {
    // Both files are untrusted input (SEC-DES-001) — a hand-edited manifest
    // must not crash doctor.
    assert.equal(
      checkPluginVersion({ homeDir: home('{not json', undefined) }).status,
      'skip',
    );
    assert.equal(
      checkPluginVersion({
        homeDir: home(installedAt('6.4.0'), '{not json'),
      }).status,
      'info',
    );
  });

  it('does not fail a dev checkout running ahead of the marketplace', () => {
    const r = checkPluginVersion({
      homeDir: home(installedAt('6.8.0'), { name: 'canary', version: '6.7.1' }),
    });
    assert.equal(r.status, 'pass');
  });

  it('reports the newest install when several scopes are present', () => {
    // Claude Code stores an array per plugin key; a user + project install can
    // coexist, and the one that loses would be a false stale report.
    const manifest = installedAt('6.4.0');
    manifest.plugins['canary@bop-clocktower'].push({
      scope: 'project',
      version: '6.7.1',
      installedAt: '2026-08-09T00:00:00.000Z',
    });
    const r = checkPluginVersion({
      homeDir: home(manifest, { name: 'canary', version: '6.7.1' }),
    });
    assert.equal(r.status, 'pass');
  });
});
