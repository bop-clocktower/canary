import { afterEach, describe, expect, it } from 'vitest';

import { scanVacuity } from '../src/core/vacuity-scanner.js';
import { makeProject, type TempProject } from './scanner-testkit.js';

let project: TempProject | null = null;
afterEach(() => {
  project?.cleanup();
  project = null;
});

/**
 * String content is blanked to spaces before the declaration patterns run, so
 * a large multi-line fixture becomes a long run of whitespace and newlines. A
 * declaration pattern opening `(?:^|\n)\s*` restarts at every newline in that
 * run and re-consumes the rest of it, which is quadratic in the fixture size.
 */
describe('scanVacuity on a large multi-line fixture', () => {
  it(
    'scans a 16,000-line template-literal fixture in linear time',
    { timeout: 300_000 },
    () => {
      const fixture = Array.from({ length: 16_000 }, () => 'x'.repeat(80));
      const code =
        "import { f } from './f.js';\n" +
        `const big = \`\n${fixture.join('\n')}\n\`;\n` +
        "it('a', () => {\n  expect(f()).toBe(1);\n});\n";
      project = makeProject({ 'big.test.ts': code });
      const started = performance.now();
      scanVacuity(`${project.root}/big.test.ts`);
      expect(performance.now() - started).toBeLessThan(3000);
    },
  );
});
