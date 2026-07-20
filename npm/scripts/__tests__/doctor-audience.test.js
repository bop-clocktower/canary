const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { unknownAudienceHint } = require('../../dist/doctor.js');

// Issue #294 + #319 B: an unrecognized --audience should surface the
// discoverable vocabulary, not silently filter to only the audience-less
// checks. (`--audience` is the renamed-off-`--persona` flag.)
describe('unknownAudienceHint', () => {
  it('returns null when no audience was passed', () => {
    assert.equal(unknownAudienceHint(null, ['backend', 'frontend']), null);
  });

  it('returns null when the audience is in the known vocabulary', () => {
    assert.equal(unknownAudienceHint('backend', ['backend', 'frontend']), null);
  });

  it('matches the known vocabulary case-insensitively', () => {
    assert.equal(unknownAudienceHint('Backend', ['backend']), null);
  });

  it('lists valid options for an unknown audience', () => {
    const hint = unknownAudienceHint('qa', ['backend', 'frontend']);
    assert.ok(hint);
    assert.match(hint, /qa/);
    assert.match(hint, /backend/);
    assert.match(hint, /frontend/);
  });

  it('explains that no audiences are defined when the vocabulary is empty', () => {
    const hint = unknownAudienceHint('qa', []);
    assert.ok(hint);
    assert.match(hint, /no overlay defines any audiences/i);
  });

  it('names the canonical --audience flag in its next-step advice', () => {
    const hint = unknownAudienceHint('qa', ['backend']);
    assert.ok(hint.length > 'qa'.length);
    assert.match(hint, /--audience/);
  });
});
