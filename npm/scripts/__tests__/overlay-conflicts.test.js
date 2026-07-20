const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  detectSkillConflicts,
  readOverlaySkillNames,
} = require('../../dist/overlay-conflicts.js');

describe('readOverlaySkillNames robustness', () => {
  it('returns [] (never throws) for a hand-edited entry with no path', () => {
    // #333 invites hand-editing overlays.json to add `precedence`; a minimal
    // entry may omit `path`. Must degrade, not crash.
    assert.deepEqual(readOverlaySkillNames({ name: 'x' }), []);
    assert.deepEqual(readOverlaySkillNames({ name: 'x', path: '' }), []);
  });

  it('returns [] for a path that does not exist', () => {
    assert.deepEqual(
      readOverlaySkillNames({ name: 'x', path: '/no/such/overlay/dir' }),
      [],
    );
  });
});

/** Build a minimal registry of overlays with given precedence. */
function reg(overlays) {
  return {
    schemaVersion: 1,
    overlays: overlays.map((o) => ({
      name: o.name,
      source: 'github:x/y',
      ref: null,
      path: `/home/.canary/overlays/${o.name}`,
      addedDate: '2026-07-20',
      consent: null,
      consentCommandsHash: null,
      precedence: o.precedence ?? null,
    })),
  };
}

/** Inject per-overlay skill-name lists keyed by overlay name. */
function readSkillNames(map) {
  return (entry) => map[entry.name] ?? [];
}

describe('detectSkillConflicts', () => {
  it('returns no conflicts when skill names are disjoint', () => {
    const conflicts = detectSkillConflicts(
      reg([{ name: 'a' }, { name: 'b' }]),
      { readSkillNames: readSkillNames({ a: ['s1'], b: ['s2'] }) },
    );
    assert.deepEqual(conflicts, []);
  });

  it('flags a same-named skill shipped by two overlays', () => {
    const conflicts = detectSkillConflicts(
      reg([{ name: 'a' }, { name: 'b' }]),
      { readSkillNames: readSkillNames({ a: ['dup'], b: ['dup'] }) },
    );
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0].skill, 'dup');
    assert.deepEqual(conflicts[0].contenders.map((c) => c.overlay).sort(), [
      'a',
      'b',
    ]);
  });

  it('is UNRESOLVED when contenders tie on precedence (both undeclared → 0)', () => {
    const [c] = detectSkillConflicts(reg([{ name: 'a' }, { name: 'b' }]), {
      readSkillNames: readSkillNames({ a: ['dup'], b: ['dup'] }),
    });
    assert.equal(c.resolved, false);
    assert.equal(c.winner, null);
  });

  it('is RESOLVED when exactly one contender has the highest precedence', () => {
    const [c] = detectSkillConflicts(
      reg([
        { name: 'a', precedence: 10 },
        { name: 'b', precedence: 1 },
      ]),
      { readSkillNames: readSkillNames({ a: ['dup'], b: ['dup'] }) },
    );
    assert.equal(c.resolved, true);
    assert.equal(c.winner, 'a');
  });

  it('treats null precedence as 0 against a positive declared value', () => {
    const [c] = detectSkillConflicts(
      reg([{ name: 'a' }, { name: 'b', precedence: 5 }]),
      { readSkillNames: readSkillNames({ a: ['dup'], b: ['dup'] }) },
    );
    assert.equal(c.winner, 'b');
    assert.equal(c.resolved, true);
  });

  it('is UNRESOLVED when the top precedence is shared by two overlays', () => {
    const [c] = detectSkillConflicts(
      reg([
        { name: 'a', precedence: 7 },
        { name: 'b', precedence: 7 },
        { name: 'c', precedence: 1 },
      ]),
      {
        readSkillNames: readSkillNames({
          a: ['dup'],
          b: ['dup'],
          c: ['dup'],
        }),
      },
    );
    assert.equal(c.resolved, false);
    assert.equal(c.winner, null);
    assert.equal(c.contenders.length, 3);
  });

  it('contenders are ordered by precedence desc then name', () => {
    const [c] = detectSkillConflicts(
      reg([
        { name: 'low', precedence: 1 },
        { name: 'high', precedence: 9 },
      ]),
      { readSkillNames: readSkillNames({ low: ['dup'], high: ['dup'] }) },
    );
    assert.deepEqual(
      c.contenders.map((x) => x.overlay),
      ['high', 'low'],
    );
  });

  it('returns conflicts sorted by skill name for stable output', () => {
    const conflicts = detectSkillConflicts(
      reg([{ name: 'a' }, { name: 'b' }]),
      {
        readSkillNames: readSkillNames({
          a: ['zebra', 'alpha'],
          b: ['zebra', 'alpha'],
        }),
      },
    );
    assert.deepEqual(
      conflicts.map((c) => c.skill),
      ['alpha', 'zebra'],
    );
  });
});
