/**
 * Documented SKILL.md examples are EXECUTED, not merely written (#487).
 *
 * #472 added `canary skills run canary-blackhawk -- --help` to a SKILL.md in
 * the same PR that left the command broken: the CLI landed at mode 644, so the
 * spawn hit `EACCES` and became a bare exit 1 with no output. The doc promised
 * something nobody had ever run. Same class as #465 (an architecture page
 * describing an engine deleted four majors earlier) and #455 (an operator guide
 * pointing at a file deleted as dead code). In each case the prose was
 * plausible and nothing executed it.
 *
 * #480 answered part of it with a hand-written `spawnSync(cli, ['--help'])` per
 * executable skill — which is why the exec-bit bug surfaced at all — but the
 * block is copied verbatim across five test files (#479). This module is the
 * discovery-driven form: iterate every SKILL.md, extract what the doc actually
 * says, and run it. A new skill is picked up automatically instead of waiting
 * for a sixth copy.
 *
 * ## Unverifiable is a finding, not a skip
 *
 * Not every documented block can be run. `canary skills run X -- <path>` is
 * illustrative; a genuine scan example writes a ledger; some examples need
 * credentials or a network. Those are classified UNVERIFIABLE with the reason
 * carried, and they travel in `GateResult.skipped` so `gateOutcome` renders
 * them in every summary line (D7). What they must never do is quietly leave
 * the denominator — "all 0 examples passed" is the shape #508 exists to catch,
 * and an all-illustrative corpus therefore ABSTAINS.
 *
 * This mirrors the dead-vs-slow distinction `reachability.ts` draws for #452:
 * an outcome the checker is not entitled to assert on gets its own status
 * rather than being folded into either pass or fail.
 */

import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { gateOutcome } from '../src/core/gate-result.js';
import { collectSurfaces } from '../src/core/skill-surfaces.js';
import {
  ExampleFindingKind,
  ExampleVerdict,
  type ExampleRunner,
  checkExamples,
  exampleArgv,
  extractExamples,
  runExamples,
} from '../src/core/skill-examples.js';

const REPO_ROOT = join(import.meta.dirname, '..', '..');

let root: string;

function write(rel: string, body: string): string {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, 'utf-8');
  return path;
}

/** A harness skill with an executable cli and a documented body. */
function execSkill(name: string, body: string): void {
  write(
    join('agents', 'skills', 'claude-code', name, 'SKILL.md'),
    `---\nname: ${name}\ndescription: d\ncli: scripts/cli.mjs\n---\n\n${body}`,
  );
  const cli = write(
    join('agents', 'skills', 'claude-code', name, 'scripts', 'cli.mjs'),
    '#!/usr/bin/env node\n',
  );
  chmodSync(cli, 0o755);
}

/** A runner that records what it was asked to run and always succeeds. */
function recordingRunner(): { runner: ExampleRunner; seen: string[] } {
  const seen: string[] = [];
  return {
    seen,
    runner: (command) => {
      seen.push(command);
      return { status: 0, output: 'usage: ...' };
    },
  };
}

describe('extractExamples', () => {
  it('extracts canary commands from fenced shell blocks', () => {
    const examples = extractExamples(
      ['```bash', 'canary skills list', '```'].join('\n'),
      'canary-x',
      '/tmp/SKILL.md',
    );

    expect(examples).toHaveLength(1);
    expect(examples[0]?.command).toBe('canary skills list');
    expect(examples[0]?.executable).toBe(true);
  });

  it('strips a shell prompt so `$ canary --help` is still recognised', () => {
    const examples = extractExamples(
      ['```console', '$ canary --help', '```'].join('\n'),
      'canary-x',
      '/tmp/SKILL.md',
    );

    expect(examples[0]?.command).toBe('canary --help');
  });

  it('ignores prose outside a fence and non-canary commands inside one', () => {
    const examples = extractExamples(
      [
        'Run `canary --help` in your shell.',
        '```bash',
        'npm install',
        'git status',
        '```',
      ].join('\n'),
      'canary-x',
      '/tmp/SKILL.md',
    );

    expect(examples).toEqual([]);
  });

  it('ignores fenced blocks that are not shell', () => {
    // The body is a verbatim canary command, so only the INFO STRING can
    // exclude it. Written that way deliberately: a fixture whose body also
    // fails the `canary`-prefix check passes even with fence detection
    // disabled, which is a test that binds to nothing.
    const examples = extractExamples(
      ['```text', 'canary --help', '```'].join('\n'),
      'canary-x',
      '/tmp/SKILL.md',
    );

    expect(examples).toEqual([]);
  });

  it('classifies a placeholder example as unverifiable, with the reason', () => {
    const examples = extractExamples(
      ['```bash', 'canary skills run canary-x -- <path>', '```'].join('\n'),
      'canary-x',
      '/tmp/SKILL.md',
    );

    expect(examples[0]?.executable).toBe(false);
    expect(examples[0]?.reason).toContain('placeholder');
  });

  it('classifies a side-effecting example as unverifiable rather than running it', () => {
    // A genuine scan writes a ledger. Running it against the working checkout
    // is exactly what #487 says must not happen.
    const examples = extractExamples(
      ['```bash', 'canary skills run canary-katana -- scan', '```'].join('\n'),
      'canary-katana',
      '/tmp/SKILL.md',
    );

    expect(examples[0]?.executable).toBe(false);
    expect(examples[0]?.reason).toContain('not help-shaped');
  });

  it('records the source line so a finding points at the doc that lied', () => {
    const examples = extractExamples(
      ['# Title', '', '```bash', 'canary --version', '```'].join('\n'),
      'canary-x',
      '/tmp/SKILL.md',
    );

    expect(examples[0]?.line).toBe(4);
  });
});

describe('runExamples', () => {
  it('executes the executable examples and reports each verdict', () => {
    const { runner, seen } = recordingRunner();
    const examples = extractExamples(
      [
        '```bash',
        'canary --help',
        'canary skills run canary-x -- <p>',
        '```',
      ].join('\n'),
      'canary-x',
      '/tmp/SKILL.md',
    );

    const results = runExamples(examples, runner, '/tmp/sandbox');

    expect(seen).toEqual(['canary --help']);
    expect(results.map((r) => r.verdict)).toEqual([
      ExampleVerdict.Executed,
      ExampleVerdict.Unverifiable,
    ]);
  });

  it('reports a non-zero exit as a failure carrying the captured output', () => {
    const runner: ExampleRunner = () => ({ status: 1, output: 'EACCES' });
    const examples = extractExamples(
      ['```bash', 'canary --help', '```'].join('\n'),
      'canary-x',
      '/tmp/SKILL.md',
    );

    const [result] = runExamples(examples, runner, '/tmp/sandbox');

    expect(result?.verdict).toBe(ExampleVerdict.Failed);
    expect(result?.detail).toContain('EACCES');
  });

  it('treats a spawn failure (status null) as a failure, never a pass', () => {
    // The #472 shape: a missing interpreter yields no status at all. Mapping
    // that to 0 is how a broken command reads as a working one.
    const runner: ExampleRunner = () => ({ status: null, output: '' });
    const examples = extractExamples(
      ['```bash', 'canary --help', '```'].join('\n'),
      'canary-x',
      '/tmp/SKILL.md',
    );

    expect(runExamples(examples, runner, '/tmp/sandbox')[0]?.verdict).toBe(
      ExampleVerdict.Failed,
    );
  });
});

describe('exampleArgv', () => {
  it('rewrites the leading `canary` token to the built CLI', () => {
    expect(exampleArgv('canary skills list', '/repo/ts/bin/canary.js')).toEqual(
      ['/repo/ts/bin/canary.js', 'skills', 'list'],
    );
  });

  it('inserts --allow-executable-skills BEFORE the `--` separator', () => {
    // Found by running the checker against this repo. Appending the flag put it
    // after `--`, so canary forwarded it to the skill as an argument, the
    // executable-skill guard still refused, and all four documented `skills
    // run ... -- --help` examples reported exit 3. The checker was measuring
    // its own sandbox, not the docs -- a false RED, and the same
    // "measured the wrong thing" class as a false green.
    expect(
      exampleArgv('canary skills run canary-x -- --help', '/bin/canary.js'),
    ).toEqual([
      '/bin/canary.js',
      'skills',
      'run',
      'canary-x',
      '--allow-executable-skills',
      '--',
      '--help',
    ]);
  });

  it('appends the opt-in when a skills-run example has no `--` separator', () => {
    expect(exampleArgv('canary skills run canary-x', '/bin/canary.js')).toEqual(
      [
        '/bin/canary.js',
        'skills',
        'run',
        'canary-x',
        '--allow-executable-skills',
      ],
    );
  });

  it('does not add the opt-in to an invocation that is not `skills run`', () => {
    expect(exampleArgv('canary skills list', '/bin/canary.js')).not.toContain(
      '--allow-executable-skills',
    );
  });
});

describe('checkExamples', () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'skill-examples-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('ABSTAINS when no example could be executed', () => {
    // The non-negotiable case: an all-illustrative corpus executed zero
    // commands, so it verified nothing. "0 examples passed" is not a pass.
    execSkill(
      'canary-illustrative',
      '```bash\ncanary skills run canary-illustrative -- <path>\n```\n',
    );
    const { runner } = recordingRunner();

    const result = checkExamples(collectSurfaces(root), runner, root);
    const outcome = gateOutcome(result, 'advisory', { noun: 'example(s)' });

    expect(result.checked).toBe(0);
    expect(outcome.abstained).toBe(true);
    expect(outcome.summaryLine.toLowerCase()).toContain('abstained');
  });

  it('carries every unverifiable example in `skipped`, with its reason', () => {
    execSkill(
      'canary-illustrative',
      '```bash\ncanary skills run canary-illustrative -- <path>\n```\n',
    );
    const { runner } = recordingRunner();

    const result = checkExamples(collectSurfaces(root), runner, root);

    expect(result.skipped).toHaveLength(1);
    expect(result.skipped?.[0]?.reason).toContain('placeholder');
    // D7: the skip renders in the summary line, so it cannot vanish.
    expect(
      gateOutcome(result, 'advisory', { noun: 'example(s)' }).summaryLine,
    ).toContain('skipped');
  });

  it('counts executed examples as the denominator and passes a clean corpus', () => {
    execSkill(
      'canary-good',
      '```bash\ncanary skills run canary-good -- --help\n```\n',
    );
    const { runner, seen } = recordingRunner();

    const result = checkExamples(collectSurfaces(root), runner, root);

    expect(seen).toEqual(['canary skills run canary-good -- --help']);
    expect(result.checked).toBe(1);
    expect(result.findings).toEqual([]);
  });

  it('reports a failing documented command as a finding naming the skill and line', () => {
    execSkill(
      'canary-broken',
      '```bash\ncanary skills run canary-broken -- --help\n```\n',
    );
    const runner: ExampleRunner = () => ({ status: 1, output: 'EACCES' });

    const finding = checkExamples(
      collectSurfaces(root),
      runner,
      root,
    ).findings.find((f) => f.kind === ExampleFindingKind.ExampleFailed);

    expect(finding?.skill).toBe('canary-broken');
    expect(finding?.detail).toContain('EACCES');
  });

  it('flags a cli-declaring skill whose doc has no executable example at all', () => {
    // #487 acceptance: every SKILL.md declaring `cli:` has at least one
    // EXECUTED example. A doc with none is unproven, not clean.
    execSkill('canary-undocumented', 'Prose only. No fenced commands here.\n');
    const { runner } = recordingRunner();

    const kinds = checkExamples(
      collectSurfaces(root),
      runner,
      root,
    ).findings.map((f) => f.kind);

    expect(kinds).toContain(ExampleFindingKind.NoDocumentedExample);
  });

  it('does not require examples from a markdown-only skill', () => {
    // Only code-bearing skills can have their commands broken by a mode bit.
    write(
      join('agents', 'skills', 'claude-code', 'canary-prose', 'SKILL.md'),
      '---\nname: canary-prose\ndescription: d\n---\n\nProse only.\n',
    );
    execSkill(
      'canary-good',
      '```bash\ncanary skills run canary-good -- --help\n```\n',
    );
    const { runner } = recordingRunner();

    const kinds = checkExamples(
      collectSurfaces(root),
      runner,
      root,
    ).findings.map((f) => f.kind);

    expect(kinds).not.toContain(ExampleFindingKind.NoDocumentedExample);
  });

  it('extracts a real, non-zero example denominator from this repository', () => {
    // The denominator on the real corpus, asserted so a rename cannot reduce
    // the CI job to a vacuous pass over zero examples.
    const surfaces = collectSurfaces(REPO_ROOT);
    const { runner } = recordingRunner();

    const result = checkExamples(surfaces, runner, REPO_ROOT);

    expect(result.checked).toBeGreaterThan(0);
  });
});
