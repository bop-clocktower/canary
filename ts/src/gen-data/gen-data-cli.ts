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
 *     schema, a resolved schema root that is not an object, a schema that
 *     yields no valid fixture identifier, or an output that cannot be written.
 *   - 3 (EXIT_ABSTAINED): the root or every field is unresolved, or the
 *     self-check could not run. Writing a file whose detector-clean guarantee
 *     was never checked would be a silent pass, so nothing is written.
 *
 * With `--json`, every exit prints one JSON object: the report on success,
 * `{ outcome, exitCode, message, ... }` otherwise.
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
import { selfCheck } from '../core/gen-data/self-check.js';
import type { ShapeNode } from '../core/gen-data/shape.js';
import { EXIT_ABSTAINED } from '../core/gate-result.js';
import type { MainDeps } from '../main-deps.js';

const EXIT_USAGE = 2;
const EXIT_GENERATOR_BUG = 1;
const IDENT = /^[A-Za-z_$][\w$]*$/;

interface GenDataOpts {
  schema: string;
  framework: string;
  seed?: string;
  out: string;
  json?: boolean;
}
interface Ctx {
  opts: GenDataOpts;
  deps: MainDeps;
}
interface Failure {
  exitCode: number;
  outcome: string;
  message: string;
  /** Human output; defaults to the message alone. */
  lines?: string[];
  extra?: Record<string, unknown>;
}

/** `null` = supported; a string = why this framework is refused. */
const FRAMEWORKS: Record<string, string | null> = {
  vitest: null,
  pytest: 'pytest is not yet supported in this slice (spec step 5)',
};

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function fail(ctx: Ctx, f: Failure): never {
  if (ctx.opts.json === true) {
    const { exitCode, outcome, message } = f;
    ctx.deps.out(jsonIndent2({ outcome, exitCode, message, ...f.extra }));
  } else {
    for (const line of f.lines ?? [f.message]) ctx.deps.out(line);
  }
  throw new CliExitError(f.exitCode);
}

const usage = (ctx: Ctx, message: string): never =>
  fail(ctx, { exitCode: EXIT_USAGE, outcome: 'usage-error', message });

function validateUsage(ctx: Ctx): number {
  const { framework } = ctx.opts;
  const refusal = Object.hasOwn(FRAMEWORKS, framework)
    ? FRAMEWORKS[framework]
    : `unknown framework "${framework}"; expected vitest`;
  if (refusal) usage(ctx, refusal);
  const seed = parseSeed(ctx.opts.seed);
  return seed.ok ? seed.seed : usage(ctx, seed.reason);
}

function readSchema(ctx: Ctx, path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as unknown;
  } catch (e) {
    return usage(ctx, `cannot read schema ${path}: ${errorText(e)}`);
  }
}

/** An unresolved or union root is an abstention; any other scalar is usage. */
function checkRoot(ctx: Ctx, shape: ShapeNode): void {
  if (shape.kind === 'object') return;
  if (shape.kind !== 'unresolved' && shape.kind !== 'union')
    usage(ctx, 'schema root must be type "object" in this slice');
  const reason =
    shape.kind === 'unresolved'
      ? shape.reason
      : 'root is a union, not an object';
  fail(ctx, {
    exitCode: EXIT_ABSTAINED,
    outcome: 'abstained',
    message: `Abstained: schema root is unresolved (${reason}); no fixture written.`,
  });
}

/** Schema `title` when identifier-ish, else the file basename. */
function fixtureName(ctx: Ctx, schema: unknown, path: string): string {
  const title = (schema as { title?: unknown }).title;
  const raw =
    typeof title === 'string' && /^[A-Za-z][\w -]*$/.test(title)
      ? title
      : basename(path).replace(/(\.schema)?\.json$/, '');
  const name = fixtureNames(raw).camel;
  if (!IDENT.test(name))
    usage(
      ctx,
      `cannot derive a valid fixture identifier from ${path} (got "${name}"); give the schema an identifier-like "title"`,
    );
  return name;
}

const posixRelative = (from: string, to: string) =>
  relative(from, to).split(sep).join('/');

const unresolvedLines = (set: FixtureSet) =>
  set.unresolved.map((u) => `  - ${u.path}: ${u.reason}`);

function abstainOnZero(ctx: Ctx, set: FixtureSet): void {
  if (set.fieldsResolved > 0) return;
  const message = `Abstained: 0/${set.fieldsTotal} fields resolved in ${ctx.opts.schema}; no fixture written.`;
  fail(ctx, {
    exitCode: EXIT_ABSTAINED,
    outcome: 'abstained',
    message,
    lines: [message, ...unresolvedLines(set)],
    extra: {
      fieldsTotal: set.fieldsTotal,
      fieldsResolved: set.fieldsResolved,
      unresolved: set.unresolved,
    },
  });
}

async function checkEmitted(
  ctx: Ctx,
  text: string,
  outFile: string,
): Promise<string[]> {
  const run = ctx.deps.genDataSelfCheck ?? selfCheck;
  const check = await run(text, basename(outFile));
  if (check.status === 'unavailable')
    fail(ctx, {
      exitCode: EXIT_ABSTAINED,
      outcome: 'abstained',
      message: `Abstained: self-check could not run (${check.reason}); no fixture written.`,
    });
  if (check.findings.length === 0) return check.detectors;
  const message =
    'generator bug: emitted fixtures failed self-check; nothing written.';
  return fail(ctx, {
    exitCode: EXIT_GENERATOR_BUG,
    outcome: 'self-check-failed',
    message,
    lines: [
      ...check.findings.map(
        (f) => `${f.detector} ${f.ruleId} line ${f.line}: ${f.snippet}`,
      ),
      message,
    ],
    extra: { findings: check.findings },
  });
}

function writeOutput(ctx: Ctx, output: string, text: string): void {
  try {
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, text, 'utf-8');
  } catch (e) {
    usage(ctx, `cannot write fixture ${output}: ${errorText(e)}`);
  }
}

function report(
  ctx: Ctx,
  set: FixtureSet,
  meta: { target: string; output: string; detectors: string[] },
): void {
  const { deps } = ctx;
  if (ctx.opts.json === true) {
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

async function runGenData(ctx: Ctx): Promise<void> {
  const { opts, deps } = ctx;
  const seed = validateUsage(ctx);
  const schemaPath = resolve(deps.cwd(), opts.schema);
  const json = readSchema(ctx, schemaPath);
  const shape = extractJsonSchema(json);
  checkRoot(ctx, shape);
  const name = fixtureName(ctx, json, schemaPath);
  const set = generateFixtureSet(shape, name, seed);
  abstainOnZero(ctx, set);
  const target = posixRelative(deps.cwd(), schemaPath);
  const output = resolve(deps.cwd(), opts.out, `${set.name}.fixtures.ts`);
  const text = emitVitest(shape, set, target);
  const detectors = await checkEmitted(ctx, text, output);
  writeOutput(ctx, output, text);
  report(ctx, set, { target, output, detectors });
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
    .option('--json', 'Print the outcome as JSON, on every exit.')
    .action(async (opts: GenDataOpts) => {
      await runGenData({ opts, deps });
    });
}
