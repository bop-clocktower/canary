/**
 * `canary gen-data`: JSON Schema -> a seeded, literal-only vitest fixture
 * module (#765, spec steps 2 + 3, "D2 revisited").
 *
 * Exit codes follow the CLI-wide gate contract:
 *   - 0: the fixture module was written (possibly with unresolved fields,
 *     which are always disclosed).
 *   - 1: the emitted text failed its own blackhawk/savant self-check -- a
 *     generator bug; nothing is written.
 *   - 2: usage -- bad --seed, unknown/unsupported --framework, unreadable
 *     schema, or a schema root that is not `type: "object"`.
 *   - 3 (EXIT_ABSTAINED): zero fields resolved, or the self-check could not
 *     run. Writing a file whose detector-clean guarantee was never checked
 *     would be a silent pass, so nothing is written.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, relative, resolve, sep } from 'node:path';
import { Command } from 'commander';

import { CliExitError, jsonIndent2 } from '../cli-common.js';
import { emitVitest, fixtureNames } from '../core/gen-data/emit-vitest.js';
import {
  generateFixtureSet,
  type FixtureSet,
} from '../core/gen-data/generate.js';
import { extractJsonSchema } from '../core/gen-data/json-schema.js';
import { parseSeed } from '../core/gen-data/prng.js';
import type { ShapeNode } from '../core/gen-data/shape.js';
import { EXIT_ABSTAINED } from '../core/gate-result.js';
import type { MainDeps } from '../main-deps.js';

const EXIT_USAGE = 2;
const EXIT_GENERATOR_BUG = 1;

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

function validateUsage(opts: GenDataOpts, deps: MainDeps): number {
  const refusal = Object.hasOwn(FRAMEWORKS, opts.framework)
    ? FRAMEWORKS[opts.framework]
    : `unknown framework "${opts.framework}"; expected vitest`;
  if (refusal) usage(deps, refusal);
  const seed = parseSeed(opts.seed);
  return seed.ok ? seed.seed : usage(deps, seed.reason);
}

function readSchema(path: string, deps: MainDeps): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as unknown;
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    return usage(deps, `cannot read schema ${path}: ${why}`);
  }
}

/** Schema `title` when identifier-ish, else the file basename. */
function fixtureName(schema: unknown, path: string): string {
  const title = (schema as { title?: unknown }).title;
  if (typeof title === 'string' && /^[A-Za-z][\w -]*$/.test(title))
    return fixtureNames(title).camel;
  return fixtureNames(basename(path).replace(/(\.schema)?\.json$/, '')).camel;
}

const posixRelative = (from: string, to: string) =>
  relative(from, to).split(sep).join('/');

const unresolvedLines = (set: FixtureSet) =>
  set.unresolved.map((u) => `  - ${u.path}: ${u.reason}`);

function abstain(deps: MainDeps, lines: string[]): never {
  for (const line of lines) deps.out(line);
  throw new CliExitError(EXIT_ABSTAINED);
}

async function checkEmitted(
  text: string,
  outFile: string,
  deps: MainDeps,
): Promise<string[]> {
  const check = await deps.genDataSelfCheck(text, basename(outFile));
  if (check.status === 'unavailable')
    abstain(deps, [
      `Abstained: self-check could not run (${check.reason}); no fixture written.`,
    ]);
  if (check.findings.length > 0) {
    for (const f of check.findings)
      deps.out(`${f.detector} ${f.ruleId} line ${f.line}: ${f.snippet}`);
    deps.out(
      'generator bug: emitted fixtures failed self-check; nothing written.',
    );
    throw new CliExitError(EXIT_GENERATOR_BUG);
  }
  return check.detectors;
}

function report(
  set: FixtureSet,
  meta: { target: string; output: string; detectors: string[] },
  opts: GenDataOpts,
  deps: MainDeps,
): void {
  if (opts.json === true) {
    deps.out(
      jsonIndent2({
        target: meta.target,
        seed: set.seed,
        fieldsTotal: set.fieldsTotal,
        fieldsResolved: set.fieldsResolved,
        unresolved: set.unresolved,
        casesEmitted: set.cases.length,
        casesTruncated: set.casesTruncated,
        categoriesCovered: set.categoriesCovered,
        notCovered: set.notCovered,
        selfCheck: { status: 'ran', detectors: meta.detectors, findings: 0 },
        output: meta.output,
      }),
    );
    return;
  }
  deps.out(
    `Wrote ${meta.output}: ${set.fieldsResolved}/${set.fieldsTotal} fields resolved, ${set.cases.length} case(s) [${set.categoriesCovered.join(', ')}]`,
  );
  deps.out(
    'not covered: race, partial-network, accessibility (not data-expressible).',
  );
  for (const line of unresolvedLines(set)) deps.out(line);
  if (set.casesTruncated > 0)
    deps.out(`${set.casesTruncated} case(s) dropped at the 50-case cap.`);
}

async function runGenData(opts: GenDataOpts, deps: MainDeps): Promise<void> {
  const seed = validateUsage(opts, deps);
  const schemaPath = resolve(deps.cwd(), opts.schema);
  const json = readSchema(schemaPath, deps);
  const shape: ShapeNode = extractJsonSchema(json);
  if (shape.kind !== 'object')
    usage(deps, 'schema root must be type "object" in this slice');
  const set = generateFixtureSet(shape, fixtureName(json, schemaPath), seed);
  if (set.fieldsResolved === 0)
    abstain(deps, [
      `Abstained: 0/${set.fieldsTotal} fields resolved in ${opts.schema}; no fixture written.`,
      ...unresolvedLines(set),
    ]);
  const target = posixRelative(deps.cwd(), schemaPath);
  const output = resolve(deps.cwd(), opts.out, `${set.name}.fixtures.ts`);
  const text = emitVitest(shape, set, target);
  const detectors = await checkEmitted(text, output, deps);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, text, 'utf-8');
  report(set, { target, output, detectors }, opts, deps);
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
    .action(async (opts: GenDataOpts) => {
      await runGenData(opts, deps);
    });
}
