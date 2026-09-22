/**
 * A negated phrase must not match the keyword it negates.
 *
 * Issue #1080. `CATEGORY_KEYWORDS` is checked before the framework-hint rule
 * and matched with `String.includes`, so "No snapshot testing — assertions
 * only." matched the `visual` keyword `'snapshot test'`: a prompt that rules a
 * technique OUT was classified AS that technique, and the explicit `Vitest`
 * hint never got a chance to fire.
 *
 * The guard is deliberately narrow — a short negation-cue window immediately
 * before the match, cut at the clause boundary. It is not general negation
 * parsing, so the companion assertions below pin the other half of the
 * contract: a prompt that genuinely DOES ask for the technique must still
 * classify as that technique.
 *
 * Offline: pure function calls. Never executes a suite, never reaches the
 * network.
 */

import { describe, expect, it } from 'vitest';

import { TestClassifier } from '../src/core/classifier.js';

const EXAMPLE_PROMPT =
  'Generate a Vitest unit test for a function validateEmail(input: string). ' +
  'Use describe/it blocks. No snapshot testing — assertions only.';

describe('classifier negation guard (#1080)', () => {
  const clf = new TestClassifier();

  it('does not classify a negated category phrase as that category', () => {
    expect(clf.classify(EXAMPLE_PROMPT).test_type).toBe('frontend_unit');
  });

  it.each([
    ['no', 'Write a Vitest test. No snapshot test here.'],
    ['without', 'Write a Vitest test without snapshot testing.'],
    ['not', 'Write a Vitest test. This is not a snapshot test.'],
    ['avoid', 'Write a Vitest test. Avoid snapshot testing entirely.'],
    ['never', 'Write a Vitest test. Never use a snapshot test.'],
  ])('negation form %s suppresses the keyword', (_form, prompt) => {
    expect(clf.classify(prompt).test_type).toBe('frontend_unit');
  });

  it.each([
    ['snapshot test', 'Write a snapshot test for the header.', 'visual'],
    ['visual regression', 'Add a visual regression check.', 'visual'],
    ['contract test', 'Write a contract test for the orders API.', 'contract'],
    ['mutation test', 'Run a mutation test over the parser.', 'mutation'],
  ])(
    'a genuine request for %s still classifies as its category',
    (_kw, prompt, expected) => {
      expect(clf.classify(prompt).test_type).toBe(expected);
    },
  );

  it('does not let a negation leak across a sentence boundary', () => {
    const prompt =
      'No. We decided to add a snapshot test for the dashboard header.';
    expect(clf.classify(prompt).test_type).toBe('visual');
  });
});
