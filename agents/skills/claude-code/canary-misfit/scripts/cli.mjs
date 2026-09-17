#!/usr/bin/env node
// canary-misfit -- E2E resilience injection at the Playwright route layer (#592).
//
// The run itself is injected by `route_fixture/playwright-fixture.mjs`, which
// appends every fault it fires to a JSONL ledger. This CLI is the other half:
// it reads that ledger next to the Playwright JSON results and reports, per
// flow, whether the flow degraded gracefully, degraded, or shattered.
//
// Advisory by default (#508 D3): exit 0 whatever it finds, unless --strict.
// Under --strict: 1 = a flow shattered, 3 = abstained (no flow had a fault
// injected), 0 = nothing shattered.
//
// Precondition (adopted from harness-chaos): do not run this against a system
// with no resilience mechanisms implemented. Everything shatters and the report
// says nothing. See SKILL.md.

import fs from 'node:fs';
import path from 'node:path';

import {
  createParser,
  formatUsageError,
  EXIT_USAGE,
} from '../../../lib/parse-args.mjs';

import { validateProfile } from './profiles.mjs';
import { readFlows } from './flows.mjs';
import { readLedger, assessRun } from './verdict.mjs';
import {
  buildArtifact,
  renderMarkdown,
  annotations,
  ABSTAINED_LINE,
} from './report.mjs';

const PREFIX = 'canary-misfit:';

/** Exit code reserved family-wide for "abstained" (#508 D4). */
const EXIT_ABSTAINED = 3;

const USAGE =
  'usage: canary-misfit [-h] --profile PATH [--results PATH] [--ledger PATH]\n' +
  '                     [--seed N] [--out PATH] [--producer NAME] [--json] [--strict]\n' +
  '\n' +
  'Report per-flow resilience verdicts for a Playwright run made under a seeded\n' +
  'degradation profile. Advisory: never fails a build unless --strict.\n' +
  '\n' +
  'options:\n' +
  '  -h, --help       show this help message and exit\n' +
  '  --profile PATH   degradation profile JSON (schema_version 1)\n' +
  '  --results PATH   Playwright JSON results; omitted, the profile is resolved and printed\n' +
  '  --ledger PATH    JSONL injection ledger written by the route fixture\n' +
  '  --seed N         override the profile seed (reproduce a specific run)\n' +
  '  --out PATH       write the markdown report here as well as to stdout\n' +
  '  --producer NAME  producer label recorded in the artifact (default: playwright)\n' +
  '  --json           print the JSON artifact instead of markdown\n' +
  '  --strict         adopt the exit-code contract (1 shattered, 3 abstained)';

export const CLI_SPEC = {
  prog: 'canary-misfit',
  booleans: { '--json': 'json', '--strict': 'strict' },
  values: {
    '--profile': { key: 'profile' },
    '--results': { key: 'results' },
    '--ledger': { key: 'ledger' },
    '--seed': { key: 'seed', type: 'int' },
    '--out': { key: 'out' },
    '--producer': { key: 'producer' },
  },
  defaults: { producer: 'playwright' },
  required: ['--profile'],
};

const parseArgs = createParser(CLI_SPEC);

/** Read and validate the profile, or return the messages explaining why not. */
function loadProfile(profilePath, seedOverride) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
  } catch (exc) {
    return { errors: [`cannot read profile ${profilePath}: ${exc.message}`] };
  }
  const { profile, errors } = validateProfile(raw);
  if (errors.length) return { errors };
  if (seedOverride !== null && seedOverride !== undefined)
    profile.seed = seedOverride;
  return { profile };
}

/** `--profile` with no `--results`: show what would be injected, and stop. */
function describeProfile(profile) {
  console.log(`${PREFIX} profile "${profile.name}", seed ${profile.seed}`);
  for (const fault of profile.faults) {
    const detail =
      fault.kind === 'network'
        ? `${fault.profile} (${fault.envelope.latency_ms}ms +/-${fault.envelope.jitter_ms}ms, ` +
          `${fault.envelope.bandwidth_kbps}kbps, loss ${fault.envelope.loss_rate})`
        : `${fault.delay_ms ?? fault.status ?? fault.reason}`;
    console.log(
      `  ${fault.id}: ${fault.kind} ${detail} on ${fault.match} at rate ${fault.rate}`,
    );
  }
  console.log(
    `${PREFIX} no --results given, so nothing was assessed (profile resolved only).`,
  );
  return 0;
}

function writeReport(outPath, markdown) {
  try {
    fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
    fs.writeFileSync(outPath, markdown, 'utf8');
    return null;
  } catch (exc) {
    return `cannot write report: ${exc.message}`;
  }
}

/** The `--strict` exit contract. Advisory callers never reach this. */
function strictExitFor(assessment) {
  if (assessment.abstained) return EXIT_ABSTAINED;
  return assessment.counts.shattered > 0 ? 1 : 0;
}

function emit(artifact, args) {
  const markdown = renderMarkdown(artifact);
  console.log(args.json ? JSON.stringify(artifact, null, 2) : markdown);
  if (!args.json) {
    for (const annotation of annotations(artifact)) console.log(annotation);
  } else if (artifact.abstained) {
    // The JSON consumer gets the artifact's `abstained` flag, but a human
    // tailing the log would otherwise see a clean payload and read it as a pass.
    console.log(`::warning::${ABSTAINED_LINE}`);
  }
  return markdown;
}

/** Read the results + ledger and build the artifact, or name what went wrong. */
function assess(args, profile) {
  let flows;
  try {
    flows = readFlows(args.results);
  } catch (exc) {
    // An unreadable results file is an error, never "nothing shattered".
    return { error: exc.message };
  }
  const assessment = assessRun({
    flows,
    ledger: readLedger(args.ledger),
    profile,
  });
  return {
    assessment,
    artifact: buildArtifact({
      profile,
      profilePath: args.profile,
      assessment,
      producer: args.producer,
    }),
  };
}

export function main(argv = []) {
  const { opts: args, help, error } = parseArgs(argv);

  if (help) {
    console.log(USAGE);
    return 0;
  }
  if (error) {
    console.error(formatUsageError(CLI_SPEC.prog, error));
    return EXIT_USAGE;
  }

  const loaded = loadProfile(args.profile, args.seed);
  if (loaded.errors) {
    for (const message of loaded.errors) console.error(`${PREFIX} ${message}`);
    return 1;
  }
  if (!args.results) return describeProfile(loaded.profile);

  const assessed = assess(args, loaded.profile);
  if (assessed.error) {
    console.error(`${PREFIX} ${assessed.error}`);
    return 1;
  }

  const markdown = emit(assessed.artifact, args);
  if (args.out) {
    const failure = writeReport(args.out, markdown);
    if (failure) {
      console.error(`${PREFIX} ${failure}`);
      return 1;
    }
  }

  return args.strict ? strictExitFor(assessed.assessment) : 0;
}

// Direct execution (the skill runner execs this file via its shebang).
//
// `process.exitCode`, not `process.exit()`: a large `--json` payload exceeds
// the pipe buffer, and `process.exit` tears the process down mid-write, leaving
// truncated JSON that still exits 0 (#791).
if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = main(process.argv.slice(2));
}
