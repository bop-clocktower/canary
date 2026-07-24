// fastfail_check -- fail-fast config audit for a Playwright config (pure, read-
// only). Ported behavior-for-behavior from the Python original.
//
// Scans a `playwright.config.*` for the fail-fast knobs a suite should set so a
// broken CI run aborts early instead of burning the whole matrix. Never edits
// the config -- it recommends, and CANONICAL is the block to paste in.

const DASH = '\u2014'; // em dash (see digest.mjs)

// The block to paste into playwright.config.ts. Exported for reference; the CLI
// does not emit it.
export const CANONICAL = `export default defineConfig({
  // Fail fast in CI: abort once enough has clearly broken, never on local runs.
  forbidOnly: !!process.env.CI,             // a stray test.only fails the build
  maxFailures: process.env.CI ? 10 : 0,     // stop the run after 10 failures in CI
  retries: process.env.CI ? 2 : 0,          // absorb flakes in CI; surface them locally
  // ...your existing config
});
`;

// knob name -> why it matters, in the Python dict's insertion order.
const KNOBS = [
  ['forbidOnly', 'a stray `test.only` silently skips the rest of the suite'],
  [
    'maxFailures',
    'a broken run keeps burning the matrix instead of aborting early',
  ],
  [
    'retries',
    'flakes either fail the build or hide locally without a CI retry policy',
  ],
];

/**
 * Return one recommendation per fail-fast knob missing from the config text.
 * Empty array means all knobs are present. Substring scan -- good enough to flag
 * absence; it does not validate the knob's value.
 */
export function checkConfig(text) {
  return KNOBS.filter(([knob]) => !text.includes(knob)).map(
    ([knob, why]) => `Add \`${knob}\` ${DASH} without it, ${why}.`,
  );
}
