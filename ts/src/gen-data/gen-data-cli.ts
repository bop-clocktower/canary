/**
 * `canary gen-data`: JSON Schema -> a seeded, literal-only vitest fixture
 * module (#765, spec steps 2 + 3, "D2 revisited").
 *
 * Exit codes follow the CLI-wide gate contract:
 *   - 2: usage -- bad --seed, unknown/unsupported --framework, unreadable
 *     schema, or a schema root that is not `type: "object"`.
 */
import { readFileSync } from 'node:fs';
import { Command } from 'commander';

import { CliExitError } from '../cli-common.js';
import { extractJsonSchema } from '../core/gen-data/json-schema.js';
import { parseSeed } from '../core/gen-data/prng.js';
import type { ShapeNode } from '../core/gen-data/shape.js';
import type { MainDeps } from '../main-deps.js';

const EXIT_USAGE = 2;

interface GenDataOpts {
  schema: string;
  framework: string;
  seed?: string;
  out: string;
  json?: boolean;
}

/** `null` = supported; a string = why this framework is refused. */
const FRAMEWORKS: Record<string, string | null> = {
  vitest: null,
  pytest: 'pytest is not yet supported in this slice (spec step 5)',
};

function usage(deps: MainDeps, message: string): never {
  deps.out(message);
  throw new CliExitError(EXIT_USAGE);
}

function validateUsage(opts: GenDataOpts, deps: MainDeps): { seed: number } {
  const refusal = Object.hasOwn(FRAMEWORKS, opts.framework)
    ? FRAMEWORKS[opts.framework]
    : `unknown framework "${opts.framework}"; expected vitest`;
  if (refusal) usage(deps, refusal);
  const seed = parseSeed(opts.seed);
  if (!seed.ok) usage(deps, seed.reason);
  return { seed: seed.seed };
}

function readSchema(path: string, deps: MainDeps): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as unknown;
  } catch (e) {
    return usage(
      deps,
      `cannot read schema ${path}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

function readRootShape(path: string, deps: MainDeps): ShapeNode {
  const shape = extractJsonSchema(readSchema(path, deps));
  if (shape.kind !== 'object')
    usage(deps, 'schema root must be type "object" in this slice');
  return shape;
}

function runGenData(opts: GenDataOpts, deps: MainDeps): void {
  validateUsage(opts, deps);
  readRootShape(opts.schema, deps);
}

export function buildGenDataCommand(deps: MainDeps): Command {
  return new Command('gen-data')
    .description(
      'Generate a seeded, literal-only vitest fixture module from a JSON Schema.',
    )
    .requiredOption('--schema <path>', 'JSON Schema file (root type: object).')
    .requiredOption('--framework <name>', 'Target test framework (vitest).')
    .option('--seed <n>', 'Integer seed (default 765).')
    .option('--out <dir>', 'Output directory.', 'tests/generated/fixtures')
    .option('--json', 'Print the generation report as JSON.')
    .action((opts: GenDataOpts) => {
      runGenData(opts, deps);
    });
}
