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
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { readJsonWithWarning } from './config-validation.js';
import { uncertainDetectionMessage } from './detection.js';
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
 * Order two POSIX-style relative paths the way Python orders `Path` objects:
 * component-wise (`PurePath.__lt__` compares the parts list), NOT as joined
 * strings. They differ when a directory name prefixes a sibling file name and
 * the next char sorts below '/' (0x2F) -- most commonly the '.' extension
 * separator, e.g. `scripts/run.sh` vs `scripts.md`. A joined-string sort places
 * `scripts.md` first ('.' 0x2E < '/' 0x2F); Python's component sort places
 * `scripts/run.sh` first ('scripts' < 'scripts.md'). This ordering feeds the
 * skill-dir hash, a byte-exact contract compared against Python-written
 * .deploy-manifest.json files on the upgrade path.
 */
function comparePathParts(a: string, b: string): number {
  const pa = a.split('/');
  const pb = b.split('/');
  const n = Math.min(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    if (pa[i]! < pb[i]!) return -1;
    if (pa[i]! > pb[i]!) return 1;
  }
  return pa.length - pb.length;
}

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

// ---------------------------------------------------------------------------
// Constants / probes
// ---------------------------------------------------------------------------

/**
 * Frameworks a user can pass to `canary migrate --framework <name>`. Surfaced in
 * the fail-loud message when auto-detection is uncertain (issue #295).
 */
export const KNOWN_FRAMEWORKS: readonly string[] = [
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

// (config_file, framework, shape, confidence)
const _CONFIG_PROBES: Array<[string, string, string, string]> = [
  ['playwright.config.ts', 'playwright', 'e2e_ui', 'config'],
  ['playwright.config.js', 'playwright', 'e2e_ui', 'config'],
  ['cypress.config.ts', 'playwright', 'e2e_ui', 'config'],
  ['cypress.config.js', 'playwright', 'e2e_ui', 'config'],
  ['vitest.config.ts', 'vitest', 'frontend_unit', 'config'],
  ['vitest.config.js', 'vitest', 'frontend_unit', 'config'],
  ['vitest.config.mts', 'vitest', 'frontend_unit', 'config'],
  ['jest.config.ts', 'vitest', 'frontend_unit', 'config'],
  ['jest.config.js', 'vitest', 'frontend_unit', 'config'],
  ['jest.config.mjs', 'vitest', 'frontend_unit', 'config'],
  ['k6.config.js', 'k6', 'performance', 'config'],
  ['pytest.ini', 'pytest', 'api', 'config'],
  ['setup.cfg', 'pytest', 'api', 'config'],
  ['axe.config.js', 'axe-core', 'accessibility', 'config'],
  ['backstop.json', 'backstopjs', 'visual', 'config'],
  ['pact.json', 'pact', 'contract', 'config'],
  ['.pact', 'pact', 'contract', 'config'],
  ['stryker.config.js', 'stryker', 'mutation', 'config'],
  ['stryker.config.mjs', 'stryker', 'mutation', 'config'],
  ['locust.conf', 'locust', 'load', 'config'],
  ['locustfile.py', 'locust', 'load', 'config'],
  ['wdio.conf.ts', 'wdio', 'mobile', 'config'],
  ['wdio.conf.js', 'wdio', 'mobile', 'config'],
  ['wdio.conf.mjs', 'wdio', 'mobile', 'config'],
];

// pyproject.toml section markers
const _PYPROJECT_MARKERS: Array<[string, string, string]> = [
  ['[tool.pytest.ini_options]', 'pytest', 'api'],
  ['[tool.coverage', 'pytest', 'api'],
];

// package.json test script -> (framework, shape)
const _PACKAGE_SCRIPT_PATTERNS: Array<[RegExp, string, string]> = [
  [/\bplaywright\b/, 'playwright', 'e2e_ui'],
  [/\bcypress\b/, 'playwright', 'e2e_ui'],
  [/\bvitest\b/, 'vitest', 'frontend_unit'],
  [/\bjest\b/, 'vitest', 'frontend_unit'],
  [/\bk6\b/, 'k6', 'performance'],
  [/\blocust\b/, 'locust', 'load'],
  [/\bstryker\b/, 'stryker', 'mutation'],
  [/\bwdio\b/, 'wdio', 'mobile'],
];

// Python dependency -> (framework, shape). MULTILINE `^` anchored on `\n` only.
const _PYTHON_DEP_PATTERNS: Array<[RegExp, string, string]> = [
  [/(?:^|(?<=\n))pytest\b/i, 'pytest', 'api'],
  [/(?:^|(?<=\n))locust\b/i, 'locust', 'load'],
  [/(?:^|(?<=\n))pact\b/i, 'pact', 'contract'],
  [/(?:^|(?<=\n))sdv\b/i, 'sdv', 'synthetic_data'],
  [/(?:^|(?<=\n))faker\b/i, 'faker', 'synthetic_data'],
  [/(?:^|(?<=\n))testcontainers\b/i, 'testcontainers', 'integration'],
];

// Language -> (framework, shape) fallbacks from harness.config.json
const _LANGUAGE_FALLBACKS: Record<string, [string, string]> = {
  python: ['pytest', 'api'],
  typescript: ['playwright', 'e2e_ui'],
  javascript: ['playwright', 'e2e_ui'],
};

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

// Detects playwright UI fixture params. MULTILINE is a no-op (no `^`/`$`).
const _PW_UI_FIXTURE_RE = /async\s*\(\s*\{[^}]*\b(?:page|browser)\b/;

// ---------------------------------------------------------------------------
// Small filesystem / glob helpers
// ---------------------------------------------------------------------------

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Compile a single glob segment (with `*` -> `[^/]*`) to an anchored regex. */
function segGlobRegex(seg: string): RegExp {
  const body = seg
    .replace(/[.+^${}()|[\]\\?]/g, '\\$&')
    .replace(/\*/g, '[^/]*');
  return new RegExp(`^${body}$`);
}

/**
 * Match files under *root* against a pathlib-style glob (`**` matches zero or
 * more directories; `*` matches within a single segment). Mirrors the subset of
 * `Path.glob` the migrator needs.
 */
function globFiles(root: string, pattern: string): string[] {
  const segments = pattern.split('/');
  const out: string[] = [];
  const visit = (dir: string, si: number): void => {
    const seg = segments[si]!;
    const last = si === segments.length - 1;
    if (seg === '**') {
      // `**` consumes zero directories -> continue at the same dir.
      visit(dir, si + 1);
      // `**` consumes one-or-more -> descend into each subdir, staying on `**`.
      for (const d of subDirs(dir)) visit(d, si);
      return;
    }
    const re = segGlobRegex(seg);
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!re.test(e.name)) continue;
      const full = join(dir, e.name);
      if (last) {
        if (e.isFile() || isFile(full)) out.push(full);
      } else if (e.isDirectory()) {
        visit(full, si + 1);
      }
    }
  };
  visit(root, 0);
  return out;
}

function subDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => join(dir, e.name));
  } catch {
    return [];
  }
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
 *
 * `outdated` and `conflict` are REPORTS. Neither ever writes.
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

  constructor(
    shape: string,
    overlay_path: string | null = null,
    results: SkillFreshnessResult[] = [],
    workflows: WorkflowInstallResult[] = [],
  ) {
    this.shape = shape;
    this.overlay_path = overlay_path;
    this.results = results;
    this.workflows = workflows;
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
    if (this.results.length === 0) {
      lines.push("_No overlay skills match this project's shape._", '');
      lines.push(
        `${WARN} **Abstained** ${EMDASH} the gate verified zero skills, so this is not a pass.`,
        '',
      );
      if (this.shape === 'unknown') {
        lines.push(
          'The shape could not be detected. Set `canary_shape` in',
          '`.canary/company.json` or pass `--framework <name>`.',
          '',
        );
      } else {
        lines.push(
          `The overlay ships no skills with \`deploy_to\` covering \`${this.shape}\`.`,
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
  manual_followups?: string[];
  deployed_skills?: SkillDeployResult[];
  installed_workflows?: WorkflowInstallResult[];
  config_warnings?: string[];
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
  manual_followups: string[];
  deployed_skills: SkillDeployResult[];
  installed_workflows: WorkflowInstallResult[];
  config_warnings: string[];

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
    this.manual_followups = init.manual_followups ?? [];
    this.deployed_skills = init.deployed_skills ?? [];
    this.installed_workflows = init.installed_workflows ?? [];
    this.config_warnings = init.config_warnings ?? [];
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
          } as Record<string, string>
        )[this.detection_confidence] ?? this.detection_confidence;
      lines.push(
        `**Detected from:** \`${this.detection_source}\``,
        `**Confidence:** ${confidenceLabel}`,
      );
    }

    lines.push('');

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
        lines.push(
          outcome.summaryLine,
          '',
          'This dry run would migrate zero item(s) ' +
            EMDASH +
            ' the project already carries everything this migration would ' +
            'produce. If you expected changes, check `--from <overlay>` and ' +
            'the detected framework/shape above.',
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

    const [framework, shape, source, confidence] = this.detectFramework(
      projectRoot,
      harnessConfig,
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
    const shape = ctx.detected_shape;
    const source = pyTruthy(framework) ? 'CLI override' : ctx.detection_source;
    const confidence = pyTruthy(framework)
      ? 'config'
      : ctx.detection_confidence;
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
        shape,
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
        deployed_skills: deployed,
        installed_workflows: this.installWorkflows(
          shape,
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
    const scaffolder = new Scaffolder();
    const deployed = this.deploySkills(shape, overlayPath, projectRoot, dryRun);
    // Post-copy install phase: the template bytes already landed under
    // .canary/skills/ with the skill; this puts them where Actions looks.
    const installedWorkflows = this.installWorkflows(
      shape,
      overlayPath,
      projectRoot,
      dryRun,
      force,
    );

    if (dryRun) {
      const tmpl = TEMPLATES[effectiveFramework];
      const files = tmpl?.files ?? {};
      const dirs = tmpl?.dirs ?? [];
      const wouldCreate = [
        ...Object.keys(files).filter((f) => !existsSync(join(projectRoot, f))),
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
        manual_followups: followups,
        deployed_skills: deployed,
        installed_workflows: installedWorkflows,
        config_warnings: ctx.config_warnings,
      });
    }

    const result = scaffolder.scaffold(effectiveFramework, String(projectRoot));

    return new MigrationReport({
      framework: effectiveFramework,
      shape,
      dry_run: false,
      detection_source: source,
      detection_confidence: confidence,
      created_files: result['created_files'] as string[],
      created_dirs: result['created_dirs'] as string[],
      skipped_configs: result['skipped_files'] as string[],
      preserved_files: preserved,
      manual_followups: followups,
      deployed_skills: deployed,
      installed_workflows: installedWorkflows,
      config_warnings: ctx.config_warnings,
    });
  }

  // -- private helpers --------------------------------------------------------

  /**
   * Return `[[SkillInfo, skillDir], ...]` for overlay skills whose `deploy_to`
   * matches *shape* (or the `all` sentinel). Sources: *overlayPath* first, then
   * `~/.canary/skills/`. The first definition of a name wins.
   */
  private collectOverlaySkills(
    shape: string,
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
          !info.deploy_to.includes(shape) &&
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
   * Copy skills from the overlay's `.canary/skills/` that match *shape*.
   * Deployment is strictly one-way -- the overlay owns deployed files (#334).
   */
  deploySkills(
    shape: string,
    overlayPath: string | null,
    targetRoot: string,
    dryRun: boolean,
  ): SkillDeployResult[] {
    const results: SkillDeployResult[] = [];
    const skillsToDeploy = this.collectOverlaySkills(shape, overlayPath);

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
        const recorded = manifest[dirName]?.hash;
        if (recorded === undefined || targetHash !== recorded) {
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
   * Shape selection reuses the same resolved `canary_shape` that drives
   * `deploy_to` matching: skills are gated by {@link collectOverlaySkills}, and
   * an entry may additionally carry a `<shape>:` prefix to pick a variant.
   */
  installWorkflows(
    shape: string,
    overlayPath: string | null,
    targetRoot: string,
    dryRun: boolean,
    force = false,
  ): WorkflowInstallResult[] {
    const results: WorkflowInstallResult[] = [];
    const skills = this.collectOverlaySkills(shape, overlayPath);
    const targetSkillsDir = join(targetRoot, '.canary', 'skills');
    const doc = readManifestDoc(targetSkillsDir);
    const workflowsDir = join(targetRoot, '.github', 'workflows');
    let manifestDirty = false;

    for (const [info, skillDir] of skills) {
      const { entries, version } = readWorkflowDeclaration(info.path);
      for (const entry of entries) {
        const [wantShape, rel] = parseWorkflowEntry(entry);
        if (wantShape !== null && wantShape !== shape && wantShape !== 'all') {
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

        const installedBytes = readBytesOrNull(dest);
        if (installedBytes !== null && installedBytes.equals(templateBytes)) {
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
    const skills = this.collectOverlaySkills(shape, overlayPath);
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
      this.installWorkflows(shape, overlayPath, projectRoot, true, false),
    );
  }

  private detectFramework(
    root: string,
    config: Record<string, unknown>,
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
    const [framework, shape, source, confidence] = this.probeFramework(
      root,
      config,
    );
    if (!explicitShape) return [framework, shape, source, confidence];
    return framework === null
      ? [null, explicitShape, 'canary_shape (.canary/company.json)', 'explicit']
      : [framework, explicitShape, source, confidence];
  }

  private probeFramework(
    root: string,
    config: Record<string, unknown>,
  ): [string | null, string, string, string] {
    // 1. Dedicated config file (highest confidence).
    for (const [filename, framework, shape, confidence] of _CONFIG_PROBES) {
      if (existsSync(join(root, filename))) {
        // For playwright config files, distinguish API vs UI suites.
        if (framework === 'playwright' && shape === 'e2e_ui') {
          const inferred = inferPlaywrightShape(root);
          if (inferred !== shape)
            return [framework, inferred, filename, 'content'];
        }
        return [framework, shape, filename, confidence];
      }
    }

    // 2. pyproject.toml section markers then dependency scan.
    const pyproject = join(root, 'pyproject.toml');
    if (existsSync(pyproject)) {
      const content = readTextOrNull(pyproject);
      if (content !== null) {
        for (const [marker, framework, shape] of _PYPROJECT_MARKERS) {
          if (content.includes(marker)) {
            return [framework, shape, 'pyproject.toml', 'content'];
          }
        }
        for (const [pattern, framework, shape] of _PYTHON_DEP_PATTERNS) {
          if (pattern.test(content)) {
            return [
              framework,
              shape,
              'pyproject.toml (dependencies)',
              'content',
            ];
          }
        }
      }
    }

    // 3. requirements*.txt dependency scan.
    for (const reqFile of [
      'requirements.txt',
      'requirements-test.txt',
      'requirements-dev.txt',
    ]) {
      const reqPath = join(root, reqFile);
      if (existsSync(reqPath)) {
        const content = readTextOrNull(reqPath);
        if (content !== null) {
          for (const [pattern, framework, shape] of _PYTHON_DEP_PATTERNS) {
            if (pattern.test(content))
              return [framework, shape, reqFile, 'content'];
          }
        }
      }
    }

    // 4. package.json scripts.test scan.
    const pkgJson = join(root, 'package.json');
    if (existsSync(pkgJson)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgJson, 'utf-8')) as Record<
          string,
          unknown
        >;
        const scripts = (pkg['scripts'] ?? {}) as Record<string, unknown>;
        const testScript = String(scripts['test'] ?? '');
        for (const [pattern, framework, shape] of _PACKAGE_SCRIPT_PATTERNS) {
          if (pattern.test(testScript)) {
            return [framework, shape, 'package.json (scripts.test)', 'content'];
          }
        }
      } catch {
        // OSError / JSONDecodeError -> ignore.
      }
    }

    // 5. Language fallback from harness config.
    const language = String(config['language'] ?? '').toLowerCase();
    if (Object.prototype.hasOwnProperty.call(_LANGUAGE_FALLBACKS, language)) {
      const [fw, shape] = _LANGUAGE_FALLBACKS[language]!;
      return [
        fw,
        shape,
        `harness.config.json (language: ${language})`,
        'language',
      ];
    }

    return [null, 'unknown', 'none', 'none'];
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

function readTextOrNull(path: string): string | null {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Return 'api' when no playwright spec file uses page/browser fixtures, else
 * 'e2e_ui' (the default when any UI signal is found or no spec files exist).
 */
function inferPlaywrightShape(root: string): string {
  const specGlobs = [
    'tests/**/*.spec.ts',
    'tests/**/*.spec.js',
    'test/**/*.spec.ts',
    'test/**/*.spec.js',
  ];
  let total = 0;
  for (const glob of specGlobs) {
    for (const path of globFiles(root, glob)) {
      // Python read_text(errors="ignore"); readFileSync substitutes U+FFFD for
      // invalid bytes -- immaterial for the ASCII fixture pattern below.
      let content: string;
      try {
        content = readFileSync(path, 'utf-8');
      } catch {
        continue;
      }
      total += 1;
      if (_PW_UI_FIXTURE_RE.test(content)) return 'e2e_ui';
    }
  }

  return total > 0 ? 'api' : 'e2e_ui';
}
