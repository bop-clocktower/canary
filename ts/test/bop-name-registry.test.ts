/**
 * Cross-surface consistency check for `canary-*` skill names (#754).
 *
 * Three surfaces mint names and none of them reads the others: `### canary-*`
 * rows in `docs/roadmap.md`, GitHub issue titles, and the directories that
 * actually ship under `agents/skills/claude-code/`. The same name was claimed
 * twice on three separate occasions. The second occurrence was diagnosed
 * correctly and the diagnosis written into the `canary-cassandra` roadmap row —
 * inside one of the colliding surfaces — and a third collision followed
 * sixteen days later. A comment is not a check.
 *
 * `docs/naming-registry.md` is now the single mint. These tests fail when any
 * surface disagrees with it, and every message names the surface and the edit
 * that fixes it.
 *
 * Offline: reads three files/directories from the working tree. Never reaches
 * the network, so the tracker is covered transitively — a registry row's
 * `Issue` must match the matching roadmap row's `External-ID`.
 *
 * The invariants:
 *
 * 1. Every name minted on a surface is registered exactly once.
 * 2. A `shipped` registry row has a real skill directory.
 * 3. A `retired` name appears on no surface. `oracle` must never come back.
 * 4. A registry `Issue` agrees with the roadmap row's `External-ID`.
 * 5. Each surface yields a non-zero denominator. A check that matched nothing
 *    abstained; it did not pass.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const REGISTRY_PATH = join(REPO_ROOT, 'docs', 'naming-registry.md');
const ROADMAP_PATH = join(REPO_ROOT, 'docs', 'roadmap.md');
const SKILLS_DIR = join(REPO_ROOT, 'agents', 'skills', 'claude-code');

/** Where a name was minted, for failure messages that name the surface. */
const REGISTRY_REL = 'docs/naming-registry.md';
const ROADMAP_REL = 'docs/roadmap.md';
const SKILLS_REL = 'agents/skills/claude-code';

type Status = 'shipped' | 'reserved' | 'retired';
const STATUSES: readonly Status[] = ['shipped', 'reserved', 'retired'];

interface RegistryRow {
  name: string;
  /** Verbatim, so an unknown value is a test failure and not a parse error. */
  status: string;
  /** Tracker issue number, or null when the row carries the em-dash. */
  issue: number | null;
}

/**
 * Registry rows, in file order.
 *
 * Parses the pipe table under `## The registry`. Only rows whose first cell is
 * a backticked `canary-*` (or the retired `oracle`) name count, so the prose
 * tables above it — including the collision history — are ignored without
 * needing to track their position.
 */
/** A backticked name in the first cell is what makes a line a claim. */
const NAME_CELL = /^`([a-z0-9-]+)`$/;
const ISSUE_CELL = /^\d+$/;

function readRegistry(): RegistryRow[] {
  const body = readFileSync(REGISTRY_PATH, 'utf-8');
  const section = body.split('## The registry')[1] ?? '';

  return section
    .split('\n')
    .map(tableCells)
    .map(parseRegistryRow)
    .filter((r): r is RegistryRow => r !== null);
}

/** Name, status, and issue cells of a table line — `null` for a non-row. */
type Cells = readonly [name: string, status: string, issue: string];

function tableCells(line: string): Cells | null {
  if (!line.trimStart().startsWith('|')) return null;
  const cells = line
    .split('|')
    .slice(1, -1)
    .map((c) => c.trim());
  const [name = '', status = '', issue = ''] = cells;
  return [name, status, issue];
}

/** One registry row, or `null` when the cells are not a name claim. */
function parseRegistryRow(cells: Cells | null): RegistryRow | null {
  if (cells === null) return null;
  const [nameCell, status, issueCell] = cells;

  const nameMatch = NAME_CELL.exec(nameCell);
  if (nameMatch === null) return null;

  return {
    name: nameMatch[1] as string,
    status,
    issue: ISSUE_CELL.test(issueCell) ? Number(issueCell) : null,
  };
}

/** Roadmap-minted names, as `name -> issue number` (null when unparseable). */
function readRoadmapNames(): Map<string, number | null> {
  const body = readFileSync(ROADMAP_PATH, 'utf-8');
  const names = new Map<string, number | null>();

  // A heading claims a name only when it BEGINS with it. "Gate
  // canary-promote-test on structured test-craft verdicts" mentions a shipped
  // skill in prose and mints nothing.
  for (const block of body.split(/^### /m).slice(1)) {
    const heading = block.split('\n', 1)[0] ?? '';
    const claim = /^(canary-[a-z0-9-]+)(?:\s|$)/.exec(heading);
    if (!claim) continue;
    const external = /\*\*External-ID:\*\*\s*\S*#(\d+)/.exec(block);
    names.set(claim[1] as string, external ? Number(external[1]) : null);
  }

  return names;
}

/** Shipped skill directories. */
function readShippedNames(): string[] {
  return readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

describe('canary-* name registry (#754)', () => {
  const registry = readRegistry();
  const roadmapNames = readRoadmapNames();
  const shippedNames = readShippedNames();
  const byName = new Map(registry.map((r) => [r.name, r]));

  describe('the check itself has a denominator', () => {
    // Every assertion below iterates a surface. A surface that silently
    // yielded nothing — a moved directory, a heading format change — would
    // make each of them vacuously green, which is the exact shape of
    // false-green this repo treats as an abstention rather than a pass.

    it('parses registry rows', () => {
      expect(
        registry.length,
        `${REGISTRY_REL}: parsed zero rows. The "## The registry" table is ` +
          'missing or its shape changed; every assertion below is vacuous ' +
          'until it parses.',
      ).toBeGreaterThan(0);
    });

    it('parses roadmap name claims', () => {
      expect(
        roadmapNames.size,
        `${ROADMAP_REL}: parsed zero "### canary-*" rows. The heading format ` +
          'changed; the roadmap surface is unchecked until it parses.',
      ).toBeGreaterThan(0);
    });

    it('finds shipped skill directories', () => {
      expect(
        shippedNames.length,
        `${SKILLS_REL}: found zero directories. The skills moved; the ` +
          'shipped surface is unchecked until this resolves.',
      ).toBeGreaterThan(0);
    });
  });

  it('uses only known statuses', () => {
    const unknown = registry
      .filter((r) => !STATUSES.includes(r.status as Status))
      .map((r) => `${r.name} ("${r.status}")`);

    expect(
      unknown,
      `${REGISTRY_REL}: ${unknown.join(', ')} — use one of ` +
        `${STATUSES.join(', ')}.`,
    ).toEqual([]);
  });

  it('registers each name exactly once', () => {
    const counts = new Map<string, number>();
    for (const row of registry) {
      counts.set(row.name, (counts.get(row.name) ?? 0) + 1);
    }
    const duplicates = [...counts].filter(([, n]) => n > 1).map(([n]) => n);

    expect(
      duplicates,
      `${REGISTRY_REL}: duplicate rows for ${duplicates.join(', ')}. ` +
        'One name, one row — merge them and keep the surviving status.',
    ).toEqual([]);
  });

  it('registers every name the roadmap mints', () => {
    const unregistered = [...roadmapNames.keys()].filter((n) => !byName.has(n));

    expect(
      unregistered,
      `${ROADMAP_REL} mints ${unregistered.join(', ')}, which ${REGISTRY_REL} ` +
        'does not list. Either add a registry row (the name is genuinely new) ' +
        'or rename the roadmap row (the name is already claimed). Tiebreak: ' +
        'the better thematic fit keeps the name.',
    ).toEqual([]);
  });

  it('registers every name that ships', () => {
    const unregistered = shippedNames.filter((n) => !byName.has(n));

    expect(
      unregistered,
      `${SKILLS_REL}/ ships ${unregistered.join(', ')}, which ${REGISTRY_REL} ` +
        'does not list. Add a row with status "shipped".',
    ).toEqual([]);
  });

  it('marks a name shipped only when its directory exists', () => {
    const shipped = new Set(shippedNames);
    const phantom = registry
      .filter((r) => r.status === 'shipped' && !shipped.has(r.name))
      .map((r) => r.name);

    expect(
      phantom,
      `${REGISTRY_REL} marks ${phantom.join(', ')} as "shipped", but there is ` +
        `no ${SKILLS_REL}/<name>/ directory. Either the skill was removed ` +
        '(retire the row) or it was never built (set the status to ' +
        '"reserved").',
    ).toEqual([]);
  });

  it('marks a shipped directory as shipped, not reserved', () => {
    const understated = shippedNames
      .filter((n) => byName.get(n)?.status === 'reserved')
      .map((n) => n);

    expect(
      understated,
      `${SKILLS_REL}/ ships ${understated.join(', ')}, but ${REGISTRY_REL} ` +
        'still calls them "reserved". Change the status to "shipped".',
    ).toEqual([]);
  });

  it('keeps retired names off every surface', () => {
    const retired = registry
      .filter((r) => r.status === 'retired')
      .map((r) => r.name);

    // The retired list is the whole point of keeping rows forever; an empty
    // one means the rows were deleted rather than retired.
    expect(
      retired.length,
      `${REGISTRY_REL}: no rows with status "retired". Retired rows stay in ` +
        'the table forever — `oracle` is the standing example.',
    ).toBeGreaterThan(0);

    const shipped = new Set(shippedNames);
    const resurrected = retired.filter(
      (n) => shipped.has(n) || roadmapNames.has(n),
    );

    expect(
      resurrected,
      `${resurrected.join(', ')} is retired in ${REGISTRY_REL} but appears ` +
        `on a live surface (${ROADMAP_REL} or ${SKILLS_REL}/). A retired ` +
        'name is never reused — pick a different one.',
    ).toEqual([]);
  });

  it('agrees with the roadmap on issue numbers', () => {
    const mismatched: string[] = [];

    for (const [name, roadmapIssue] of roadmapNames) {
      const row = byName.get(name);
      if (!row || row.issue === null || roadmapIssue === null) continue;
      if (row.issue !== roadmapIssue) {
        mismatched.push(
          `${name}: registry #${row.issue} vs roadmap #${roadmapIssue}`,
        );
      }
    }

    expect(
      mismatched,
      `${REGISTRY_REL} and ${ROADMAP_REL} disagree on which issue owns a ` +
        `name — ${mismatched.join('; ')}. The tracker is the third minting ` +
        'surface and this comparison is the only mechanical link to it, so a ' +
        'mismatch means one of the two rows is tracking the wrong work.',
    ).toEqual([]);
  });
});
