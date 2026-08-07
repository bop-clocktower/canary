/**
 * Structural guard: no executable surface may invoke `harness roadmap sync`
 * without `--no-state-change` (#595).
 *
 * Why this is a gate rather than a note. `roadmap sync` writes to the tracker in
 * two directions, and only one of them is safe here:
 *
 * - Pushing planning fields onto a linked issue is additive and reversible.
 * - Patching an issue's OPEN/CLOSED state is neither. `statusMap` maps roadmap
 *   `done` to `closed`, so a row whose status drifts ahead of reality closes a
 *   live issue, and `reverseStatusMap` will reopen one the other way. The
 *   roadmap is hand-edited; the tracker is where humans work. Letting the first
 *   silently drive the second is how a stale row acquires the authority to close
 *   someone's open bug.
 *
 * `--no-state-change` is upstream's CI-safe mode: labels and planning fields
 * converge, open/closed is left alone. Closure stays with the PR-merge auto-done
 * path, which is the one signal tied to work actually landing.
 *
 * The denominator problem this sits next to (#595): `tracker.labels` filters
 * sync to `harness-managed`, so it examines a fraction of the tracker. 19 linked
 * issues were labelled on 2026-08-07 to close that gap, which is exactly what
 * makes state-change dangerous now — before labelling, sync could barely see an
 * issue to close it.
 *
 * Offline: reads tracked files as text. Never runs `harness`, never touches the
 * network.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Surfaces that can actually execute a command. Prose in `docs/` is excluded on
 * purpose: a sentence naming the command is documentation, not an invocation,
 * and a guard that cannot tell them apart makes writing the docs impossible.
 */
const EXECUTABLE_PREFIXES = [
  '.github/workflows/',
  '.githooks/',
  'scripts/',
  'npm/scripts/',
];

const EXECUTABLE_EXACT = [
  'package.json',
  'ts/package.json',
  'npm/package.json',
];

/** Matches an invocation and captures the rest of that command line. */
const INVOCATION = /harness\s+roadmap\s+sync([^\n"']*)/g;

/**
 * Strip trailing `#` and `//` comments.
 *
 * A guard that cannot tell a comment from a command forbids ever explaining the
 * command in a comment — which this file's own wrapper tripped over on the first
 * run. The heuristic is deliberately blunt (it does not track string literals),
 * because the cost of a false negative here is one unguarded invocation hiding
 * behind a `#`, and the repo has no such line; the cost of a false positive is
 * making the documentation unwritable.
 */
function stripComments(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/(^|\s)(#|\/\/).*$/, ''))
    .join('\n');
}

export interface Invocation {
  file: string;
  /** Everything after `sync` on that line — the flags, if any. */
  tail: string;
  guarded: boolean;
}

/** Every `harness roadmap sync` in `text`, with whether the flag is present. */
export function findInvocations(file: string, text: string): Invocation[] {
  const found: Invocation[] = [];
  for (const match of stripComments(text).matchAll(INVOCATION)) {
    const tail = match[1] ?? '';
    found.push({ file, tail, guarded: tail.includes('--no-state-change') });
  }
  return found;
}

/** Tracked files on the executable surfaces, as `[path, contents]`. */
function executableFiles(): Array<[string, string]> {
  const tracked = execFileSync('git', ['ls-files'], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    maxBuffer: 32 * 1024 * 1024,
  })
    .split('\n')
    .filter(Boolean);

  return tracked
    .filter(
      (p) =>
        EXECUTABLE_EXACT.includes(p) ||
        EXECUTABLE_PREFIXES.some((prefix) => p.startsWith(prefix)),
    )
    .filter((p) => existsSync(join(REPO_ROOT, p)))
    .map((p) => [p, readFileSync(join(REPO_ROOT, p), 'utf-8')]);
}

describe('findInvocations', () => {
  it('flags a bare invocation', () => {
    const found = findInvocations('x.yml', 'npx harness roadmap sync --apply');
    expect(found).toHaveLength(1);
    expect(found[0].guarded).toBe(false);
  });

  it('accepts one carrying the flag', () => {
    const found = findInvocations(
      'x.yml',
      'npx harness roadmap sync --apply --no-state-change',
    );
    expect(found).toHaveLength(1);
    expect(found[0].guarded).toBe(true);
  });

  it('does not confuse a different roadmap subcommand', () => {
    expect(findInvocations('x.yml', 'harness roadmap reconcile')).toHaveLength(
      0,
    );
  });

  it('finds every invocation in a file, not just the first', () => {
    const found = findInvocations(
      'x.sh',
      'harness roadmap sync --no-state-change\nharness roadmap sync --apply\n',
    );
    expect(found.map((i) => i.guarded)).toEqual([true, false]);
  });

  it('tolerates extra whitespace between the words', () => {
    expect(findInvocations('x.sh', 'harness  roadmap   sync')).toHaveLength(1);
  });

  it('ignores a mention inside a comment', () => {
    expect(
      findInvocations('x.mjs', '// never call harness roadmap sync directly'),
    ).toHaveLength(0);
    expect(
      findInvocations('x.yml', '  # harness roadmap sync is wrapped'),
    ).toHaveLength(0);
  });

  it('still flags a command that has a comment after it', () => {
    const found = findInvocations(
      'x.sh',
      'harness roadmap sync --apply # TODO add the flag',
    );
    expect(found).toHaveLength(1);
    expect(found[0].guarded).toBe(false);
  });
});

describe('repository invariant', () => {
  const files = executableFiles();

  it('scans a non-empty set of executable surfaces', () => {
    // A zero denominator here would make every assertion below vacuous — the
    // guard would report clean because it read nothing. #508 doctrine.
    expect(files.length).toBeGreaterThan(0);
  });

  it('has no unguarded `harness roadmap sync` invocation', () => {
    const unguarded = files
      .flatMap(([path, text]) => findInvocations(path, text))
      .filter((i) => !i.guarded);

    expect(
      unguarded,
      unguarded.length === 0
        ? ''
        : `Unguarded \`harness roadmap sync\` in: ${unguarded
            .map((i) => i.file)
            .join(
              ', ',
            )}. Add --no-state-change, or call scripts/roadmap-sync.mjs.`,
    ).toEqual([]);
  });

  it('keeps a wrapper that hard-codes the flag', () => {
    // The invariant above passes trivially while the repo contains no
    // invocation at all, which is today's true state — so it is not the thing
    // protecting anyone. This is: the wrapper is the sanctioned path, and it
    // must append the flag unconditionally rather than accept it from a caller.
    //
    // It is asserted on source text rather than by matching an invocation,
    // because the wrapper spawns an argv ARRAY — there is no command line in it
    // for `findInvocations` to see. That gap is the point: the regex guards
    // shell and YAML surfaces, and a Node wrapper needs its own check.
    const wrapper = files.find(([p]) => p === 'scripts/roadmap-sync.mjs');
    expect(wrapper, 'scripts/roadmap-sync.mjs is missing').toBeDefined();

    const [, source] = wrapper!;
    expect(source).toContain("const REQUIRED_FLAG = '--no-state-change'");
    expect(
      source,
      'the flag must be spread into argv, not read from process.argv',
    ).toMatch(/'sync',\s*REQUIRED_FLAG/);
  });
});
