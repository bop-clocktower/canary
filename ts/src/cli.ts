/**
 * The main `canary` command -- the commander CLI, culmination of the CLI wave.
 * Mounts the sub-apps (`guardian`, `history`, `analyze`) plus the inline
 * `skills` / `workflow` / `company-knowledge` sub-apps, and the ~15 top-level
 * commands. This is the sole shipping entry point (the Python engine was
 * retired in the v6 cutover).
 *
 * Conventions follow `guardian/cli.ts` (see `cli-common.ts`): a
 * {@link createCanaryCommand} factory wired to an injectable {@link MainDeps},
 * `CliExit` for business exits, `normalizeUsageExit` on the program AND every
 * subcommand so usage errors exit 2 (typer/click) not commander's default 1, and
 * an eager `-V/--version` global option + `_main` callback analog.
 *
 * Sub-app mounting note: `guardian`/`history`/`analyze` are mounted as FRESH
 * instances via their `createXCommand()` factories (functionally identical to
 * the `guardianCommand`/`historyCommand`/`analyzeCommand` singletons but safe to
 * mount into multiple `createCanaryCommand()` calls, e.g. across tests).
 */

import { Command, Option } from 'commander';

import { CliExit, normalizeUsageExit } from './cli-common.js';
import { createAnalyzeCommand } from './analysis/cli.js';
import {
  doctorStub,
  feedbackCmd,
  flakeCheckCmd,
  frameworksCmd,
  healTestCmd,
  initCmd,
  migrateCmd,
  overlayStub,
  recommendCmd,
  reviewTestCmd,
  runCmd,
  setupCmd,
  ticketUpdateCmd,
  upgradeCmd,
  versionCmd,
} from './cli-commands.js';
import { buildCompanyKnowledgeCommand } from './company-knowledge-cli.js';
import { createGuardianCommand } from './guardian/cli.js';
import { createHistoryCommand } from './history/cli.js';
import { buildSkillsCommand } from './skills-cli.js';
import { buildWorkflowCommand } from './workflow-cli.js';
import { defaultMainDeps, type MainDeps } from './main-deps.js';

/** Build a fresh `canary` command wired to `depsInit` (defaults fill any gap). */
export function createCanaryCommand(depsInit: Partial<MainDeps> = {}): Command {
  const deps: MainDeps = { ...defaultMainDeps(), ...depsInit };

  const program = new Command();
  program
    .name('canary')
    .description('Canary -- AI-powered test automation agent.')
    .option('-V, --version', 'Show version and exit.')
    .exitOverride(normalizeUsageExit)
    .hook('preAction', () => {
      if (program.opts()['version']) {
        versionCmd(deps);
        throw new CliExit(0);
      }
    })
    .action(() => {
      if (program.opts()['version']) {
        versionCmd(deps);
        throw new CliExit(0);
      }
      // Python `typer.Typer(no_args_is_help=True)` prints help and exits 2 on a
      // bare `canary` invocation (a usage exit), NOT 0.
      program.outputHelp();
      throw new CliExit(2);
    });

  program
    .command('recommend')
    .description(
      'Classify a test prompt and recommend the best framework -- no API key required.',
    )
    .argument('<prompt>')
    .option('--json', 'Output as JSON for tool integration.')
    .action((prompt: string, opts: { json?: boolean }) => {
      recommendCmd(prompt, opts, deps);
    });

  program
    .command('frameworks')
    .description('List the supported testing frameworks and how to run each.')
    .option('--json', 'Dump the registry as JSON for tool integration.')
    .action((opts: { json?: boolean }) => {
      frameworksCmd(opts, deps);
    });

  program
    .command('feedback')
    .description('Report a bug, UX issue, doc gap, or idea.')
    .argument('[message]', 'Your feedback message.')
    .addOption(
      new Option('--category <category>', 'bug | ux | docs | idea').default(
        'idea',
      ),
    )
    .option('--json', 'Emit the payload + issue URL as JSON.')
    .option('--open', 'Open the pre-filled issue in a browser.')
    .action(
      (
        message: string | undefined,
        opts: { category: string; json?: boolean; open?: boolean },
      ) => {
        feedbackCmd(message, opts, deps);
      },
    );

  program
    .command('run')
    .description("Execute a test file using Canary's integrated executor.")
    .argument('<file_path>')
    .argument('<framework>', 'Framework to use (e.g., playwright, pytest)')
    .action((filePath: string, framework: string) => {
      runCmd(filePath, framework, deps);
    });

  program
    .command('init')
    .description(
      'Scaffold a test suite, or -- with no framework -- show setup options.',
    )
    .argument(
      '[framework]',
      'Framework to scaffold (playwright, vitest, pytest, k6). Omit to see options.',
    )
    .action((framework: string | undefined) => {
      initCmd(framework, deps);
    });

  program
    .command('setup')
    .description(
      'Set up canary in this repo -- interactive .canary/company.json wizard.',
    )
    .option('--force', 'Overwrite an existing .canary/company.json.')
    .action((opts: { force?: boolean }) => {
      setupCmd(opts, deps);
    });

  program
    .command('migrate')
    .description(
      "Migrate a harness-scaffolded test-suite project to Canary's layout.",
    )
    .addOption(
      new Option(
        '-p, --path <path>',
        'Project root to migrate (default: current directory).',
      ).default('.'),
    )
    .option('-f, --framework <framework>', 'Override auto-detected framework.')
    .option(
      '--from <overlay>',
      'Tracked overlay (name or path) whose .canary/skills/ are deployed into the target.',
    )
    .option(
      '-o, --overlay <path>',
      '[deprecated: use --from] Path to an overlay repo whose .canary/skills/ are deployed.',
    )
    .option(
      '--apply',
      'Write files. Without this flag the command is a dry run.',
    )
    .option('--check', 'Freshness gate: report drift without writing.')
    .option('--json', 'Emit the report as JSON.')
    .action(
      (opts: {
        path: string;
        framework?: string;
        from?: string;
        overlay?: string;
        apply?: boolean;
        check?: boolean;
        json?: boolean;
      }) => {
        migrateCmd(opts, deps);
      },
    );

  program
    .command('review-test')
    .description(
      'Lint test files for quality issues -- no LLM or API key required.',
    )
    .argument('<path>', 'Test file or directory to lint.')
    .option('--static', 'Run static-only analysis (no LLM).')
    .option('--no-static', 'Disable static-only analysis.')
    .option(
      '-f, --framework <framework>',
      'Force framework: pytest, playwright, vitest, k6.',
    )
    .option('--json', 'Output findings as JSON.')
    .action(
      (
        path: string,
        opts: { static?: boolean; framework?: string; json?: boolean },
      ) => {
        reviewTestCmd(path, opts, deps);
      },
    );

  program
    .command('flake-check')
    .description(
      'Detect flakiness patterns in test files -- no LLM or API key required.',
    )
    .argument('<path>', 'Test file or directory to check.')
    .option('--json', 'Output findings as JSON.')
    .action((path: string, opts: { json?: boolean }) => {
      flakeCheckCmd(path, opts, deps);
    });

  program
    .command('heal-test')
    .description(
      'Apply deterministic pattern fixes to a test file -- no LLM required.',
    )
    .argument('<path>', 'Test file to heal.')
    .option('--pattern', 'Apply regex-safe pattern fixes (no LLM).')
    .option('--no-pattern', 'Disable pattern fixes.')
    .option('--dry-run', 'Show what would change without writing.')
    .option('--json', 'Output results as JSON.')
    .action(
      (
        path: string,
        opts: { pattern?: boolean; dryRun?: boolean; json?: boolean },
      ) => {
        healTestCmd(path, opts, deps);
      },
    );

  program
    .command('version')
    .description('Show Canary version info.')
    .action(() => {
      versionCmd(deps);
    });

  program
    .command('upgrade')
    .description('Upgrade Canary to the latest published version.')
    .option('--dry-run', 'Show what would change without upgrading.')
    .action((opts: { dryRun?: boolean }) => {
      upgradeCmd(opts, deps);
    });

  program
    .command('overlay')
    .description(
      'Manage tracked overlays (requires the npm install of Canary).',
    )
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .argument('[args...]')
    .action(() => {
      overlayStub(deps);
    });

  program
    .command('doctor')
    .description(
      'Diagnose your Canary setup (requires the npm install of Canary).',
    )
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .argument('[args...]')
    .action(() => {
      doctorStub(deps);
    });

  program
    .command('ticket-update')
    .description(
      'Post a run comment and/or transition the linked ticket after a test run.',
    )
    .option(
      '--test-file <path>',
      'Test file to extract linkage from (default: last run).',
    )
    .option(
      '--result <path>',
      'Path to canary report JSON (default: auto-detect).',
    )
    .option('--dry-run', "Show what would be posted/transitioned; don't write.")
    .option('--comment-only', 'Post comment but skip transition.')
    .option('--transition-only', 'Transition only, skip comment.')
    .option('--project <project>', 'Override auto-detected project key.')
    .option(
      '--ticket <ticket>',
      'Override auto-detected ticket key (e.g. PROJ-1234).',
    )
    .action(async (opts) => {
      await ticketUpdateCmd(opts, deps);
    });

  // Sub-apps (fresh instances -- see module docstring). The already-ported
  // guardian/history/analyze factories carry their own deps; we forward the main
  // out/err sinks so their output flows through the same channel (captured in
  // tests, process.stdout in production).
  const sinks = { out: deps.out, err: deps.err };
  program.addCommand(createHistoryCommand(sinks));
  program.addCommand(createAnalyzeCommand(sinks));
  program.addCommand(createGuardianCommand(sinks));
  program.addCommand(buildSkillsCommand(deps));
  program.addCommand(buildWorkflowCommand(deps));
  program.addCommand(buildCompanyKnowledgeCommand(deps));

  // Propagate the usage-exit normalization to every top-level command (the
  // sub-apps also set it on their own subcommands internally).
  for (const sub of program.commands) {
    sub.exitOverride(normalizeUsageExit);
  }

  return program;
}

/** The production `canary` command (process-backed defaults). */
export const canaryCommand: Command = createCanaryCommand();
