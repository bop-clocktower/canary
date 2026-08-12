const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const uninstall = require('../../dist/uninstall.js');
const registry = require('../../dist/overlays-registry.js');

const MARKETPLACE = 'bop-clocktower';
const PLUGIN_KEY = 'canary@bop-clocktower';

let home, project;

/** Cache dirs under ~/.claude/plugins/cache/<mp>/canary/<version>/. */
function seedPluginCache(versions, registeredVersion) {
  const cacheRoot = path.join(
    home,
    '.claude',
    'plugins',
    'cache',
    MARKETPLACE,
    'canary',
  );
  for (const v of versions) {
    fs.mkdirSync(path.join(cacheRoot, v), { recursive: true });
    fs.writeFileSync(path.join(cacheRoot, v, 'plugin.json'), '{}');
  }
  if (registeredVersion) {
    const pluginsDir = path.join(home, '.claude', 'plugins');
    fs.mkdirSync(pluginsDir, { recursive: true });
    fs.writeFileSync(
      path.join(pluginsDir, 'installed_plugins.json'),
      JSON.stringify({
        plugins: {
          [PLUGIN_KEY]: [
            {
              scope: 'user',
              version: registeredVersion,
              installPath: path.join(cacheRoot, registeredVersion),
            },
          ],
        },
      }),
    );
  }
  return cacheRoot;
}

/** A tracked overlay whose clone dir exists. `dirty` controls git status. */
function seedOverlay(name, dirty) {
  const dir = registry.clonePath(name, home);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '# x\n');
  const reg = registry.read(home);
  const next = registry.add(reg, {
    name,
    source: `https://example.com/${name}.git`,
    path: dir,
    ref: 'main',
    addedDate: '2026-01-01',
    consent: null,
    consentCommandsHash: null,
    precedence: null,
  });
  registry.write(next, home);
  return dir;
}

/** git runner that reports a fixed porcelain status per directory. */
function fakeGit(dirtyDirs = []) {
  return (args, opts = {}) => {
    if (args[0] === 'status') {
      const isDirty = dirtyDirs.some((d) => opts.cwd === d);
      return { status: 0, stdout: isDirty ? ' M SKILL.md\n' : '', stderr: '' };
    }
    return { status: 0, stdout: '', stderr: '' };
  };
}

function deps(extra = {}) {
  return { homeDir: home, cwd: project, git: fakeGit(), ...extra };
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-uninst-home-'));
  project = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-uninst-proj-'));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(project, { recursive: true, force: true });
});

describe('enumerate: global plugin caches', () => {
  it('lists every cached version except the registered one', () => {
    seedPluginCache(['4.0.0', '6.3.0', '6.4.0', '6.5.0'], '6.4.0');
    const found = uninstall.enumerate({ scope: 'global' }, deps());
    const caches = found.filter((a) => a.kind === 'plugin-cache');
    const removable = caches
      .filter((a) => a.disposition === 'removable')
      .map((a) => path.basename(a.path))
      .sort();
    assert.deepEqual(removable, ['4.0.0', '6.3.0', '6.5.0']);
  });

  it('never marks the registered version removable when it is not the newest', () => {
    // The real-world case: registered 6.4.0 with 6.7.1 also on disk. A
    // highest-version heuristic would delete the live install.
    seedPluginCache(['4.0.0', '6.4.0', '6.5.0', '6.7.1'], '6.4.0');
    const found = uninstall.enumerate({ scope: 'global' }, deps());
    const registered = found.find(
      (a) =>
        a.kind === 'plugin-cache' && path.basename(a.path ?? '') === '6.4.0',
    );
    assert.ok(registered, 'registered cache should still be reported');
    assert.notEqual(registered.disposition, 'removable');
  });

  it('treats every cache as an orphan once the plugin is deregistered', () => {
    // After `/plugin uninstall` there is no installed_plugins.json entry, so a
    // re-run sweeps what was previously the live cache. No special case.
    seedPluginCache(['6.4.0', '6.5.0'], null);
    const found = uninstall.enumerate({ scope: 'global' }, deps());
    const removable = found.filter(
      (a) => a.kind === 'plugin-cache' && a.disposition === 'removable',
    );
    assert.equal(removable.length, 2);
  });

  it('reports plugin registration and marketplace as manual, never removable', () => {
    seedPluginCache(['6.4.0'], '6.4.0');
    fs.mkdirSync(
      path.join(home, '.claude', 'plugins', 'marketplaces', MARKETPLACE),
      { recursive: true },
    );
    const found = uninstall.enumerate({ scope: 'global' }, deps());
    const manual = found.filter((a) => a.disposition === 'manual');
    assert.ok(manual.some((a) => a.kind === 'plugin-registration'));
    assert.ok(manual.some((a) => a.kind === 'marketplace'));
    assert.ok(
      manual.every((a) => a.disposition === 'manual'),
      'manual entries must never be removable',
    );
  });

  it('always reports the CLI binary as manual', () => {
    const found = uninstall.enumerate({ scope: 'global' }, deps());
    const cli = found.find((a) => a.kind === 'cli-binary');
    assert.ok(cli);
    assert.equal(cli.disposition, 'manual');
  });
});

describe('enumerate: overlays', () => {
  it('marks a clean overlay removable', () => {
    seedOverlay('clean-one', false);
    const found = uninstall.enumerate({ scope: 'global' }, deps());
    const o = found.find((a) => a.kind === 'overlay');
    assert.ok(o);
    assert.equal(o.disposition, 'removable');
  });

  it('blocks an overlay with local edits and says why', () => {
    const dir = seedOverlay('dirty-one', true);
    const found = uninstall.enumerate(
      { scope: 'global' },
      deps({ git: fakeGit([dir]) }),
    );
    const o = found.find((a) => a.kind === 'overlay');
    assert.equal(o.disposition, 'blocked');
    assert.match(o.reason, /local edits/i);
  });
});

describe('enumerate: project scope', () => {
  it('reports .canary/ and test-results/reports as removable', () => {
    fs.mkdirSync(path.join(project, '.canary'), { recursive: true });
    fs.writeFileSync(path.join(project, '.canary', 'config.json'), '{}');
    fs.mkdirSync(path.join(project, 'test-results', 'reports'), {
      recursive: true,
    });
    const found = uninstall.enumerate({ scope: 'project' }, deps());
    const kinds = found
      .filter((a) => a.disposition === 'removable')
      .map((a) => a.kind);
    assert.ok(kinds.includes('project-config'));
    assert.ok(kinds.includes('project-reports'));
  });

  it('blocks tests/generated and quarantine.json without --include-generated', () => {
    fs.mkdirSync(path.join(project, 'tests', 'generated'), { recursive: true });
    fs.writeFileSync(path.join(project, 'tests', 'generated', 'a.spec.ts'), '');
    fs.mkdirSync(path.join(project, '.canary'), { recursive: true });
    fs.writeFileSync(
      path.join(project, '.canary', 'quarantine.json'),
      JSON.stringify({ entries: [{ test: 'x' }] }),
    );
    const found = uninstall.enumerate({ scope: 'project' }, deps());
    const gen = found.find((a) => a.kind === 'generated-tests');
    const quar = found.find((a) => a.kind === 'quarantine-ledger');
    assert.equal(gen.disposition, 'blocked');
    assert.equal(quar.disposition, 'blocked');
  });

  it('makes them removable with --include-generated', () => {
    fs.mkdirSync(path.join(project, 'tests', 'generated'), { recursive: true });
    fs.writeFileSync(path.join(project, 'tests', 'generated', 'a.spec.ts'), '');
    fs.mkdirSync(path.join(project, '.canary'), { recursive: true });
    fs.writeFileSync(path.join(project, '.canary', 'quarantine.json'), '{}');
    const found = uninstall.enumerate(
      { scope: 'project', includeGenerated: true },
      deps(),
    );
    assert.equal(
      found.find((a) => a.kind === 'generated-tests').disposition,
      'removable',
    );
    assert.equal(
      found.find((a) => a.kind === 'quarantine-ledger').disposition,
      'removable',
    );
  });

  it('reports the canary-mcp key when .mcp.json declares it', () => {
    fs.writeFileSync(
      path.join(project, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          'canary-mcp': { command: 'x' },
          harness: { command: 'y' },
        },
      }),
    );
    const found = uninstall.enumerate({ scope: 'project' }, deps());
    const mcp = found.find((a) => a.kind === 'mcp-entry');
    assert.ok(mcp);
    assert.equal(mcp.disposition, 'removable');
  });

  it('does not report an mcp entry when canary is absent from .mcp.json', () => {
    fs.writeFileSync(
      path.join(project, '.mcp.json'),
      JSON.stringify({ mcpServers: { harness: { command: 'y' } } }),
    );
    const found = uninstall.enumerate({ scope: 'project' }, deps());
    assert.equal(
      found.find((a) => a.kind === 'mcp-entry'),
      undefined,
    );
  });
});

describe('enumerate: scope selection', () => {
  it('global scope yields no project artifacts', () => {
    fs.mkdirSync(path.join(project, '.canary'), { recursive: true });
    const found = uninstall.enumerate({ scope: 'global' }, deps());
    assert.equal(
      found.some((a) => a.scope === 'project'),
      false,
    );
  });

  it('all scope yields both', () => {
    seedPluginCache(['6.4.0', '6.5.0'], '6.4.0');
    fs.mkdirSync(path.join(project, '.canary'), { recursive: true });
    const found = uninstall.enumerate({ scope: 'all' }, deps());
    assert.ok(found.some((a) => a.scope === 'global'));
    assert.ok(found.some((a) => a.scope === 'project'));
  });
});
