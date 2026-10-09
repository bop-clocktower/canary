/**
 * A JUnit report carrying a numeric character reference above U+10FFFF.
 *
 * The well-formedness check accepts any `&#N;` syntactically, and the reader
 * handed it straight to `String.fromCodePoint`, which throws a RangeError --
 * an uncaught stack trace from `history record` instead of a reading. The
 * reference is now left as written, the same as an unknown named entity.
 */

import { describe, expect, it } from 'vitest';

import { countReportResults } from '../src/history/run-recorder.js';

describe('JUnit numeric character references', () => {
  it.each([['&#x110000;'], ['&#1114112;'], ['&#99999999999;']])(
    'does not throw on an out-of-range reference %s',
    (ref) => {
      const xml =
        `<testsuite name="s"><testcase classname="c" name="t" time="0.1">` +
        `<failure message="bad ${ref} ref">x</failure></testcase></testsuite>`;
      expect(() => countReportResults(xml)).not.toThrow();
    },
  );
});
