const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  loadManifest,
  filterByPersona,
  collectPersonas,
} = require('../../dist/doctor-manifest.js');

function tmpClone() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-manifest-'));
  fs.mkdirSync(path.join(dir, '.canary'), { recursive: true });
  return dir;
}
function writeManifest(dir, obj) {
  fs.writeFileSync(
    path.join(dir, '.canary', 'doctor.json'),
    typeof obj === 'string' ? obj : JSON.stringify(obj),
  );
}

describe('loadManifest', () => {
  let clone;
  beforeEach(() => (clone = tmpClone()));
  afterEach(() => fs.rmSync(clone, { recursive: true, force: true }));

  it('treats a missing manifest as ok with no checks', () => {
    const r = loadManifest(clone);
    assert.deepEqual(r, { ok: true, checks: [] });
  });

  it('parses a valid manifest across all three types', () => {
    writeManifest(clone, {
      checks: [
        {
          id: 'cfg',
          type: 'file-exists',
          path: '.canary/company.json',
          remedy: 're-clone',
        },
        {
          id: 'reachable',
          type: 'url-reachable',
          url: 'https://example.com',
          persona: ['alpha'],
          remedy: 'req access',
        },
        {
          id: 'build',
          type: 'command-succeeds',
          command: ['npm', 'run', 'x'],
          remedy: 'install deps',
        },
      ],
    });
    const r = loadManifest(clone);
    assert.equal(r.ok, true);
    assert.equal(r.checks.length, 3);
    assert.equal(r.checks[0].type, 'file-exists');
  });

  it('degrades malformed JSON to a single failing check (no throw)', () => {
    writeManifest(clone, '{ not json');
    const r = loadManifest(clone);
    assert.equal(r.ok, false);
    assert.equal(r.failure.status, 'fail');
    assert.match(r.failure.label, /doctor\.json is invalid/);
  });

  it('rejects an unknown check type as a single failing check', () => {
    writeManifest(clone, {
      checks: [{ id: 'x', type: 'port-open', remedy: 'y' }],
    });
    const r = loadManifest(clone);
    assert.equal(r.ok, false);
    assert.match(r.failure.remedy, /unknown type/);
  });

  it('rejects a file-exists check missing its path', () => {
    writeManifest(clone, {
      checks: [{ id: 'x', type: 'file-exists', remedy: 'y' }],
    });
    const r = loadManifest(clone);
    assert.equal(r.ok, false);
    assert.match(r.failure.remedy, /missing a string "path"/);
  });

  it('rejects a check missing its remedy', () => {
    writeManifest(clone, {
      checks: [{ id: 'x', type: 'url-reachable', url: 'https://e.com' }],
    });
    const r = loadManifest(clone);
    assert.equal(r.ok, false);
    assert.match(r.failure.remedy, /missing a string "remedy"/);
  });

  it('rejects a checks field that is not an array', () => {
    writeManifest(clone, { checks: {} });
    const r = loadManifest(clone);
    assert.equal(r.ok, false);
    assert.match(r.failure.remedy, /"checks" array/);
  });
});

describe('filterByPersona', () => {
  const checks = [
    { id: 'always', type: 'file-exists', path: 'a', remedy: 'r' },
    {
      id: 'alpha-only',
      type: 'file-exists',
      path: 'b',
      remedy: 'r',
      persona: ['alpha'],
    },
    {
      id: 'beta-only',
      type: 'file-exists',
      path: 'c',
      remedy: 'r',
      persona: ['Beta'],
    },
  ];

  it('keeps everything when persona is null', () => {
    assert.equal(filterByPersona(checks, null).length, 3);
  });
  it('keeps no-persona checks plus matching-tag checks (case-insensitive)', () => {
    const ids = filterByPersona(checks, 'beta').map((c) => c.id);
    assert.deepEqual(ids, ['always', 'beta-only']);
  });
  it('keeps only no-persona checks when the tag matches none', () => {
    const ids = filterByPersona(checks, 'gamma').map((c) => c.id);
    assert.deepEqual(ids, ['always']);
  });
});

describe('collectPersonas', () => {
  it('returns [] when no check declares a persona', () => {
    const checks = [{ id: 'a', type: 'file-exists', path: 'x', remedy: 'r' }];
    assert.deepEqual(collectPersonas(checks), []);
  });
  it('collects distinct tags in first-seen order', () => {
    const checks = [
      {
        id: 'a',
        type: 'file-exists',
        path: 'x',
        remedy: 'r',
        persona: ['backend'],
      },
      {
        id: 'b',
        type: 'file-exists',
        path: 'y',
        remedy: 'r',
        persona: ['frontend'],
      },
    ];
    assert.deepEqual(collectPersonas(checks), ['backend', 'frontend']);
  });
  it('de-duplicates case-insensitively, keeping first-seen casing', () => {
    const checks = [
      {
        id: 'a',
        type: 'file-exists',
        path: 'x',
        remedy: 'r',
        persona: ['Backend'],
      },
      {
        id: 'b',
        type: 'file-exists',
        path: 'y',
        remedy: 'r',
        persona: ['backend', 'qa'],
      },
    ];
    assert.deepEqual(collectPersonas(checks), ['Backend', 'qa']);
  });
});
