/**
 * The three ci-ready checks backed by `.canary/test-inventory.json` (#957):
 * coverage-depth, assertion-quality and critical-paths.
 *
 * Pure: the CLI reads the two JSON files and hands their text in. Every input
 * that cannot be scored becomes a named reason, and every zero denominator is a
 * `skip` -- an inventory listing no tests, or a critical-area scope no test
 * touches, has verified nothing and must not read as a pass.
 *
 * Depth is the static tier from `test-inventory.ts` (0 no assertion, 1 weak
 * only, 2 shaped). "Area depth" is the best depth among tests whose file
 * imports the area, matched on extension-stripped path suffix.
 */
import {
  INVENTORY_SCHEMA_VERSION,
  type InventoryFile,
  type TestInventory,
} from './test-inventory.js';

const INVENTORY = '.canary/test-inventory.json';
const CRITICAL_AREAS = '.canary/critical-areas.json';
const TOP_AREAS = 5;

type CheckVerdict = 'pass' | 'warn' | 'fail' | 'skip';

/**
 * One scored check. Structurally identical to `CiCheck` in `ci-ready.ts`, and
 * declared here rather than imported so the dependency runs one way only
 * (ci-ready -> inventory-checks); importing it back is a cycle check-deps rejects.
 */
export interface InventoryCheck {
  name: string;
  verdict: CheckVerdict;
  reason: string;
}

type CiCheck = InventoryCheck;

export interface CriticalArea {
  path: string;
  risk_score: number;
}

export type InventoryInput =
  { ok: true; inventory: TestInventory } | { ok: false; reason: string };

export type CriticalAreasInput =
  { ok: true; areas: CriticalArea[] } | { ok: false; reason: string };

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** Parse the inventory file's text; `null` means the file does not exist. */
export function parseInventory(text: string | null): InventoryInput {
  if (text === null) {
    return {
      ok: false,
      reason: `no ${INVENTORY}: run \`canary inventory\` to produce it`,
    };
  }
  const data = parseJson(text) as Partial<TestInventory> | undefined;
  if (data === undefined || data === null || typeof data !== 'object') {
    return { ok: false, reason: `${INVENTORY} is not valid JSON` };
  }
  if (data.schema_version !== INVENTORY_SCHEMA_VERSION) {
    return {
      ok: false,
      reason: `${INVENTORY} has unsupported schema_version ${String(data.schema_version)} (this canary reads ${INVENTORY_SCHEMA_VERSION}); re-run \`canary inventory\``,
    };
  }
  if (!Array.isArray(data.files)) {
    return { ok: false, reason: `${INVENTORY} has no files list` };
  }
  // The schema is documented for hand-written inventories too, so an entry
  // without its arrays must abstain with a reason rather than crash scoring.
  const malformed = data.files.findIndex(
    (f) => !Array.isArray(f?.tests) || !Array.isArray(f?.targets),
  );
  if (malformed !== -1) {
    return {
      ok: false,
      reason: `${INVENTORY} has a malformed files entry at index ${malformed} (needs tests and targets arrays)`,
    };
  }
  return { ok: true, inventory: data as TestInventory };
}

/** Parse critical-areas.json's text; `null` means the file does not exist. */
export function parseCriticalAreas(text: string | null): CriticalAreasInput {
  if (text === null) return { ok: false, reason: `no ${CRITICAL_AREAS}` };
  const data = parseJson(text) as { areas?: unknown } | undefined;
  if (!data || !Array.isArray(data.areas)) {
    return { ok: false, reason: `${CRITICAL_AREAS} has no areas list` };
  }
  const areas = (data.areas as Partial<CriticalArea>[])
    .filter((a) => typeof a.path === 'string')
    .map((a) => ({ path: a.path!, risk_score: Number(a.risk_score ?? 0) }));
  return { ok: true, areas };
}

const stripExt = (p: string): string => p.replace(/\.[^./]+$/, '');

function matches(areaPath: string, target: string): boolean {
  const key = stripExt(areaPath);
  return (
    key === target || key.endsWith(`/${target}`) || target.endsWith(`/${key}`)
  );
}

function filesFor(inv: TestInventory, areaPath: string): InventoryFile[] {
  return inv.files.filter((f) => f.targets.some((t) => matches(areaPath, t)));
}

function areaDepth(inv: TestInventory, areaPath: string): number {
  let best = 0;
  for (const f of filesFor(inv, areaPath))
    for (const t of f.tests) best = Math.max(best, t.depth);
  return best;
}

const skip = (name: string, reason: string): CiCheck => ({
  name,
  verdict: 'skip',
  reason,
});

/** Critical-area paths when there are any, otherwise every imported target. */
function coverageScope(
  inv: TestInventory,
  areas: CriticalAreasInput,
): { paths: string[]; label: string } {
  if (areas.ok && areas.areas.length > 0) {
    return { paths: areas.areas.map((a) => a.path), label: 'critical area(s)' };
  }
  const targets = new Set(inv.files.flatMap((f) => f.targets));
  return { paths: [...targets], label: 'suite-wide import target(s)' };
}

function scoreCoverageDepth(
  inv: TestInventory,
  areas: CriticalAreasInput,
): CiCheck {
  const name = 'coverage-depth';
  const { paths, label } = coverageScope(inv, areas);
  if (paths.length === 0) {
    return skip(
      name,
      `no test imports first-party code, so there is no ${label} to score`,
    );
  }
  const depths = paths.map((p) => areaDepth(inv, p));
  const at0 = depths.filter((d) => d === 0).length;
  const at1 = depths.filter((d) => d === 1).length;
  const verdict: CheckVerdict = at0 > 0 ? 'fail' : at1 > 0 ? 'warn' : 'pass';
  return {
    name,
    verdict,
    reason: `${paths.length} ${label}: ${at0} at depth 0, ${at1} at depth 1, ${paths.length - at0 - at1} at depth 2`,
  };
}

function scopedTests(inv: TestInventory, areas: CriticalAreasInput) {
  if (!(areas.ok && areas.areas.length > 0)) {
    return { tests: inv.files.flatMap((f) => f.tests), label: 'suite-wide' };
  }
  const files = new Set(areas.areas.flatMap((a) => filesFor(inv, a.path)));
  return {
    tests: [...files].flatMap((f) => f.tests),
    label: 'in critical areas',
  };
}

function scoreAssertionQuality(
  inv: TestInventory,
  areas: CriticalAreasInput,
): CiCheck {
  const name = 'assertion-quality';
  const { tests, label } = scopedTests(inv, areas);
  if (tests.length === 0) {
    return skip(
      name,
      `no test imports any critical area, so 0 tests ${label} to score`,
    );
  }
  const weak = tests.filter((t) => t.depth <= 1).length;
  const verdict: CheckVerdict =
    weak === 0 ? 'pass' : weak * 2 > tests.length ? 'fail' : 'warn';
  return {
    name,
    verdict,
    reason: `${weak} of ${tests.length} test(s) ${label} at depth <= 1 (no shaped assertion)`,
  };
}

function scoreCriticalPaths(
  inv: TestInventory,
  areas: CriticalAreasInput,
): CiCheck {
  const name = 'critical-paths';
  if (!areas.ok) return skip(name, areas.reason);
  if (areas.areas.length === 0)
    return skip(name, `${CRITICAL_AREAS} lists no areas`);
  const top = [...areas.areas]
    .sort((a, b) => b.risk_score - a.risk_score)
    .slice(0, TOP_AREAS);
  const uncovered = top.filter((a) => areaDepth(inv, a.path) < 1);
  const verdict: CheckVerdict =
    uncovered.length === 0 ? 'pass' : uncovered.length === 1 ? 'warn' : 'fail';
  const names = uncovered.map((a) => a.path).join(', ');
  return {
    name,
    verdict,
    reason: `${uncovered.length} of the top ${top.length} area(s) uncovered${names ? `: ${names}` : ''}`,
  };
}

/** coverage-depth, assertion-quality, critical-paths -- in that order. */
export function scoreInventoryChecks(
  inventory: InventoryInput,
  areas: CriticalAreasInput,
): CiCheck[] {
  const names = ['coverage-depth', 'assertion-quality', 'critical-paths'];
  if (!inventory.ok) return names.map((n) => skip(n, inventory.reason));
  const inv = inventory.inventory;
  if (inv.files.every((f) => f.tests.length === 0)) {
    const reason = `${INVENTORY} lists 0 tests, so there is nothing to score (abstained)`;
    return names.map((n) => skip(n, reason));
  }
  return [
    scoreCoverageDepth(inv, areas),
    scoreAssertionQuality(inv, areas),
    scoreCriticalPaths(inv, areas),
  ];
}
