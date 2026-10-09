/**
 * An added line whose content starts with `++` is still an added line.
 *
 * REST `/pulls/{n}/files` patches start at the first `@@` hunk and carry no
 * `+++ ` file header, yet `suppressionsByPath` skipped every line starting
 * with `+++`. An added `++count; // canary:allow-untested fp: ...` therefore
 * hid a reviewer's false-positive verdict from adjudication (ADR 0025).
 *
 * Found by bug-fleet (area A2, base b0e258bd).
 */

import { describe, expect, it } from 'vitest';

import { suppressionsByPath } from '../src/guardian/adjudication.js';

describe('suppressionsByPath: added lines starting with ++', () => {
  it('reads a suppression on an added prefix-increment line', () => {
    const patch =
      '@@ -1,0 +1,1 @@\n+++count; // canary:allow-untested fp: trivially exercised';
    expect(
      suppressionsByPath([{ filename: 'src/a.ts', patch }]).get('src/a.ts'),
    ).toBe('false-positive');
  });
});
