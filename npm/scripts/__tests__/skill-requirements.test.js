const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  parseRequirement,
  checkRequirement,
  parseRequiresField,
} = require('../../dist/skill-requirements.js');

describe('parseRequirement', () => {
  it('parses a bare command', () => {
    assert.deepEqual(parseRequirement('python3'), {
      raw: 'python3',
      command: 'python3',
      op: null,
      version: null,
    });
  });

  it('parses command + version constraint', () => {
    assert.deepEqual(parseRequirement('python3>=3.11'), {
      raw: 'python3>=3.11',
      command: 'python3',
      op: '>=',
      version: '3.11',
    });
    assert.equal(parseRequirement('node>18').op, '>');
    assert.equal(parseRequirement('go==1.22.0').op, '==');
  });

  it('tolerates surrounding whitespace', () => {
    assert.equal(parseRequirement('  node >= 20 ').command, 'node');
    assert.equal(parseRequirement('  node >= 20 ').version, '20');
  });

  it('marks a token with no recognizable command as unparseable', () => {
    assert.equal(parseRequirement('>=3.11').command, null);
    assert.equal(parseRequirement('a b c').command, null);
  });
});

describe('parseRequiresField (flow list from frontmatter)', () => {
  it('reads a requires: [a, b] line', () => {
    const md = '---\nname: x\nrequires: [python3>=3.11, node]\n---\n\n# x\n';
    assert.deepEqual(parseRequiresField(md), ['python3>=3.11', 'node']);
  });
  it('returns [] when absent', () => {
    assert.deepEqual(parseRequiresField('---\nname: x\n---\n'), []);
  });
  it('returns [] when there is no frontmatter', () => {
    assert.deepEqual(parseRequiresField('# just prose\n'), []);
  });
});

// Fake probe: present set + version map.
function probe(present, versions = {}) {
  return (cmd) => ({
    present: present.includes(cmd),
    version: versions[cmd] ?? null,
  });
}

describe('checkRequirement', () => {
  it('ok when a bare command is present', () => {
    const r = checkRequirement(parseRequirement('node'), probe(['node']));
    assert.equal(r.status, 'ok');
  });

  it('missing when the command is absent', () => {
    const r = checkRequirement(parseRequirement('node'), probe([]));
    assert.equal(r.status, 'missing');
  });

  it('ok when present and version satisfies >=', () => {
    const r = checkRequirement(
      parseRequirement('python3>=3.11'),
      probe(['python3'], { python3: '3.14.5' }),
    );
    assert.equal(r.status, 'ok');
  });

  it('too-old when the version does not satisfy >=', () => {
    const r = checkRequirement(
      parseRequirement('python3>=3.11'),
      probe(['python3'], { python3: '3.9.7' }),
    );
    assert.equal(r.status, 'too-old');
    assert.match(r.detail, /3\.9\.7/);
  });

  it('unverifiable when present but version cannot be read', () => {
    const r = checkRequirement(
      parseRequirement('python3>=3.11'),
      probe(['python3'], { python3: null }),
    );
    assert.equal(r.status, 'unverifiable');
  });

  it('unparseable token is unverifiable, never a hard failure', () => {
    const r = checkRequirement(parseRequirement('>=3.11'), probe([]));
    assert.equal(r.status, 'unverifiable');
  });

  it('== compares on the shared version prefix', () => {
    assert.equal(
      checkRequirement(
        parseRequirement('go==1.22'),
        probe(['go'], { go: '1.22.4' }),
      ).status,
      'ok',
    );
    assert.equal(
      checkRequirement(
        parseRequirement('go==1.22'),
        probe(['go'], { go: '1.23.0' }),
      ).status,
      'too-old',
    );
  });
});
