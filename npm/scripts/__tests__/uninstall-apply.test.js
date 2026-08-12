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

function collector() {
  let text = '';
  return { write: (s) => (text += s), get: () => text };
}

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

function seedOverlay(name) {
  const dir = registry.clonePath(name, home);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '# x\n');
  registry.write(
    registry.add(registry.read(home), {
      name,
      source: `https://example.com/${name}.git`,
      path: dir,
      ref: 'main',
      addedDate: '2026-01-01',
      consent: null,
      consentCommandsHash: null,
      precedence: null,
    }),
    home,
  );
  return dir;
}

function fakeGit(dirtyDirs = []) {
  return (args, opts = {}) => {
    if (args[0] === 'status') {
      return {
        status: 0,
        stdout: dirtyDirs.some((d) => opts.cwd === d) ? ' M SKILL.md\n' : '',
        stderr: '',
      };
    }
    return { status: 0, stdout: '', stderr: '' };
  };
}

function deps(extra = {}) {
  return {
    homeDir: home,
    cwd: project,
    git: fakeGit(),
    out: collector(),
    err: collector(),
    ...extra,
  };
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-uninst-home-'));
  project = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-uninst-proj-'));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(project, { recursive: true, force: true });
});

describe('dry run writes nothing', () => {
  it('leaves every artifact on disk without --apply', () => {
    const cacheRoot = seedPluginCache(['4.0.0', '6.4.0'], '6.4.0');
    const overlay = seedOverlay('acme-x');
    fs.mkdirSync(path.join(project, '.canary'), { recursive: true });
    fs.writeFileSync(path.join(project, '.canary', 'config.json'), '{}');

    const code = uninstall.run(['--all'], deps());

    assert.equal(code, 0);
    assert.ok(fs.existsSync(path.join(cacheRoot, '4.0.0')));
    assert.ok(fs.existsSync(overlay));
    assert.ok(fs.existsSync(path.join(project, '.canary')));
  });

  it('says nothing was removed and names the flag', () => {
    seedPluginCache(['4.0.0', '6.4.0'], '6.4.0');
    const out = collector();
    uninstall.run(['--global'], deps({ out }));
    assert.match(out.get(), /--apply/);
  });
});

describe('apply removes only removable artifacts', () => {
  it('removes orphan caches and keeps the registered one', () => {
    const cacheRoot = seedPluginCache(['4.0.0', '6.4.0', '6.7.1'], '6.4.0');
    const code = uninstall.run(['--global', '--apply'], deps());
    assert.equal(code, 0);
    assert.equal(fs.existsSync(path.join(cacheRoot, '4.0.0')), false);
    assert.equal(fs.existsSync(path.join(cacheRoot, '6.7.1')), false);
    assert.ok(
      fs.existsSync(path.join(cacheRoot, '6.4.0')),
      'registered cache must survive',
    );
  });

  it('removes a clean overlay and its registry entry', () => {
    const dir = seedOverlay('clean-x');
    uninstall.run(['--global', '--apply'], deps());
    assert.equal(fs.existsSync(dir), false);
    // registry.get returns null (not undefined) for a missing entry.
    assert.equal(registry.get(registry.read(home), 'clean-x'), null);
  });

  it('keeps a dirty overlay on disk and in the registry', () => {
    const dir = seedOverlay('dirty-x');
    uninstall.run(['--global', '--apply'], deps({ git: fakeGit([dir]) }));
    assert.ok(fs.existsSync(dir), 'dirty overlay must survive');
    assert.ok(registry.get(registry.read(home), 'dirty-x'));
  });
});

describe('.mcp.json is edited surgically', () => {
  it('removes only the canary-mcp key and preserves the others verbatim', () => {
    const mcp = path.join(project, '.mcp.json');
    fs.writeFileSync(
      mcp,
      JSON.stringify(
        {
          mcpServers: {
            'canary-mcp': { command: 'canary-mcp' },
            harness: { command: 'harness', args: ['mcp'] },
            playwright: { command: 'npx', args: ['@playwright/mcp'] },
          },
        },
        null,
        2,
      ),
    );
    uninstall.run(['--project', '--apply'], deps());
    const after = JSON.parse(fs.readFileSync(mcp, 'utf8'));
    assert.deepEqual(Object.keys(after.mcpServers).sort(), [
      'harness',
      'playwright',
    ]);
    assert.deepEqual(after.mcpServers.harness, {
      command: 'harness',
      args: ['mcp'],
    });
  });

  it('leaves the file in place even when it becomes empty', () => {
    const mcp = path.join(project, '.mcp.json');
    fs.writeFileSync(
      mcp,
      JSON.stringify({ mcpServers: { 'canary-mcp': { command: 'x' } } }),
    );
    uninstall.run(['--project', '--apply'], deps());
    assert.ok(
      fs.existsSync(mcp),
      "an empty config is the user's call to delete",
    );
    assert.deepEqual(JSON.parse(fs.readFileSync(mcp, 'utf8')).mcpServers, {});
  });
});

describe('project content is protected', () => {
  it('keeps tests/generated and quarantine.json without --include-generated', () => {
    const gen = path.join(project, 'tests', 'generated');
    fs.mkdirSync(gen, { recursive: true });
    fs.writeFileSync(path.join(gen, 'a.spec.ts'), '');
    const canary = path.join(project, '.canary');
    fs.mkdirSync(canary, { recursive: true });
    fs.writeFileSync(path.join(canary, 'quarantine.json'), '{}');
    fs.writeFileSync(path.join(canary, 'config.json'), '{}');

    uninstall.run(['--project', '--apply'], deps());

    assert.ok(fs.existsSync(path.join(gen, 'a.spec.ts')));
    assert.ok(
      fs.existsSync(path.join(canary, 'quarantine.json')),
      'the ledger must survive a config removal',
    );
    assert.equal(
      fs.existsSync(path.join(canary, 'config.json')),
      false,
      'other .canary config should still be removed',
    );
  });

  it('removes both with --include-generated', () => {
    const gen = path.join(project, 'tests', 'generated');
    fs.mkdirSync(gen, { recursive: true });
    fs.writeFileSync(path.join(gen, 'a.spec.ts'), '');
    const canary = path.join(project, '.canary');
    fs.mkdirSync(canary, { recursive: true });
    fs.writeFileSync(path.join(canary, 'quarantine.json'), '{}');

    uninstall.run(['--project', '--include-generated', '--apply'], deps());

    assert.equal(fs.existsSync(gen), false);
    assert.equal(fs.existsSync(path.join(canary, 'quarantine.json')), false);
  });
});

describe('scope flag is required', () => {
  it('exits 1 and names the flags when no scope is given', () => {
    const err = collector();
    const code = uninstall.run([], deps({ err }));
    assert.equal(code, 1);
    assert.match(err.get(), /--global/);
    assert.match(err.get(), /--project/);
  });

  it('removes nothing when the scope flag is missing', () => {
    const cacheRoot = seedPluginCache(['4.0.0', '6.4.0'], '6.4.0');
    uninstall.run(['--apply'], deps());
    assert.ok(fs.existsSync(path.join(cacheRoot, '4.0.0')));
  });

  it('rejects an unknown flag', () => {
    const code = uninstall.run(['--global', '--nope'], deps());
    assert.equal(code, 1);
  });
});

describe('empty scope states the denominator', () => {
  it('says there is nothing to remove rather than printing an empty list', () => {
    const out = collector();
    const code = uninstall.run(['--project'], deps({ out }));
    assert.equal(code, 0);
    assert.match(out.get(), /nothing/i);
  });
});

describe('routing', () => {
  it('is registered as a TS-handled command', () => {
    const router = require('../../dist/router.js');
    assert.ok(router.TS_COMMANDS.includes('uninstall'));
    assert.equal(router.isTsCommand(['uninstall', '--global']), true);
  });
});
