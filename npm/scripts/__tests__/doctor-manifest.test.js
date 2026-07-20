const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  loadManifest,
  filterByAudience,
  collectAudiences,
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
          audience: ['alpha'],
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
    assert.deepEqual(r.checks[1].audience, ['alpha']);
  });

  it('accepts the legacy `persona:` field as an alias for `audience:` (#319 B)', () => {
    writeManifest(clone, {
      checks: [
        {
          id: 'legacy',
          type: 'file-exists',
          path: 'x',
          remedy: 'r',
          persona: ['backend'],
        },
      ],
    });
    const r = loadManifest(clone);
    assert.equal(r.ok, true);
    // The legacy field is normalized onto `audience`.
    assert.deepEqual(r.checks[0].audience, ['backend']);
  });

  it('rejects a non-string legacy persona list with an audience error', () => {
    writeManifest(clone, {
      checks: [
        {
          id: 'x',
          type: 'file-exists',
          path: 'p',
          remedy: 'r',
          persona: 'nope',
        },
      ],
    });
    const r = loadManifest(clone);
    assert.equal(r.ok, false);
    assert.match(r.failure.remedy, /non-string audience list/);
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

describe('filterByAudience', () => {
  const checks = [
    { id: 'always', type: 'file-exists', path: 'a', remedy: 'r' },
    {
      id: 'alpha-only',
      type: 'file-exists',
      path: 'b',
      remedy: 'r',
      audience: ['alpha'],
    },
    {
      id: 'beta-only',
      type: 'file-exists',
      path: 'c',
      remedy: 'r',
      audience: ['Beta'],
    },
  ];

  it('keeps everything when audience is null', () => {
    assert.equal(filterByAudience(checks, null).length, 3);
  });
  it('keeps no-audience checks plus matching-tag checks (case-insensitive)', () => {
    const ids = filterByAudience(checks, 'beta').map((c) => c.id);
    assert.deepEqual(ids, ['always', 'beta-only']);
  });
  it('keeps only no-audience checks when the tag matches none', () => {
    const ids = filterByAudience(checks, 'gamma').map((c) => c.id);
    assert.deepEqual(ids, ['always']);
  });
});

describe('collectAudiences', () => {
  it('returns [] when no check declares an audience', () => {
    const checks = [{ id: 'a', type: 'file-exists', path: 'x', remedy: 'r' }];
    assert.deepEqual(collectAudiences(checks), []);
  });
  it('collects distinct tags in first-seen order', () => {
    const checks = [
      {
        id: 'a',
        type: 'file-exists',
        path: 'x',
        remedy: 'r',
        audience: ['backend'],
      },
      {
        id: 'b',
        type: 'file-exists',
        path: 'y',
        remedy: 'r',
        audience: ['frontend'],
      },
    ];
    assert.deepEqual(collectAudiences(checks), ['backend', 'frontend']);
  });
  it('de-duplicates case-insensitively, keeping first-seen casing', () => {
    const checks = [
      {
        id: 'a',
        type: 'file-exists',
        path: 'x',
        remedy: 'r',
        audience: ['Backend'],
      },
      {
        id: 'b',
        type: 'file-exists',
        path: 'y',
        remedy: 'r',
        audience: ['backend', 'qa'],
      },
    ];
    assert.deepEqual(collectAudiences(checks), ['Backend', 'qa']);
  });
});
