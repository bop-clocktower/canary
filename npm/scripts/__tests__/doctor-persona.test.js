const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { unknownPersonaHint } = require("../../dist/doctor.js");

// Issue #294: an unrecognized --persona should surface the discoverable
// vocabulary, not silently filter to only the persona-less checks.
describe("unknownPersonaHint", () => {
  it("returns null when no persona was passed", () => {
    assert.equal(unknownPersonaHint(null, ["backend", "frontend"]), null);
  });

  it("returns null when the persona is in the known vocabulary", () => {
    assert.equal(unknownPersonaHint("backend", ["backend", "frontend"]), null);
  });

  it("matches the known vocabulary case-insensitively", () => {
    assert.equal(unknownPersonaHint("Backend", ["backend"]), null);
  });

  it("lists valid options for an unknown persona", () => {
    const hint = unknownPersonaHint("qa", ["backend", "frontend"]);
    assert.ok(hint);
    assert.match(hint, /qa/);
    assert.match(hint, /backend/);
    assert.match(hint, /frontend/);
  });

  it("explains that no personas are defined when the vocabulary is empty", () => {
    const hint = unknownPersonaHint("qa", []);
    assert.ok(hint);
    assert.match(hint, /no overlay defines any personas/i);
  });

  it("never returns a bare value with no next step", () => {
    const hint = unknownPersonaHint("qa", ["backend"]);
    assert.ok(hint.length > "qa".length);
    assert.match(hint, /--persona/);
  });
});
