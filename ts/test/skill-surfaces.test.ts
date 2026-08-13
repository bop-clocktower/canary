/**
 * Cross-surface skill-declaration integrity (#452 mechanism, #487 substrate).
 *
 * A canary skill is declared on more than one surface: the `SKILL.md` itself,
 * the plugin slash command that fronts it, the agent definition that dispatches
 * to it, and the per-host `agents/commands` / `agents/agents` trees. When those
 * surfaces disagree — a command documents `canary skills run canary-shadow` and
 * no skill answers to that name, or a `SKILL.md` frontmatter `name:` diverges
 * from its own directory — nothing today notices. Every surface is internally
 * consistent, so every per-surface assertion passes.
 *
 * The check therefore grades against AGREEMENT and against RESOLVABILITY, not
 * against a literal. Its two rules:
 *
 *   1. A declared name must be the name the invocation path actually uses.
 *   2. A documented invocation must reach something that exists and can run.
 *
 * ## What this deliberately does not do
 *
 * It does not elect a winner when two surfaces carry different prose. #452's
 * own triage settled that: with N disagreeing surfaces and no fixture-intent
 * floor, the honest report is the disagreement SET, never a majority vote —
 * majority-wins is wrong at N=2 and wrong generally when one surface is the
 * write path. Prose divergence is left unreported rather than reported with a
 * fabricated culprit.
 *
 * ## The denominator is part of the contract
 *
 * Handed a tree with no skills in it, this check must ABSTAIN — `checked: 0`
 * routed through `gateOutcome` — and never render as "all surfaces agree".
 * That case has its own test below, because "0 surfaces checked, consistent"
 * is the exact false-green shape this repo has been bitten by (#508, #544).
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
import {
  SurfaceFindingKind,
  SurfaceKind,
  checkSurfaces,
  collectSurfaces,
} from '../src/core/skill-surfaces.js';

const REPO_ROOT = join(import.meta.dirname, '..', '..');

let root: string;

/** Write a file, creating parents. Content is written verbatim. */
function write(rel: string, body: string): string {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, 'utf-8');
  return path;
}

/** A minimal harness skill: `agents/skills/claude-code/<name>/SKILL.md`. */
function skill(
  name: string,
  frontmatter: Record<string, string> = {},
  body = '',
): void {
  const fm = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
  write(
    join('agents', 'skills', 'claude-code', name, 'SKILL.md'),
    `---\nname: ${name}\ndescription: does a thing\n${fm}\n---\n\n${body}`,
  );
}

describe('collectSurfaces', () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'skill-surfaces-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('enumerates every surface a skill name can be declared on', () => {
    skill('canary-thing');
    write('commands/canary-thing.md', '---\ndescription: front\n---\nrun it\n');
    write('agents/canary-thing.md', '---\ndescription: agent\n---\ndispatch\n');
    write(
      join('agents', 'commands', 'claude-code', 'canary-thing.md'),
      '---\ndescription: host command\n---\n',
    );
    write(
      join('agents', 'agents', 'gemini-cli', 'canary-thing.md'),
      '---\ndescription: host agent\n---\n',
    );
    write(
      join('agents', 'skills', 'canary:flat.md'),
      '---\nname: canary:flat\n---\n',
    );

    const kinds = collectSurfaces(root).map((s) => s.kind);

    expect(new Set(kinds)).toEqual(
      new Set([
        SurfaceKind.Skill,
        SurfaceKind.FlatSkill,
        SurfaceKind.PluginCommand,
        SurfaceKind.PluginAgent,
        SurfaceKind.HarnessCommand,
        SurfaceKind.HarnessAgent,
      ]),
    );
  });

  it('reads the declared cli: path and the skill names a surface tells you to run', () => {
    skill(
      'canary-runner',
      { cli: 'scripts/cli.mjs' },
      'Run it:\n\n```bash\ncanary skills run canary-runner -- --help\n```\n',
    );

    const found = collectSurfaces(root).find((s) => s.name === 'canary-runner');

    expect(found?.cli).toBe('scripts/cli.mjs');
    expect(found?.references).toEqual(['canary-runner']);
  });

  it('does not mistake a placeholder for a referenced skill name', () => {
    // `canary skills run <name>` is prose, not a reference. Treating it as one
    // would report an unreachable skill literally called "<name>".
    skill(
      'canary-doc',
      {},
      '```bash\ncanary skills run <name> -- --help\n```\n',
    );

    expect(collectSurfaces(root)[0]?.references).toEqual([]);
  });

  it('ignores node_modules under the skills tree', () => {
    write(
      join('agents', 'skills', 'node_modules', 'pkg', 'SKILL.md'),
      '---\nname: vendored\n---\n',
    );

    expect(collectSurfaces(root)).toEqual([]);
  });

  it('finds surfaces in the real repository (the denominator is real)', () => {
    // If the directory layout is renamed, this fails rather than silently
    // reducing every check below to a vacuous pass over zero surfaces.
    const real = collectSurfaces(REPO_ROOT);
    expect(real.length).toBeGreaterThan(0);
    expect(
      real.filter((s) => s.kind === SurfaceKind.Skill).length,
    ).toBeGreaterThan(0);
    expect(real.filter((s) => s.cli !== null).length).toBeGreaterThan(0);
  });
});

describe('checkSurfaces', () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'skill-surfaces-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('ABSTAINS on a tree with no skill surfaces at all', () => {
    // The non-negotiable case. An empty input set is an abstention, never a
    // pass: `gateOutcome` must refuse to print success copy.
    mkdirSync(join(root, 'agents', 'skills'), { recursive: true });

    const result = checkSurfaces(root);
    const outcome = gateOutcome(result, 'advisory');

    expect(result.checked).toBe(0);
    expect(outcome.abstained).toBe(true);
    expect(outcome.summaryLine.toLowerCase()).toContain('abstained');
    expect(outcome.summaryLine).not.toContain('passed');
  });

  it('reports a clean tree as checked, with the surface count as denominator', () => {
    // The control: a non-zero denominator must still render a normal pass,
    // or the gate has traded a false green for a false alarm.
    skill('canary-clean');

    const result = checkSurfaces(root);

    expect(result.findings).toEqual([]);
    expect(result.checked).toBeGreaterThan(0);
    expect(gateOutcome(result, 'advisory').abstained).toBe(false);
  });

  it('flags a SKILL.md whose declared name diverges from its directory', () => {
    // `canary skills run <dir>` is how the docs invoke it, but discovery keys
    // off the frontmatter name -- so the documented invocation misses.
    write(
      join('agents', 'skills', 'claude-code', 'canary-renamed', 'SKILL.md'),
      '---\nname: canary-old-name\ndescription: d\n---\n',
    );

    const kinds = checkSurfaces(root).findings.map((f) => f.kind);

    expect(kinds).toContain(SurfaceFindingKind.NameMismatch);
  });

  it('flags a declared cli: target that does not exist', () => {
    skill('canary-ghost', { cli: 'scripts/gone.mjs' });

    const finding = checkSurfaces(root).findings.find(
      (f) => f.kind === SurfaceFindingKind.CliMissing,
    );

    expect(finding?.name).toBe('canary-ghost');
    expect(finding?.detail).toContain('scripts/gone.mjs');
  });

  it('flags a cli: target that exists but is not executable (#478)', () => {
    skill('canary-mode644', { cli: 'scripts/cli.mjs' });
    const cli = write(
      join(
        'agents',
        'skills',
        'claude-code',
        'canary-mode644',
        'scripts',
        'cli.mjs',
      ),
      '#!/usr/bin/env node\n',
    );
    chmodSync(cli, 0o644);

    const kinds = checkSurfaces(root).findings.map((f) => f.kind);

    expect(kinds).toContain(SurfaceFindingKind.CliNotExecutable);
  });

  it('does not flag an executable cli: target', () => {
    skill('canary-ok', { cli: 'scripts/cli.mjs' });
    const cli = write(
      join(
        'agents',
        'skills',
        'claude-code',
        'canary-ok',
        'scripts',
        'cli.mjs',
      ),
      '#!/usr/bin/env node\n',
    );
    chmodSync(cli, 0o755);

    expect(checkSurfaces(root).findings).toEqual([]);
  });

  it('flags a documented invocation of a skill that does not exist', () => {
    // The reachability half: the doc is plausible, the target is absent.
    skill(
      'canary-host',
      {},
      '```bash\ncanary skills run canary-vanished -- --help\n```\n',
    );

    const finding = checkSurfaces(root).findings.find(
      (f) => f.kind === SurfaceFindingKind.UnreachableReference,
    );

    expect(finding?.detail).toContain('canary-vanished');
  });

  it('accepts a documented invocation that resolves to a skill on another surface', () => {
    skill(
      'canary-a',
      {},
      '```bash\ncanary skills run canary-b -- --help\n```\n',
    );
    skill('canary-b');

    expect(checkSurfaces(root).findings).toEqual([]);
  });

  it('never elects a winner when two surfaces carry different prose', () => {
    // #452 triage: with no fixture-intent floor there is no principled culprit,
    // so prose divergence is not reported at all rather than reported wrongly.
    skill('canary-prose', { description: 'the skill says one thing' });
    write(
      'commands/canary-prose.md',
      '---\ndescription: the command says another\n---\n',
    );

    expect(checkSurfaces(root).findings).toEqual([]);
  });
});
