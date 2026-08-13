/**
 * Canary Migrator -- detects harness-scaffolded test-suite projects and migrates
 * them to Canary's layout without touching existing test files.
 *
 * Faithful TypeScript port of `agent/core/migrator.py`.
 *
 * Python->TS nuances:
 *   - `_PYTHON_DEP_PATTERNS` are `re.MULTILINE | re.IGNORECASE` `^`-anchored
 *     patterns. Python `re.MULTILINE` anchors `^` on `\n` ONLY, whereas JS `^`
 *     under the `m` flag also breaks on `\r`, U+2028 and U+2029. To preserve the
 *     oracle exactly, these do NOT use the `m` flag: the `^` is expressed as
 *     `(?:^|(?<=\n))` (start-of-string OR immediately after a `\n`), and
 *     `re.IGNORECASE` maps to the `i` flag. The remaining regexes
 *     (`_PW_UI_FIXTURE_RE`, `_PACKAGE_SCRIPT_PATTERNS`) contain no `^`/`$`
 *     anchors, so `re.MULTILINE` there is a no-op and is dropped. None of these
 *     regexes carry the `g` flag, so `.test()` is not stateful.
 *   - Skill directories are copied with `cpSync(..., {recursive:true})`
 *     (shutil.copytree) and removed with `rmSync(..., {recursive:true,
 *     force:true})` (shutil.rmtree). The deploy manifest is `writeFileSync`'d as
 *     `JSON.stringify(..., 2) + "\n"` run through {@link ensureAscii} to match
 *     `json.dumps(indent=2)` (ensure_ascii defaults to True). Python text-mode
 *     writes `\n` verbatim on POSIX; `writeFileSync` does the same. The manifest
 *     is round-tripped only by this module, so the file content is an internal
 *     contract, not a cross-runtime one.
 *   - `_hash_skill_dir` hashes the sorted `(relative-posix-path, bytes)` pairs of
 *     every file under a skill dir. Hashes are only ever compared between two
 *     invocations of THIS function (overlay vs. deployed, or vs. the recorded
 *     manifest hash), so the sort must merely be internally consistent; sorting
 *     by relative-posix-path string matches Python's Path ordering for the flat /
 *     shallow ASCII skill trees in play.
 *   - Human-facing markdown keeps the exact glyphs the oracle emits (checkmark
 *     U+2705, warning sign U+26A0, em-dash U+2014); they are written as `\u{...}`
 *     escapes so this source stays ASCII while the emitted bytes are identical.
 *   - `Path.home()` (the `~/.canary/skills` overlay tier) is an injectable
 *     constructor argument (defaults to `os.homedir()`), the same test seam the
 *     skill-registry port uses -- Python patches `Path.home()` in its tests.
 *   - Python truthiness (`""`/`None`/`{}`/`[]` falsy) via {@link pyTruthy}.
 */

import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { readJsonWithWarning } from './config-validation.js';
import { uncertainDetectionMessage } from './detection.js';
import {
  CONFIG_PROBES,
  inferPlaywrightTestType,
  probeFramework,
  ProbeResult,
} from './framework-probes.js';
import {
  WORKSPACE_SKIP_DIRS,
  comparePathParts,
  globDirs,
  globFiles,
  isDir,
  isFile,
  parseJsonOrNull,
  readTextOrNull,
} from './fs-glob.js';
import {
  detectWorkspace,
  WorkspaceFinding,
  WorkspaceInfo,
  workspaceGlobs,
} from './workspace-detect.js';
import { FrameworkRegistry } from './framework-registry.js';
import { EXIT_ABSTAINED, gateOutcome, GateResult } from './gate-result.js';
import { Scaffolder, scaffoldableFrameworks, TEMPLATES } from './scaffolder.js';
import { SkillInfo, SkillRegistry } from './skill-registry.js';

// ---------------------------------------------------------------------------
// Python-compatibility helpers (copied locally per-module, matching reporter.ts)
// ---------------------------------------------------------------------------

/** Python-truthiness (`null`/`undefined`/`false`/`0`/`""`/`[]`/`{}` falsy). */
function pyTruthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false;
  if (value === 0 || value === '') return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return Boolean(value);
}

/**
 * Reproduce `json.dumps(..., ensure_ascii=True)` on `JSON.stringify` output:
 * escape every code point >= 0x80 as `\uXXXX`. (Same helper as reporter.ts.)
 */
function ensureAscii(json: string): string {
  return json.replace(
    /[\u0080-\uffff]/g,
    (ch) => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'),
  );
}

// Non-ASCII glyphs kept out of the source text as escapes, emitted verbatim.
const CHECK = '\u{2705}'; // white heavy check mark
const WARN = '\u{26A0}'; // warning sign
const EMDASH = '\u{2014}'; // em dash

// ---------------------------------------------------------------------------
// Deploy manifest
// ---------------------------------------------------------------------------

// Records the content hash of each skill at deploy time so the freshness gate
// can tell an untouched deployment (safe to refresh) from a hand-edited one.
// Lives beside the deployed skills; never a deployable skill itself (leading dot
// -> skipped by the skill scanner).
export const DEPLOY_MANIFEST_NAME = '.deploy-manifest.json';

type ManifestEntry = { name: string; hash: string };
type Manifest = Record<string, ManifestEntry>;

/**
 * Provenance for one installed workflow (#459), keyed by the file name under
 * `.github/workflows/`.
 *
 * `version` is the load-bearing field. Workflow install NEVER overwrites a
 * differing file, so without a recorded version a corrected template could
 * never be pushed to a repo that already adopted a broken one: the report
 * could only say "these differ". With it, the report can distinguish "you have
 * v1, the overlay ships v2, and you have not touched it" (safe to take with
 * `--force`) from "you edited this yourself". #369 is the concrete case -- a
 * shipped guardian template whose gate silently no-ops.
 */
type WorkflowManifestEntry = {
  skill: string;
  template: string;
  version: string;
  hash: string;
};
type WorkflowManifest = Record<string, WorkflowManifestEntry>;

/** The whole manifest document: skill provenance plus workflow provenance. */
type ManifestDoc = { skills: Manifest; workflows: WorkflowManifest };

/**
 * A stable sha256 of every file under *skillDir* (component-sorted rel-path +
 * bytes). Exported so a test can pin it byte-for-byte to the Python oracle:
 * this hash is compared against Python-written .deploy-manifest.json files on
 * the upgrade path, so any drift misclassifies untouched skills.
 */
export function hashSkillDir(skillDir: string): string {
  const h = createHash('sha256');
  const rels = collectRelFiles(skillDir).sort(comparePathParts);
  for (const rel of rels) {
    h.update(Buffer.from(rel, 'utf-8'));
    h.update(NUL);
    try {
      h.update(readFileSync(join(skillDir, rel.split('/').join(sep))));
    } catch {
      // OSError -> Python `pass`; the two NUL separators are still written.
    }
    h.update(NUL);
  }
  return h.digest('hex');
}

const NUL = Buffer.from([0]);

/** Relative (posix-joined) paths of every file under *dir*, recursively. */
function collectRelFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, prefix: string): void => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) walk(join(d, e.name), rel);
      else if (e.isFile()) out.push(rel);
    }
  };
  walk(dir, '');
  return out;
}

/** An object-valued manifest section, or `{}` when absent/malformed. */
function manifestSection<T>(data: unknown, key: string): T {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return {} as T;
  }
  const section = (data as Record<string, unknown>)[key];
  if (
    section === null ||
    typeof section !== 'object' ||
    Array.isArray(section)
  ) {
    return {} as T;
  }
  return section as T;
}

/**
 * Read the whole manifest document (skills + workflows). Both sections default
 * to `{}` when the file is absent, unreadable, or malformed -- provenance is
 * best-effort and never blocks a deploy.
 */
function readManifestDoc(targetSkillsDir: string): ManifestDoc {
  const manifestPath = join(targetSkillsDir, DEPLOY_MANIFEST_NAME);
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  } catch {
    return { skills: {}, workflows: {} };
  }
  return {
    skills: manifestSection<Manifest>(data, 'skills'),
    workflows: manifestSection<WorkflowManifest>(data, 'workflows'),
  };
}

/**
 * Write the manifest. Read-modify-write of the whole document, because the
 * skill-deploy phase and the workflow-install phase each own one section and
 * both write this one file. `workflows` is omitted entirely when empty so a
 * skills-only manifest keeps its historical bytes.
 */
function writeManifestDoc(targetSkillsDir: string, doc: ManifestDoc): void {
  const manifestPath = join(targetSkillsDir, DEPLOY_MANIFEST_NAME);
  mkdirSync(targetSkillsDir, { recursive: true });
  const payload: Record<string, unknown> = {
    schemaVersion: 1,
    skills: doc.skills,
  };
  if (Object.keys(doc.workflows).length > 0)
    payload['workflows'] = doc.workflows;
  const body = ensureAscii(JSON.stringify(payload, null, 2)) + '\n';
  writeFileSync(manifestPath, body, 'utf-8');
}

// ---------------------------------------------------------------------------
// Workflow templates (#459)
// ---------------------------------------------------------------------------

/** Frontmatter key: templates this skill installs into `.github/workflows/`. */
const WORKFLOW_DECL_KEY = 'install_workflows';
/** Frontmatter key: the version stamped into the deploy manifest. */
const WORKFLOW_VERSION_KEY = 'workflow_template_version';
/** Default when a skill declares templates but no explicit version. */
const WORKFLOW_DEFAULT_VERSION = '1';

/**
 * An optional `<shape>:` prefix on a declared entry, e.g.
 * `api:templates/guardian-api.yml`. Two or more leading characters are required
 * so a Windows drive letter (`C:\...`) can never be mistaken for a shape -- such
 * a path is refused by {@link resolveTemplatePath} instead.
 */
const _WORKFLOW_ENTRY_RE = /^([A-Za-z][A-Za-z0-9_-]+):(.+)$/;

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** File bytes, or null when unreadable (e.g. the path is a directory). */
function readBytesOrNull(path: string): Buffer | null {
  try {
    return readFileSync(path);
  } catch {
    return null;
  }
}

/**
 * The workflow declaration in a skill's SKILL.md frontmatter.
 *
 * Parsed here rather than on {@link SkillInfo} because these fields are
 * migrator-specific: the registry's job is discovery, and every other consumer
 * of `SkillInfo` would carry two fields it never reads.
 */
function readWorkflowDeclaration(skillMd: string): {
  entries: string[];
  version: string;
} {
  const text = readTextOrNull(skillMd);
  if (text === null) return { entries: [], version: WORKFLOW_DEFAULT_VERSION };
  const fm = SkillRegistry.parseFrontmatter(text);
  const entries = SkillRegistry.parseStrList(fm, WORKFLOW_DECL_KEY);
  const rawVersion = fm[WORKFLOW_VERSION_KEY];
  const version =
    typeof rawVersion === 'string' && rawVersion.trim()
      ? rawVersion.trim()
      : WORKFLOW_DEFAULT_VERSION;
  return { entries, version };
}

/** Split `[<shape>:]<relative-path>` into its shape filter and path. */
function parseWorkflowEntry(entry: string): [string | null, string] {
  const m = _WORKFLOW_ENTRY_RE.exec(entry.trim());
  if (m === null) return [null, entry.trim()];
  return [m[1]!.toLowerCase(), m[2]!.trim()];
}

/**
 * Resolve a declared template path inside *skillDir*, or null when it escapes.
 *
 * An overlay is third-party content, so a declared path is untrusted input: an
 * absolute path or a `..` climb would let an overlay copy an arbitrary file
 * from the machine running `migrate` into the consumer's CI directory.
 */
function resolveTemplatePath(skillDir: string, rel: string): string | null {
  if (!rel || isAbsolute(rel) || /^[A-Za-z]:/.test(rel)) return null;
  const base = resolve(skillDir);
  const full = resolve(base, rel);
  if (full !== base && !full.startsWith(base + sep)) return null;
  return full;
}

/**
 * Is the deployed copy of a skill the consumer's rather than the overlay's?
 *
 * True when it differs from the overlay AND from the hash recorded at deploy
 * time -- or carries no recorded provenance at all, since unknown provenance is
 * not permission to overwrite.
 *
 * This is the single definition of `local_edit`. The skill-deploy phase refuses
 * to overwrite on it (#334) and the workflow-install phase withholds on it
 * (#667); sharing one predicate is what keeps the two phases from reporting
 * contradictory things about the same skill in the same run.
 */
function isLocallyEdited(
  overlayHash: string,
  targetHash: string,
  recordedHash: string | undefined,
): boolean {
  if (targetHash === overlayHash) return false;
  return recordedHash === undefined || targetHash !== recordedHash;
}

// ---------------------------------------------------------------------------
// Constants / probes
// ---------------------------------------------------------------------------

/**
 * Frameworks a user can pass to `canary migrate --framework <name>`. Surfaced in
 * the fail-loud message when auto-detection is uncertain (issue #295).
 */
const KNOWN_FRAMEWORKS: readonly string[] = [
  'playwright',
  'vitest',
  'pytest',
  'k6',
  'wdio',
  'locust',
];

// Layer names that mark a skills/docs *overlay* rather than a test suite (#319 C).
const _DOC_SKILL_LAYER_NAMES = new Set([
  'skills',
  'docs',
  'guides',
  'agents',
  'overlays',
  'commands',
  'prompts',
]);

const _TEST_GLOBS = [
  'tests/**/*.py',
  'test/**/*.py',
  'tests/**/*.spec.ts',
  'tests/**/*.test.ts',
  'tests/**/*.spec.js',
  'tests/**/*.test.js',
  'src/**/*.spec.ts',
  'src/**/*.test.ts',
];

// ---------------------------------------------------------------------------
// Workspace ("monorepo") awareness -- #504 (3)
//
// Deliberately narrow: this exists ONLY to answer "does a suite for this
// framework already live in a workspace package?" so the scaffold never
// proposes a duplicate beside one it can see. Making *detection* itself
// workspace-aware (per-package findings, a `monorepo` detection result) is a
// separate, larger change -- #504 (1) -- and is NOT attempted here.
// ---------------------------------------------------------------------------

/** A test suite already present in a workspace package. */
export interface ExistingSuite {
  /** Package directory, relative to the repo root, POSIX-separated. */
  dir: string;
  /** The config filename that identified it (e.g. `playwright.config.ts`). */
  config: string;
  /** Test files found under the package. Zero is legal (config-only suite). */
  test_count: number;
}

/**
 * Suites for *framework* already present in this repo's workspace packages.
 *
 * The repo root is excluded on purpose: a root config is already reported via
 * `skipped_configs`, and listing it here would double-count it and suppress a
 * scaffold that the skip logic handles more precisely.
 */
function findWorkspaceSuites(root: string, framework: string): ExistingSuite[] {
  const globs = workspaceGlobs(root);
  if (globs.length === 0) return [];

  const configNames = CONFIG_PROBES.filter(([, fw]) => fw === framework).map(
    ([filename]) => filename,
  );
  if (configNames.length === 0) return [];

  const dirs = new Set<string>();
  for (const glob of globs) for (const d of globDirs(root, glob)) dirs.add(d);

  const suites: ExistingSuite[] = [];
  for (const dir of [...dirs].sort(comparePathParts)) {
    const config = configNames.find((name) => isFile(join(dir, name)));
    if (config === undefined) continue;
    const tests = new Set<string>();
    for (const pattern of _TEST_GLOBS) {
      for (const f of globFiles(dir, pattern)) tests.add(f);
    }
    suites.push({
      dir: relative(root, dir).split(sep).join('/'),
      config,
      test_count: tests.size,
    });
  }
  return suites;
}

/**
 * The shape implied by an explicit `--framework` override (#504 (2)).
 *
 * Reuses the probe table so the override resolves exactly the shape a matching
 * config file would have, including the playwright api-vs-UI refinement.
 * Returns null for a framework no probe knows, so the caller keeps whatever
 * shape detection produced rather than overwriting it with a guess.
 */
function shapeForFrameworkOverride(
  framework: string,
  root: string,
): string | null {
  for (const [, candidateFramework, shape] of CONFIG_PROBES) {
    if (candidateFramework !== framework) continue;
    if (candidateFramework === 'playwright' && shape === 'e2e_ui') {
      return inferPlaywrightTestType(root);
    }
    return shape;
  }
  return null;
}

/**
 * Return a human reason when *config* describes a skills/docs overlay (not a
 * migratable test suite), else null. Conservative: fires only when there are no
 * test `entryPoints` AND every declared layer is a docs/skills layer.
 */
function skillsDocsOverlayReason(
  config: Record<string, unknown>,
): string | null {
  if (pyTruthy(config['entryPoints'])) return null;
  const layersRaw = config['layers'];
  // Python does `config.get("layers") or []` then `for layer in layers`. If
  // `layers` is a truthy non-list (e.g. a dict), Python iterates its keys --
  // none pass the isinstance(dict) check, so `names` ends up empty and the
  // result is unchanged from []. Casting a non-array to `unknown[]` and using
  // for-of would instead THROW (not iterable), crashing detect()/migrate() on a
  // malformed config the oracle tolerates. Only a real array yields entries.
  const layers = Array.isArray(layersRaw) ? layersRaw : [];
  const names = new Set<string>();
  for (const layer of layers) {
    if (layer !== null && typeof layer === 'object' && !Array.isArray(layer)) {
      const raw = (layer as Record<string, unknown>)['name'];
      const name = (pyTruthy(raw) ? String(raw) : '').toLowerCase();
      names.add(name);
    }
  }
  names.delete('');
  const subsetOfDocSkill = [...names].every((n) =>
    _DOC_SKILL_LAYER_NAMES.has(n),
  );
  if (names.size === 0 || !subsetOfDocSkill) return null;
  const sortedNames = [...names].sort().join(', ');
  return (
    'harness.config.json and .harness/ are present, but this looks like a ' +
    'skills/docs overlay (no test entryPoints; layers are only ' +
    `${sortedNames}), not a test suite. \`canary migrate\` ` +
    'scaffolds a test suite and has nothing to migrate here.'
  );
}

/**
 * The deduplicated, sorted union of the root shape and every package's shape.
 *
 * `unknown` is excluded: it is the absence of a shape, and carrying it into a
 * union that drives deployment would let "we could not tell" masquerade as a
 * detected shape. An empty array therefore means nothing was detected (#504).
 */
function unionShapes(rootShape: string, ws: WorkspaceInfo | null): string[] {
  const shapes = new Set<string>();
  if (rootShape !== 'unknown' && rootShape !== '') shapes.add(rootShape);
  for (const f of ws?.findings ?? []) {
    if (f.shape !== 'unknown' && f.shape !== '') shapes.add(f.shape);
  }
  return [...shapes].sort();
}

// ---------------------------------------------------------------------------
// Data model
// ---------------------------------------------------------------------------

export interface MigrationContextInit {
  project_root: string;
  is_harness_project: boolean;
  harness_config?: Record<string, unknown>;
  detected_framework?: string | null;
  detected_shape?: string;
  detection_source?: string;
  detection_confidence?: string;
  config_warnings?: string[];
  not_test_project_reason?: string | null;
  workspace?: WorkspaceInfo | null;
  shapes?: string[];
}

export class MigrationContext {
  project_root: string;
  is_harness_project: boolean;
  harness_config: Record<string, unknown>;
  detected_framework: string | null;
  detected_shape: string;
  detection_source: string;
  /** "config" | "content" | "language" | "none" */
  detection_confidence: string;
  config_warnings: string[];
  not_test_project_reason: string | null;
  /**
   * Declared workspace topology, or null for a single-package repo.
   *
   * Null is the back-compatibility guarantee -- a repo that declares no
   * workspace never enters the plural path (#504 part 1).
   */
  workspace: WorkspaceInfo | null;
  /**
   * Every shape detected anywhere, deduplicated and sorted.
   *
   * Populated but not yet read: plural deployment is Milestone 2. Landing the
   * data first keeps this change reviewable as "detection got richer, nothing
   * else moved" (#504 part 1).
   */
  shapes: string[];

  constructor(init: MigrationContextInit) {
    this.project_root = init.project_root;
    this.is_harness_project = init.is_harness_project;
    this.harness_config = init.harness_config ?? {};
    this.detected_framework = init.detected_framework ?? null;
    this.detected_shape = init.detected_shape ?? 'unknown';
    this.detection_source = init.detection_source ?? 'none';
    this.detection_confidence = init.detection_confidence ?? 'none';
    this.config_warnings = init.config_warnings ?? [];
    this.not_test_project_reason = init.not_test_project_reason ?? null;
    this.workspace = init.workspace ?? null;
    this.shapes = init.shapes ?? [];
  }
}

export class SkillDeployResult {
  skill_name: string;
  /** "copied" | "updated" | "skipped" | "dry_run" */
  status: string;
  note: string;

  constructor(skill_name: string, status: string, note = '') {
    this.skill_name = skill_name;
    this.status = status;
    this.note = note;
  }
}

/**
 * The outcome of installing one declared workflow template (#459).
 *
 * `status` is one of:
 *   - `installed` -- the target had no such workflow; it was written
 *   - `skipped`   -- byte-identical to the template; nothing to do
 *   - `outdated`  -- differs, but is unmodified since canary installed it, so
 *                    the overlay simply moved on (a template fix is waiting)
 *   - `conflict`  -- differs and was edited locally / has unknown provenance
 *   - `updated`   -- differed and `--force` replaced it
 *   - `dry_run`   -- what an `--apply` run would have done
 *   - `missing`   -- the overlay declares a template it does not ship
 *   - `invalid`   -- the declared path escapes the skill directory (refused)
 *   - `withheld`  -- the declaring skill was skipped as locally edited, so its
 *                    templates were not installed either (#667)
 *
 * `outdated`, `conflict`, and `withheld` are REPORTS. None ever writes.
 */
export class WorkflowInstallResult {
  /** File name under `.github/workflows/`. */
  workflow: string;
  skill_name: string;
  status: string;
  detail: string;

  constructor(
    workflow: string,
    skill_name: string,
    status: string,
    detail = '',
  ) {
    this.workflow = workflow;
    this.skill_name = skill_name;
    this.status = status;
    this.detail = detail;
  }

  to_dict(): Record<string, unknown> {
    return {
      workflow: this.workflow,
      skill_name: this.skill_name,
      status: this.status,
      detail: this.detail,
    };
  }
}

export class SkillFreshnessResult {
  skill_name: string;
  dir_name: string;
  /** "current" | "stale" | "missing" | "local_edit" */
  status: string;
  detail: string;

  constructor(
    skill_name: string,
    dir_name: string,
    status: string,
    detail = '',
  ) {
    this.skill_name = skill_name;
    this.dir_name = dir_name;
    this.status = status;
    this.detail = detail;
  }
}

export class FreshnessReport {
  shape: string;
  overlay_path: string | null;
  results: SkillFreshnessResult[];
  /**
   * What a workflow install WOULD do (#459) -- informational only.
   *
   * Deliberately excluded from `has_drift` / `has_local_edits` / `exit_code`:
   * the freshness gate speaks for overlay-owned skills, and a consumer's
   * `.github/workflows/` is not overlay-owned. Failing CI because someone
   * hand-tuned their own workflow, or has not adopted one at all, would be
   * nagging about something canary has no claim over.
   */
  workflows: WorkflowInstallResult[];
  /**
   * Every shape the gate actually resolved -- the set `migrate` deploys for
   * (#504 part 1). The scalar `shape` above stays, because the `--check --json`
   * payload is documented and consumers read it; `shapes` is additive.
   *
   * A mixed monorepo collapses `shape` to `unknown` while `shapes` still names
   * both, so the two disagree by design rather than by accident.
   */
  shapes: string[];

  constructor(
    shape: string,
    overlay_path: string | null = null,
    results: SkillFreshnessResult[] = [],
    workflows: WorkflowInstallResult[] = [],
    shapes: string[] = [],
  ) {
    this.shape = shape;
    this.overlay_path = overlay_path;
    this.results = results;
    this.workflows = workflows;
    this.shapes = shapes;
  }

  get stale(): SkillFreshnessResult[] {
    return this.results.filter(
      (r) => r.status === 'stale' || r.status === 'missing',
    );
  }

  get local_edits(): SkillFreshnessResult[] {
    return this.results.filter((r) => r.status === 'local_edit');
  }

  get has_drift(): boolean {
    return this.stale.length > 0;
  }

  get has_local_edits(): boolean {
    return this.local_edits.length > 0;
  }

  get in_sync(): boolean {
    return !this.has_drift && !this.has_local_edits;
  }

  /**
   * The freshness gate as a {@link GateResult}: denominator = skills
   * verified, findings = drift + local edits. Feeds the shared abstention
   * helper (#508) so "verified zero skills" can never render as a pass.
   */
  private gateResult(): GateResult<SkillFreshnessResult> {
    return {
      checked: this.results.length,
      findings: [...this.stale, ...this.local_edits],
    };
  }

  /**
   * A gate that verified zero skills has abstained, not passed (#503): the
   * shape matched nothing, so nothing was checked and "in sync" would be a
   * silent false pass -- the #456 class. Reported as its own exit code and
   * flagged in every output surface. Delegates to the shared helper (#508).
   */
  get abstained(): boolean {
    return gateOutcome(this.gateResult(), 'gate').abstained;
  }

  /**
   * 0 in sync, 1 drift, 2 local edits (safety refusal wins), 3 abstained.
   * The abstention path comes from the shared helper; the 1/2 mapping is
   * this surface's own contract (local edits outrank drift).
   */
  exit_code(): number {
    if (this.abstained) return EXIT_ABSTAINED;
    if (this.has_local_edits) return 2;
    if (this.has_drift) return 1;
    return 0;
  }

  to_dict(): Record<string, unknown> {
    return {
      shape: this.shape,
      shapes: this.shapes,
      overlay_path: this.overlay_path,
      in_sync: this.in_sync,
      has_drift: this.has_drift,
      has_local_edits: this.has_local_edits,
      checked: this.results.length,
      abstained: this.abstained,
      exit_code: this.exit_code(),
      skills: this.results.map((r) => ({
        skill_name: r.skill_name,
        dir_name: r.dir_name,
        status: r.status,
        detail: r.detail,
      })),
      workflows: this.workflows.map((r) => r.to_dict()),
    };
  }

  to_markdown(): string {
    const lines: string[] = [
      '# Overlay Freshness',
      '',
      `**Shape:** ${this.shape}`,
      '',
    ];
    // A workspace repo resolves several shapes at once; naming only the scalar
    // would tell a reader `unknown` while the gate checked two shapes (#504).
    if (this.shapes.length > 1) {
      lines.push(
        `**Shapes checked:** ${this.shapes.map((s) => `\`${s}\``).join(', ')}`,
        '',
      );
    }
    if (this.results.length === 0) {
      lines.push("_No overlay skills match this project's shape._", '');
      lines.push(
        `${WARN} **Abstained** ${EMDASH} the gate verified zero skills, so this is not a pass.`,
        '',
      );
      if (this.shapes.length === 0) {
        lines.push(
          'The shape could not be detected. Set `canary_shape` in',
          '`.canary/company.json` or pass `--framework <name>`.',
          '',
        );
      } else {
        const covered = this.shapes.map((s) => `\`${s}\``).join(', ');
        lines.push(
          `The overlay ships no skills with \`deploy_to\` covering ${covered}.`,
          "Check the overlay's `deploy_to` lists or the resolved `canary_shape`.",
          '',
        );
      }
      lines.push(...workflowMarkdown(this.workflows, false));
      return lines.join('\n');
    }

    if (this.in_sync) {
      lines.push(
        `${CHECK} In sync ${EMDASH} every deployed overlay skill is current.`,
        '',
      );
    }

    const stale = this.results.filter((r) => r.status === 'stale');
    const missing = this.results.filter((r) => r.status === 'missing');
    const edits = this.local_edits;

    if (missing.length > 0) {
      lines.push('## Missing (overlay ships, target does not carry)', '');
      lines.push(...missing.map((r) => `- \`${r.skill_name}\``), '');
    }
    if (stale.length > 0) {
      lines.push('## Stale (overlay has a newer version)', '');
      lines.push(
        ...stale.map((r) => `- \`${r.skill_name}\` ${EMDASH} ${r.detail}`),
        '',
      );
    }
    if (edits.length > 0) {
      lines.push(
        `## ${WARN} Local edits (refused ${EMDASH} one-way ownership)`,
        '',
      );
      lines.push(
        ...edits.map((r) => `- \`${r.skill_name}\` ${EMDASH} ${r.detail}`),
        '',
      );
    }

    if (this.has_drift && !this.has_local_edits) {
      lines.push(
        'Run `canary migrate --from <overlay> --apply` to refresh.',
        '',
      );
    } else if (this.has_local_edits) {
      lines.push(
        'Deployed skills are owned by the overlay. Reconcile the local ' +
          'edits above (revert them, or upstream them into the overlay) ' +
          'before the freshness gate can pass.',
        '',
      );
    }
    lines.push(...workflowMarkdown(this.workflows, false));
    return lines.join('\n');
  }
}

/**
 * Render the workflow-install section shared by both reports.
 *
 * The closing note is not decoration: it is the only place a consumer is told
 * that a reported difference will never be applied behind their back, and how
 * to opt in when they do want the overlay's version.
 */
function workflowMarkdown(
  results: WorkflowInstallResult[],
  dryRun: boolean,
): string[] {
  if (results.length === 0) return [];
  const heading = dryRun
    ? '## Workflows (would install into `.github/workflows/`)'
    : '## Workflows (`.github/workflows/`)';
  const lines: string[] = [heading, ''];
  // Every result carries a detail; the status alone would not tell a consumer
  // which file was touched or what to do next.
  for (const r of results) {
    lines.push(`- \`${r.workflow}\` ${EMDASH} ${r.detail}`);
  }
  lines.push('');
  if (results.some((r) => r.status === 'conflict' || r.status === 'outdated')) {
    lines.push(
      `${WARN} Your CI is yours: canary never overwrites a workflow that ` +
        'differs from the template. Re-run with `--force` to take the ' +
        "overlay's version.",
      '',
    );
  }
  // #667: a withheld install is the one line that says why a template the
  // overlay declares is absent from the target -- without it, the section
  // simply omits the file and reads as though it were never declared.
  if (results.some((r) => r.status === 'withheld')) {
    lines.push(
      `${WARN} Templates declared by a skill with local edits were withheld: ` +
        'the skill itself was skipped, so its workflows were not installed ' +
        'either. Revert the local edits, or re-run with `--force`.',
      '',
    );
  }
  return lines;
}

export interface MigrationReportInit {
  framework: string;
  shape: string;
  dry_run: boolean;
  detection_source?: string;
  detection_confidence?: string;
  created_files?: string[];
  created_dirs?: string[];
  skipped_configs?: string[];
  preserved_files?: string[];
  would_create?: string[];
  existing_suites?: ExistingSuite[];
  manual_followups?: string[];
  deployed_skills?: SkillDeployResult[];
  installed_workflows?: WorkflowInstallResult[];
  config_warnings?: string[];
  workspace?: WorkspaceInfo | null;
  shapes?: string[];
}

export class MigrationReport {
  framework: string;
  shape: string;
  dry_run: boolean;
  detection_source: string;
  detection_confidence: string;
  created_files: string[];
  created_dirs: string[];
  skipped_configs: string[];
  preserved_files: string[];
  would_create: string[];
  /** Suites already present in workspace packages (#504 (3)). */
  existing_suites: ExistingSuite[];
  manual_followups: string[];
  deployed_skills: SkillDeployResult[];
  installed_workflows: WorkflowInstallResult[];
  config_warnings: string[];
  /** Declared workspace topology, or null for a single-package repo (#504). */
  workspace: WorkspaceInfo | null;
  /** Every detected shape, deduplicated and sorted; unread until Milestone 2. */
  shapes: string[];

  constructor(init: MigrationReportInit) {
    this.framework = init.framework;
    this.shape = init.shape;
    this.dry_run = init.dry_run;
    this.detection_source = init.detection_source ?? '';
    this.detection_confidence = init.detection_confidence ?? '';
    this.created_files = init.created_files ?? [];
    this.created_dirs = init.created_dirs ?? [];
    this.skipped_configs = init.skipped_configs ?? [];
    this.preserved_files = init.preserved_files ?? [];
    this.would_create = init.would_create ?? [];
    this.existing_suites = init.existing_suites ?? [];
    this.manual_followups = init.manual_followups ?? [];
    this.deployed_skills = init.deployed_skills ?? [];
    this.installed_workflows = init.installed_workflows ?? [];
    this.config_warnings = init.config_warnings ?? [];
    this.workspace = init.workspace ?? null;
    this.shapes = init.shapes ?? [];
  }

  /**
   * What the workspace walk actually covered, stated with its denominator.
   *
   * Emitted only when a workspace was declared, so single-package output is
   * untouched. Saying "0 packages carry a test config" is a different claim
   * from saying nothing at all, which reads as "there was nothing to find"
   * (#504 part 1, criteria 4 and 5).
   */
  private workspaceNotes(): string[] {
    const ws = this.workspace;
    if (ws === null) return [];
    const notes: string[] = [];
    if (ws.globs.length > 0 && ws.scanned === 0) {
      const g = ws.globs.length === 1 ? '1 glob' : `${ws.globs.length} globs`;
      notes.push(`Declared ${g}, matched 0 packages.`);
    } else if (ws.scanned > 0 && ws.findings.length === 0) {
      const p = ws.scanned === 1 ? '1 package' : `${ws.scanned} packages`;
      notes.push(`${p} scanned, none carries a recognizable test config.`);
    }
    for (const dir of ws.unreadable) {
      notes.push(`\`${dir}/\` could not be read and was not scanned.`);
    }
    return notes;
  }

  /**
   * The dry run's denominator (#504): config files that would be created,
   * skills that would deploy, workflows that would install. Zero means the
   * dry run has nothing to apply -- an advisory abstention, not a
   * completed migration.
   */
  get would_migrate_count(): number {
    return (
      this.would_create.length +
      this.deployed_skills.filter((r) => r.status === 'dry_run').length +
      this.installed_workflows.filter((r) => r.status === 'dry_run').length
    );
  }

  to_markdown(): string {
    const lines: string[] = ['# Canary Migration Report', ''];
    if (this.dry_run) {
      lines.push(
        '> **Dry run** ' +
          EMDASH +
          ' no files were written. Re-run with `--apply` to migrate.',
        '',
      );
    }

    if (this.config_warnings.length > 0) {
      lines.push(`## ${WARN} Config Warnings`, '');
      for (const w of this.config_warnings) lines.push(`- ${w}`);
      lines.push('');
    }

    lines.push(`**Framework:** ${this.framework}`, `**Shape:** ${this.shape}`);

    if (
      pyTruthy(this.detection_source) &&
      this.detection_source !== 'none' &&
      this.detection_source !== ''
    ) {
      const confidenceLabel =
        (
          {
            config: `high ${EMDASH} dedicated config file`,
            content: `medium ${EMDASH} file content / dependency scan`,
            language: `low ${EMDASH} harness.config.json language fallback`,
            override: `high ${EMDASH} explicit \`--framework\` flag`,
          } as Record<string, string>
        )[this.detection_confidence] ?? this.detection_confidence;
      lines.push(
        `**Detected from:** \`${this.detection_source}\``,
        `**Confidence:** ${confidenceLabel}`,
      );
    }

    lines.push('');

    const wsNotes = this.workspaceNotes();
    if (wsNotes.length > 0) {
      lines.push('## Workspace', '');
      for (const n of wsNotes) lines.push(`- ${n}`);
      lines.push('');
    }

    // #504 (3): name what was found before saying what would happen, so the
    // empty "Would Create" below reads as a decision rather than a shrug.
    if (this.existing_suites.length > 0) {
      lines.push('## Existing Suites Found', '');
      for (const s of this.existing_suites) {
        const tests =
          s.test_count === 1 ? '1 test file' : `${s.test_count} test files`;
        lines.push(`- \`${s.dir}/\` ${EMDASH} \`${s.config}\` (${tests})`);
      }
      lines.push('');
    }

    if (this.dry_run) {
      if (this.preserved_files.length > 0) {
        lines.push('## Existing Tests (will be preserved)', '');
        for (const f of this.preserved_files) lines.push(`- \`${f}\``);
        lines.push('');
      }

      if (this.would_create.length > 0) {
        lines.push('## Would Create', '');
        for (const f of this.would_create) lines.push(`- \`${f}\``);
        lines.push('');
      } else if (this.existing_suites.length > 0) {
        const names = this.existing_suites.map((s) => `\`${s.dir}/\``);
        lines.push(
          '## Would Create',
          '',
          `_Nothing ${EMDASH} ${names.join(', ')} already ` +
            `carries a ${this.framework} suite. To scaffold a second one, ` +
            're-run `canary migrate` from inside that package._',
          '',
        );
      } else {
        lines.push(
          '## Would Create',
          '',
          '_Nothing new ' +
            EMDASH +
            ' project already has all Canary config files._',
          '',
        );
      }

      if (this.skipped_configs.length > 0) {
        lines.push('## Already Present (will not be touched)', '');
        for (const f of this.skipped_configs) lines.push(`- \`${f}\``);
        lines.push('');
      }
    } else {
      if (this.created_files.length > 0) {
        lines.push('## Created Files', '');
        for (const f of this.created_files) lines.push(`- \`${f}\``);
        lines.push('');
      }

      if (this.created_dirs.length > 0) {
        lines.push('## Created Directories', '');
        for (const d of this.created_dirs) lines.push(`- \`${d}/\``);
        lines.push('');
      }

      if (this.skipped_configs.length > 0) {
        lines.push('## Skipped (already exist)', '');
        for (const f of this.skipped_configs) {
          lines.push(`- \`${f}\` ${EMDASH} preserved as-is`);
        }
        lines.push('');
      }

      if (this.preserved_files.length > 0) {
        lines.push('## Existing Tests Preserved', '');
        for (const f of this.preserved_files) lines.push(`- \`${f}\``);
        lines.push('');
      }
    }

    if (this.deployed_skills.length > 0) {
      const copied = this.deployed_skills.filter(
        (r) =>
          r.status === 'copied' ||
          r.status === 'dry_run' ||
          r.status === 'updated',
      );
      const skipped = this.deployed_skills.filter(
        (r) => r.status === 'skipped',
      );
      const section = this.dry_run
        ? '## Skills (would deploy)'
        : '## Skills Deployed';
      lines.push(section, '');
      for (const r of copied) {
        const prefix = r.status === 'dry_run' ? '(dry run) ' : '';
        const verb = r.status === 'updated' ? 'refreshed in' : 'copied to';
        lines.push(
          `- \`${r.skill_name}\` ${EMDASH} ${prefix}${verb} \`.canary/skills/\``,
        );
      }
      for (const r of skipped) {
        lines.push(`- \`${r.skill_name}\` ${EMDASH} skipped (${r.note})`);
      }
      lines.push('');
    }

    lines.push(...workflowMarkdown(this.installed_workflows, this.dry_run));

    if (this.manual_followups.length > 0) {
      lines.push('## Manual Follow-ups Required', '');
      for (const item of this.manual_followups) lines.push(`- ${item}`);
      lines.push('');
    } else if (this.dry_run) {
      // #504 abstention half: a dry run never completed anything. Zero
      // pending work is an advisory abstention (D3) -- gateOutcome is the
      // only summary-line path AND the only decision point (no local
      // n === 0 arithmetic), so the refusal is structural.
      const n = this.would_migrate_count;
      const outcome = gateOutcome({ checked: n, findings: [] }, 'advisory', {
        noun: 'item(s)',
      });
      lines.push('## Status', '');
      if (outcome.abstained) {
        // Zero is zero either way, but *why* differs: an already-complete
        // project and a repo whose suite lives in a package are different
        // situations, and the generic sentence misdescribes the second.
        const why =
          this.existing_suites.length > 0
            ? 'the suite this migration would scaffold already exists in ' +
              `${this.existing_suites.map((s) => `\`${s.dir}/\``).join(', ')}. ` +
              'Re-run `canary migrate` from inside that package to migrate it.'
            : 'the project already carries everything this migration would ' +
              'produce. If you expected changes, check `--from <overlay>` and ' +
              'the detected framework/shape above.';
        lines.push(
          outcome.summaryLine,
          '',
          `This dry run would migrate zero item(s) ${EMDASH} ${why}`,
          '',
        );
      } else {
        lines.push(
          `Dry run ${EMDASH} would migrate ${n} item(s). ` +
            'Re-run with `--apply` to write them.',
          '',
        );
      }
    } else {
      lines.push(
        '## Status',
        '',
        'Migration complete. Run `canary recommend "<test description>"` to verify framework detection.',
        '',
      );
    }

    return lines.join('\n');
  }
}

// ---------------------------------------------------------------------------
// Migrator
// ---------------------------------------------------------------------------

export interface MigrateOptions {
  dryRun?: boolean;
  framework?: string | null;
  overlayPath?: string | null;
  /**
   * Overwrite a `.github/workflows/` file that differs from the overlay's
   * template (#459). Off by default -- the differing case is a report.
   */
  force?: boolean;
}

export interface CheckFreshnessOptions {
  overlayPath: string | null;
  framework?: string | null;
}

/** Detects harness test-suite projects and migrates them to Canary's layout. */
export class HarnessMigrator {
  private readonly home: string;

  /** `home` is a TS-only test seam (Python patches `Path.home()`). */
  constructor(home?: string) {
    this.home = home ?? homedir();
  }

  detect(projectRoot: string): MigrationContext {
    const hasConfig = existsSync(join(projectRoot, 'harness.config.json'));
    const hasHarnessDir = isDir(join(projectRoot, '.harness'));
    const isHarness = hasConfig && hasHarnessDir;

    if (!isHarness) {
      return new MigrationContext({
        project_root: projectRoot,
        is_harness_project: false,
      });
    }

    const configWarnings: string[] = [];

    const [rawConfig, warning] = readJsonWithWarning(
      join(projectRoot, 'harness.config.json'),
    );
    if (pyTruthy(warning)) configWarnings.push(warning as string);
    let harnessConfig: Record<string, unknown> = pyTruthy(rawConfig)
      ? (rawConfig as Record<string, unknown>)
      : {};

    // Merge canary_shape from .canary/company.json so _detectFramework can honor
    // an explicit shape override. A malformed company.json warns but never blocks
    // detection.
    const canaryCompany = join(projectRoot, '.canary', 'company.json');
    const [overlay, warning2] = readJsonWithWarning(canaryCompany);
    if (pyTruthy(warning2)) configWarnings.push(warning2 as string);
    if (
      pyTruthy(overlay) &&
      Object.prototype.hasOwnProperty.call(overlay, 'canary_shape')
    ) {
      harnessConfig = {
        ...harnessConfig,
        canary_shape: (overlay as Record<string, unknown>)['canary_shape'],
      };
    }

    // #319 C: refuse a skills/docs overlay with a distinct reason.
    const overlayReason = skillsDocsOverlayReason(harnessConfig);
    if (overlayReason) {
      return new MigrationContext({
        project_root: projectRoot,
        is_harness_project: false,
        harness_config: harnessConfig,
        config_warnings: configWarnings,
        not_test_project_reason: overlayReason,
      });
    }

    // Detected once and threaded: `detectFramework` resolves the scalar from it
    // and the context carries it, so the package walk happens a single time.
    const workspace = detectWorkspace(
      projectRoot,
      harnessConfig,
      configWarnings,
    );
    const [framework, shape, source, confidence] = this.detectFramework(
      projectRoot,
      harnessConfig,
      workspace,
    );

    return new MigrationContext({
      project_root: projectRoot,
      is_harness_project: true,
      harness_config: harnessConfig,
      detected_framework: framework,
      detected_shape: shape,
      detection_source: source,
      detection_confidence: confidence,
      config_warnings: configWarnings,
      workspace,
      shapes: unionShapes(shape, workspace),
    });
  }

  migrate(projectRoot: string, options: MigrateOptions = {}): MigrationReport {
    const dryRun = options.dryRun ?? true;
    const framework = options.framework ?? null;
    const overlayPath = options.overlayPath ?? null;
    const force = options.force ?? false;

    const ctx = this.detect(projectRoot);
    if (!ctx.is_harness_project) {
      if (ctx.not_test_project_reason)
        throw new Error(ctx.not_test_project_reason);
      throw new Error(
        `No harness project detected at ${projectRoot}. ` +
          'Expected harness.config.json and .harness/ directory.',
      );
    }

    const effectiveFramework = pyTruthy(framework)
      ? (framework as string)
      : ctx.detected_framework;
    const source = pyTruthy(framework) ? 'CLI override' : ctx.detection_source;
    // #504 (2): an override is high-confidence *user intent*, not a config-file
    // find. Reporting it as 'config' rendered "high -- dedicated config file",
    // asserting evidence no probe ever gathered.
    const confidence = pyTruthy(framework)
      ? 'override'
      : ctx.detection_confidence;

    // #504 (2): the override must resolve the shape too. Without this, shape
    // stays 'unknown' and every shape-keyed behavior downstream (overlay-skill
    // matching, `<shape>:`-prefixed workflow templates) silently no-ops, so the
    // override only half-works. An explicit `canary_shape` is a stronger
    // statement of intent than the framework name, so it still wins.
    const explicitShape = String(ctx.harness_config['canary_shape'] ?? '')
      .trim()
      .toLowerCase();
    const overrideShape =
      pyTruthy(framework) && explicitShape === ''
        ? shapeForFrameworkOverride(framework as string, projectRoot)
        : null;
    const shape = overrideShape ?? ctx.detected_shape;
    // The set that actually drives deployment. Re-derived from the *effective*
    // scalar rather than reusing `ctx.shapes`, so a `--framework` override
    // contributes its resolved shape to the union too (#504 parts 1-2).
    const deployShapes = unionShapes(shape, ctx.workspace);
    const followups: string[] = [];

    if (effectiveFramework === null) {
      followups.push(
        uncertainDetectionMessage('test framework', {
          reason:
            'no config file, dependency, or language marker matched a known framework',
          candidates: KNOWN_FRAMEWORKS,
          overrideHint: '`canary migrate --framework <name>`',
        }),
      );
      // Issue #295 point 3: a detection miss must not block skill deployment --
      // nor, for the same reason, the workflow install (#459). The guardian
      // workflow is exactly what an unrecognised repo most needs.
      const deployed = this.deploySkills(
        deployShapes,
        overlayPath,
        projectRoot,
        dryRun,
      );
      return new MigrationReport({
        framework: 'unknown',
        shape,
        dry_run: dryRun,
        detection_source: source,
        detection_confidence: confidence,
        manual_followups: followups,
        config_warnings: ctx.config_warnings,
        workspace: ctx.workspace,
        shapes: deployShapes,
        deployed_skills: deployed,
        installed_workflows: this.installWorkflows(
          deployShapes,
          overlayPath,
          projectRoot,
          dryRun,
          force,
        ),
      });
    }

    // A framework canary knows but cannot scaffold gets no config boilerplate.
    // Surface that loudly (which also suppresses the "Migration complete" status).
    const reg = new FrameworkRegistry();
    if (
      reg.findByName(effectiveFramework) !== null &&
      !scaffoldableFrameworks().has(effectiveFramework)
    ) {
      const cmd =
        reg.executionInfo(effectiveFramework)?.execution_command ?? null;
      const run = pyTruthy(cmd) ? ` Run its tests via \`${cmd}\`.` : '';
      followups.push(
        `No scaffold template for '${effectiveFramework}' yet ${EMDASH} the ` +
          'layout and skills were migrated, but test config was not ' +
          `scaffolded; set it up manually.${run}`,
      );
    }

    const preserved = this.findExistingTests(projectRoot);
    // #504 (3): a workspace repo that already has a suite for this framework
    // must not be offered a second one at the root.
    const existingSuites = findWorkspaceSuites(projectRoot, effectiveFramework);
    const scaffolder = new Scaffolder();
    const deployed = this.deploySkills(
      deployShapes,
      overlayPath,
      projectRoot,
      dryRun,
    );
    // Post-copy install phase: the template bytes already landed under
    // .canary/skills/ with the skill; this puts them where Actions looks.
    const installedWorkflows = this.installWorkflows(
      deployShapes,
      overlayPath,
      projectRoot,
      dryRun,
      force,
    );

    if (dryRun) {
      const tmpl = TEMPLATES[effectiveFramework];
      const files = tmpl?.files ?? {};
      const dirs = tmpl?.dirs ?? [];
      // A suite already exists in a package: propose nothing rather than a
      // duplicate. The suites are named in the report so the zero is legible.
      const wouldCreate =
        existingSuites.length > 0
          ? []
          : [
              ...Object.keys(files).filter(
                (f) => !existsSync(join(projectRoot, f)),
              ),
              ...dirs.filter((d) => !existsSync(join(projectRoot, d))),
            ];
      const alreadyPresent = Object.keys(files).filter((f) =>
        existsSync(join(projectRoot, f)),
      );
      return new MigrationReport({
        framework: effectiveFramework,
        shape,
        dry_run: true,
        detection_source: source,
        detection_confidence: confidence,
        would_create: wouldCreate,
        skipped_configs: alreadyPresent,
        preserved_files: preserved,
        existing_suites: existingSuites,
        manual_followups: followups,
        deployed_skills: deployed,
        installed_workflows: installedWorkflows,
        config_warnings: ctx.config_warnings,
        workspace: ctx.workspace,
        shapes: deployShapes,
      });
    }

    // Same guard on the apply path: what the dry run refuses to propose, an
    // `--apply` run must refuse to write. Skills and workflows still deploy --
    // only the duplicate test-config scaffold is withheld.
    const result =
      existingSuites.length > 0
        ? { created_files: [], created_dirs: [], skipped_files: [] }
        : scaffolder.scaffold(effectiveFramework, String(projectRoot));

    return new MigrationReport({
      framework: effectiveFramework,
      shape,
      dry_run: false,
      detection_source: source,
      detection_confidence: confidence,
      existing_suites: existingSuites,
      created_files: result['created_files'] as string[],
      created_dirs: result['created_dirs'] as string[],
      skipped_configs: result['skipped_files'] as string[],
      preserved_files: preserved,
      manual_followups: followups,
      deployed_skills: deployed,
      installed_workflows: installedWorkflows,
      config_warnings: ctx.config_warnings,
      workspace: ctx.workspace,
      shapes: deployShapes,
    });
  }

  // -- private helpers --------------------------------------------------------

  /**
   * Return `[[SkillInfo, skillDir], ...]` for overlay skills whose `deploy_to`
   * matches **any** shape in *shapes* (or the `all` sentinel). Sources:
   * *overlayPath* first, then `~/.canary/skills/`. The first definition of a
   * name wins.
   *
   * *shapes* is a set, not a scalar, because a monorepo genuinely has several
   * shapes at once (#504 part 1). One pass over the overlay collects the union
   * deduplicated by name, so a skill matching two shapes is collected once and
   * the deploy manifest is read and written exactly once -- which a per-shape
   * loop would not give.
   *
   * An empty *shapes* is the old `unknown`: only `deploy_to: [all]` matches.
   */
  private collectOverlaySkills(
    shapes: string[],
    overlayPath: string | null,
  ): Array<[SkillInfo, string]> {
    const candidateRoots: string[] = [];
    if (overlayPath !== null) candidateRoots.push(overlayPath);
    const homeSkills = join(this.home, '.canary', 'skills');
    if (isDir(homeSkills)) candidateRoots.push(this.home); // registry walks up

    const reg = new SkillRegistry();
    const collected: Array<[SkillInfo, string]> = [];
    const seenNames = new Set<string>();

    for (const root of candidateRoots) {
      let overlaySkillsDir = join(root, '.canary', 'skills');
      if (!isDir(overlaySkillsDir)) {
        // Maybe root IS the .canary/skills dir directly.
        if (
          basename(root) === 'skills' &&
          basename(resolve(root, '..')) === '.canary'
        ) {
          overlaySkillsDir = root;
        } else {
          continue;
        }
      }
      let entries: string[];
      try {
        entries = readdirSync(overlaySkillsDir).sort();
      } catch {
        entries = [];
      }
      for (const name of entries) {
        const skillDir = join(overlaySkillsDir, name);
        if (!isDir(skillDir)) continue;
        const skillMd = join(skillDir, 'SKILL.md');
        if (!existsSync(skillMd)) continue;
        // Parse frontmatter directly to avoid full registry overhead.
        const info = reg.parseNested(skillMd, name, 'overlay');
        if (info === null || seenNames.has(info.name)) continue;
        if (!pyTruthy(info.deploy_to)) continue;
        if (
          !shapes.some((s) => info.deploy_to.includes(s)) &&
          !info.deploy_to.includes('all')
        ) {
          continue;
        }
        seenNames.add(info.name);
        collected.push([info, skillDir]);
      }
    }

    return collected;
  }

  /**
   * Copy skills from the overlay's `.canary/skills/` matching any of *shapes*.
   * Deployment is strictly one-way -- the overlay owns deployed files (#334).
   */
  deploySkills(
    shapes: string[],
    overlayPath: string | null,
    targetRoot: string,
    dryRun: boolean,
  ): SkillDeployResult[] {
    const results: SkillDeployResult[] = [];
    const skillsToDeploy = this.collectOverlaySkills(shapes, overlayPath);

    const targetSkillsDir = join(targetRoot, '.canary', 'skills');
    const doc = readManifestDoc(targetSkillsDir);
    const manifest = doc.skills;
    let manifestDirty = false;

    for (const [info, skillDir] of skillsToDeploy) {
      const dirName = basename(skillDir);
      const dest = join(targetSkillsDir, dirName);
      const overlayHash = hashSkillDir(skillDir);

      if (existsSync(dest)) {
        const targetHash = hashSkillDir(dest);
        if (targetHash === overlayHash) {
          results.push(
            new SkillDeployResult(info.name, 'skipped', 'already current'),
          );
          if (manifest[dirName]?.hash !== overlayHash) {
            manifest[dirName] = { name: info.name, hash: overlayHash };
            manifestDirty = true;
          }
          continue;
        }
        if (isLocallyEdited(overlayHash, targetHash, manifest[dirName]?.hash)) {
          // Hand-edited (or unprovenanced) -- one-way ownership refuses to clobber.
          results.push(
            new SkillDeployResult(
              info.name,
              'skipped',
              `local edits ${EMDASH} not overwritten`,
            ),
          );
          continue;
        }
        // Untouched since deploy; overlay moved on -> safe to refresh.
        if (dryRun) {
          results.push(
            new SkillDeployResult(info.name, 'dry_run', 'would update'),
          );
          continue;
        }
        rmSync(dest, { recursive: true, force: true });
        cpSync(skillDir, dest, { recursive: true });
        manifest[dirName] = { name: info.name, hash: overlayHash };
        manifestDirty = true;
        results.push(new SkillDeployResult(info.name, 'updated'));
        continue;
      }

      if (dryRun) {
        results.push(new SkillDeployResult(info.name, 'dry_run'));
        continue;
      }
      mkdirSync(targetSkillsDir, { recursive: true });
      cpSync(skillDir, dest, { recursive: true });
      manifest[dirName] = { name: info.name, hash: overlayHash };
      manifestDirty = true;
      results.push(new SkillDeployResult(info.name, 'copied'));
    }

    if (manifestDirty && !dryRun) writeManifestDoc(targetSkillsDir, doc);

    return results;
  }

  /**
   * Would the deploy phase skip this skill as `local_edit` (#667)?
   *
   * Answers for the CURRENT on-disk state, so it holds whether the deploy phase
   * has already run this invocation (apply) or never will (dry run / `--check`)
   * -- the workflow report then says the same thing about a skill as the skill
   * report does.
   */
  private skillWasSkipped(
    skillDir: string,
    targetSkillsDir: string,
    manifest: Manifest,
  ): boolean {
    const dirName = basename(skillDir);
    const dest = join(targetSkillsDir, dirName);
    if (!existsSync(dest)) return false;
    return isLocallyEdited(
      hashSkillDir(skillDir),
      hashSkillDir(dest),
      manifest[dirName]?.hash,
    );
  }

  /**
   * Install the workflow templates the shape-matching overlay skills declare
   * into the target's `.github/workflows/` (#459).
   *
   * This runs AFTER the skill copy and is a distinct phase, not an extension of
   * it: the bytes already arrive (whole skill dirs are copied, templates
   * included) -- what was missing is putting them where GitHub Actions looks.
   *
   * **Ownership deliberately differs from `deploySkills`.** Deployed skills are
   * owned one-way by the overlay (#334); a consumer's CI is NOT. Absent ->
   * write. Byte-identical -> no-op. Different -> report and leave alone, always,
   * whatever the provenance. `force` is the deliberate escape hatch. Clobbering
   * a hand-tuned workflow -- or nagging that it is "stale" via an exit code --
   * would be a worse failure than the partial adoption this fixes.
   *
   * **The skill's own protection extends here (#667).** A skill the deploy
   * phase skips as `local_edit` installs nothing: it is reported `withheld`
   * with the reason and no bytes are written. Otherwise a run could announce
   * "skipped -- local edits, not overwritten" while writing that same skill's
   * files to `.github/workflows/` anyway, which is how a consumer who
   * deliberately de-listed a template got it reinstated on every sync. The
   * de-listing lives in the consumer's SKILL.md, and the install list is read
   * from the OVERLAY copy -- so withholding is also the only way that edit can
   * mean anything.
   *
   * Shape selection reuses the same resolved shape set that drives `deploy_to`
   * matching: skills are gated by {@link collectOverlaySkills}, and an entry may
   * additionally carry a `<shape>:` prefix to pick a variant. A prefixed entry
   * installs when its shape is anywhere in *shapes* (#504 part 1) -- a monorepo
   * carrying both an e2e and a unit package wants both variants, and matching
   * only the scalar would silently install neither once the scalar collapses to
   * `unknown`.
   */
  installWorkflows(
    shapes: string[],
    overlayPath: string | null,
    targetRoot: string,
    dryRun: boolean,
    force = false,
  ): WorkflowInstallResult[] {
    const results: WorkflowInstallResult[] = [];
    const skills = this.collectOverlaySkills(shapes, overlayPath);
    const targetSkillsDir = join(targetRoot, '.canary', 'skills');
    const doc = readManifestDoc(targetSkillsDir);
    const workflowsDir = join(targetRoot, '.github', 'workflows');
    let manifestDirty = false;

    for (const [info, skillDir] of skills) {
      const { entries, version } = readWorkflowDeclaration(info.path);
      // Hashing a skill directory is not free, so only skills that actually
      // declare templates pay for the local-edit lookup.
      const skillWithheld =
        !force &&
        entries.length > 0 &&
        this.skillWasSkipped(skillDir, targetSkillsDir, doc.skills);
      for (const entry of entries) {
        const [wantShape, rel] = parseWorkflowEntry(entry);
        if (
          wantShape !== null &&
          !shapes.includes(wantShape) &&
          wantShape !== 'all'
        ) {
          continue;
        }

        const src = resolveTemplatePath(skillDir, rel);
        if (src === null) {
          results.push(
            new WorkflowInstallResult(
              basename(rel),
              info.name,
              'invalid',
              `declared template '${rel}' resolves outside the skill directory ` +
                `${EMDASH} refused`,
            ),
          );
          continue;
        }
        if (!isFile(src)) {
          results.push(
            new WorkflowInstallResult(
              basename(rel),
              info.name,
              'missing',
              `the overlay declares '${rel}' but does not ship it`,
            ),
          );
          continue;
        }

        const name = basename(src);
        const dest = join(workflowsDir, name);
        const templateBytes = readFileSync(src);
        const templateHash = sha256(templateBytes);
        const record = (): void => {
          doc.workflows[name] = {
            skill: info.name,
            template: rel,
            version,
            hash: templateHash,
          };
          manifestDirty = true;
        };
        const install = (): void => {
          mkdirSync(workflowsDir, { recursive: true });
          writeFileSync(dest, templateBytes);
          record();
        };
        const push = (status: string, detail: string): void => {
          results.push(
            new WorkflowInstallResult(name, info.name, status, detail),
          );
        };

        const installedBytes = existsSync(dest) ? readBytesOrNull(dest) : null;
        const alreadyCurrent =
          installedBytes !== null && installedBytes.equals(templateBytes);

        // #667: the declaring skill was skipped as locally edited, so this
        // template is not ours to place. An already-identical file is exempt:
        // it is a no-op, and calling that "withheld" would raise a finding on
        // every scheduled freshness check. Everything else is gated here,
        // ahead of `outdated`, whose remedy ("re-run with --force") would
        // otherwise talk a consumer into the very overwrite the skip refused.
        if (skillWithheld && !alreadyCurrent) {
          push(
            'withheld',
            `.github/workflows/${name} was NOT installed ${EMDASH} its skill ` +
              `'${info.name}' has local edits and was skipped, so its ` +
              'templates were withheld too; re-run with --force to install it ' +
              'anyway',
          );
          continue;
        }

        if (!existsSync(dest)) {
          if (dryRun) {
            push(
              'dry_run',
              `would install .github/workflows/${name} (v${version})`,
            );
            continue;
          }
          install();
          push(
            'installed',
            `installed .github/workflows/${name} (v${version})`,
          );
          continue;
        }

        if (alreadyCurrent) {
          // Back-fill provenance for a hand-placed but identical file so a later
          // template fix can be reported as `outdated` rather than `conflict`.
          if (doc.workflows[name]?.hash !== templateHash) record();
          push('skipped', `.github/workflows/${name} already current`);
          continue;
        }

        if (force) {
          if (dryRun) {
            push(
              'dry_run',
              `would overwrite .github/workflows/${name} with v${version} (--force)`,
            );
            continue;
          }
          install();
          push(
            'updated',
            `overwrote .github/workflows/${name} with v${version} (--force)`,
          );
          continue;
        }

        const recorded = doc.workflows[name];
        const untouched =
          installedBytes !== null &&
          recorded !== undefined &&
          recorded.hash === sha256(installedBytes);
        if (untouched) {
          push(
            'outdated',
            `.github/workflows/${name} is at v${recorded.version}, the overlay ` +
              `ships v${version} ${EMDASH} unmodified since install, so re-run ` +
              'with --force to take the update',
          );
          continue;
        }
        push(
          'conflict',
          `.github/workflows/${name} differs from the overlay template and was ` +
            `left untouched ${EMDASH} your CI is yours; re-run with --force to ` +
            'replace it',
        );
      }
    }

    if (manifestDirty && !dryRun) writeManifestDoc(targetSkillsDir, doc);

    return results;
  }

  /**
   * Compare the overlay's deployable skills against what *projectRoot* carries,
   * without writing anything (#334).
   */
  checkFreshness(
    projectRoot: string,
    options: CheckFreshnessOptions,
  ): FreshnessReport {
    const overlayPath = options.overlayPath;
    const ctx = this.detect(projectRoot);
    if (!ctx.is_harness_project) {
      if (ctx.not_test_project_reason)
        throw new Error(ctx.not_test_project_reason);
      throw new Error(
        `No harness project detected at ${projectRoot}. ` +
          'Expected harness.config.json and .harness/ directory.',
      );
    }

    const shape = ctx.detected_shape;
    // The gate must examine exactly what `migrate` deploys. Resolving only the
    // scalar here would let `--check` report "in sync" about skills it never
    // looked at in a monorepo -- a deliberate false green in a drift gate
    // (#504 part 1).
    const shapes = ctx.shapes;
    const skills = this.collectOverlaySkills(shapes, overlayPath);
    const targetSkillsDir = join(projectRoot, '.canary', 'skills');
    const manifest = readManifestDoc(targetSkillsDir).skills;

    const results: SkillFreshnessResult[] = [];
    for (const [info, skillDir] of skills) {
      const dirName = basename(skillDir);
      const dest = join(targetSkillsDir, dirName);
      if (!existsSync(dest)) {
        results.push(
          new SkillFreshnessResult(
            info.name,
            dirName,
            'missing',
            'overlay ships this skill; target does not carry it',
          ),
        );
        continue;
      }
      const overlayHash = hashSkillDir(skillDir);
      const targetHash = hashSkillDir(dest);
      if (targetHash === overlayHash) {
        results.push(new SkillFreshnessResult(info.name, dirName, 'current'));
        continue;
      }
      const recorded = manifest[dirName]?.hash;
      if (recorded !== undefined && targetHash === recorded) {
        results.push(
          new SkillFreshnessResult(
            info.name,
            dirName,
            'stale',
            'overlay has a newer version',
          ),
        );
      } else {
        results.push(
          new SkillFreshnessResult(
            info.name,
            dirName,
            'local_edit',
            'deployed skill has local edits; refusing to overwrite',
          ),
        );
      }
    }

    return new FreshnessReport(
      shape,
      overlayPath !== null ? String(overlayPath) : null,
      results,
      // dryRun = true: `--check` reports what an install WOULD do and never
      // writes. Informational only -- see FreshnessReport.workflows.
      this.installWorkflows(shapes, overlayPath, projectRoot, true, false),
      shapes,
    );
  }

  private detectFramework(
    root: string,
    config: Record<string, unknown>,
    ws: WorkspaceInfo | null = null,
  ): [string | null, string, string, string] {
    // Explicit override in .canary/company.json ("canary_shape" field) is
    // user intent: it wins over every probe tier's shape, including a total
    // probe miss (#502 — monorepos often have no root framework config).
    // Framework detection still runs so framework-dependent behavior keeps
    // working when a probe does match.
    const rawShape = config['canary_shape'];
    const explicitShape = (rawShape == null ? '' : String(rawShape))
      .trim()
      .toLowerCase();
    const rootProbe = this.probeFramework(root, config);
    // A root miss falls through to the workspace packages -- but only a miss.
    // A root config file still outranks them, unchanged from before (#504).
    const resolved =
      rootProbe[0] === null && ws !== null
        ? (this.resolveFromWorkspace(ws) ?? rootProbe)
        : rootProbe;
    const [framework, shape, source, confidence] = resolved;
    if (!explicitShape) return [framework, shape, source, confidence];
    return framework === null
      ? [null, explicitShape, 'canary_shape (.canary/company.json)', 'explicit']
      : [framework, explicitShape, source, confidence];
  }

  /**
   * The scalar (framework, shape, source) implied by workspace findings.
   *
   * Unanimity is on the (framework, shape) PAIR, not the framework alone --
   * shape drives which overlay skills and workflow templates deploy, so two
   * playwright packages resolving to e2e_ui and api are not unanimous. Applies
   * at N >= 1: `detection_source` reports the package count, so the scalar
   * never pretends a root probe hit (#504 part 1).
   */
  private resolveFromWorkspace(ws: WorkspaceInfo): ProbeResult | null {
    const findings = ws.findings;
    if (findings.length === 0) return null;
    const pairs = new Set(findings.map((f) => `${f.framework}\0${f.shape}`));
    if (pairs.size > 1) {
      return [null, 'unknown', 'workspace (mixed)', 'none'];
    }
    const first = findings[0]!;
    const n = new Set(findings.map((f) => f.dir)).size;
    return [
      first.framework,
      first.shape,
      `workspace (${n} package${n === 1 ? '' : 's'})`,
      first.confidence,
    ];
  }

  private probeFramework(
    root: string,
    config: Record<string, unknown>,
  ): ProbeResult {
    return probeFramework(root, config, ['config', 'content', 'language']);
  }

  private findExistingTests(root: string): string[] {
    const found: string[] = [];
    for (const pattern of _TEST_GLOBS) {
      // Python sorts Path objects (component-wise); match it so preserved-files
      // report order agrees (see comparePathParts).
      for (const path of globFiles(root, pattern).sort(comparePathParts)) {
        const rel = relative(root, path).split(sep).join('/');
        if (!found.includes(rel)) found.push(rel);
      }
    }
    return found;
  }
}
