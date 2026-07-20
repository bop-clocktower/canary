const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { workingTreeStatus } = require('../../dist/overlay-commands.js');

/** A GitRunner stub that records the git args and returns a canned result. */
function stubGit(result) {
  const calls = [];
  const git = (args, opts) => {
    calls.push({ args, opts });
    return result;
  };
  return { git, calls };
}

describe('workingTreeStatus', () => {
  it("reports 'clean' on empty porcelain output", () => {
    const { git, calls } = stubGit({ status: 0, stdout: '', stderr: '' });
    assert.equal(workingTreeStatus('/clone', git), 'clean');
    assert.deepEqual(calls[0].args, ['status', '--porcelain']);
    assert.equal(calls[0].opts.cwd, '/clone');
  });

  it("reports 'dirty' when porcelain output is non-empty", () => {
    const { git } = stubGit({ status: 0, stdout: ' M SKILL.md\n', stderr: '' });
    assert.equal(workingTreeStatus('/clone', git), 'dirty');
  });

  it("reports 'unreadable' on non-zero git status", () => {
    const { git } = stubGit({
      status: 128,
      stdout: '',
      stderr: 'not a git repo',
    });
    assert.equal(workingTreeStatus('/clone', git), 'unreadable');
  });

  it('treats whitespace-only porcelain output as clean', () => {
    const { git } = stubGit({ status: 0, stdout: '   \n', stderr: '' });
    assert.equal(workingTreeStatus('/clone', git), 'clean');
  });
});
