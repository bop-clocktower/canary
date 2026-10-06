// `expect.files` for scripts/rehearse.mjs (#1188, #1193).
//
// A scanner fixture may list the files that must EACH fire, so one firing
// file cannot hide a silent one beside it -- the blackhawk fixture's plain
// `.mjs` test would otherwise fire the target while its `.test.tsx` (the JSX
// masking path) went quiet. Split out of rehearse.mjs to keep that file under
// the size budget.

/**
 * `manifest`, or a thrown error when its `expect.files` would make the
 * per-file check vacuous or throw mid-probe: `[]` passes `every` by
 * definition.
 */
export function checkedManifest(manifest) {
  const files = manifest.expect?.files;
  if (files === undefined) return manifest;
  const valid =
    Array.isArray(files) &&
    files.length > 0 &&
    files.every((f) => typeof f === 'string' && f !== '');
  if (!valid)
    throw new Error(
      `rehearsal/${manifest.id}: expect.files must be a non-empty array of paths`,
    );
  return manifest;
}

/** The rule fired -- in each of `expected.files` when the manifest lists them. */
export function firesInEveryFile(findings, expected) {
  const hits = findings
    .filter((f) => f.rule_id === expected.ruleId)
    .map((f) => String(f.file).replace(/\\/g, '/'));
  const { files } = expected;
  if (files === undefined) return hits.length > 0;
  if (!Array.isArray(files) || files.length === 0) return false;
  // A whole-segment match: `clock.test.mjs` must not match `xclock.test.mjs`.
  return files.every((rel) =>
    hits.some((f) => f === rel || f.endsWith(`/${rel}`)),
  );
}
