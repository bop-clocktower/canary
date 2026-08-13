/**
 * Cross-surface skill-declaration inventory and integrity check (#452).
 *
 * A canary skill is not declared in one place. The same name appears in the
 * `SKILL.md` under `agents/skills/`, in the plugin slash command under
 * `commands/`, in the agent definition under `agents/`, and again in the
 * per-host `agents/commands/<host>/` and `agents/agents/<host>/` trees. Each of
 * those files is internally consistent, so every per-file assertion passes even
 * when they disagree with each other or point at something that no longer
 * exists.
 *
 * That is the bug class #452 describes: grading a value against a hardcoded
 * literal is blind to a fact that is right on one surface and stale on another.
 * The remedy is to grade against **agreement** and **resolvability** instead:
 * enumerate the surfaces that declare a name, then verify the declaration
 * against reality.
 *
 * ## The two rules it enforces
 *
 * 1. **A declared name is the name the invocation path uses.** Skill discovery
 *    ({@link ../core/skill-registry.js}) keys off the frontmatter `name:`, while
 *    every doc invokes the skill by its directory. When those diverge the
 *    documented command misses and nothing says so.
 * 2. **A documented invocation reaches something that exists and can run.** A
 *    `cli:` path that is absent, or present at mode 0644, installs cleanly,
 *    lists cleanly, documents cleanly — and cannot run (#478). A
 *    `canary skills run <name>` in prose whose target has been renamed away is
 *    the same defect one layer up.
 *
 * ## What it deliberately refuses to do
 *
 * It does not adjudicate prose. When two surfaces carry different descriptions
 * there is no principled culprit: #452's triage settled that majority-wins is
 * wrong at N=2 and wrong in general when one surface is the write path and the
 * others are read models, and that only a fixture-intent floor may name a
 * culprit. No such floor exists for skill prose, so divergent descriptions are
 * not reported at all rather than reported against an invented winner. Adding
 * that arbitration is the remaining half of #452 and is out of scope here.
 *
 * ## Denominator
 *
 * {@link checkSurfaces} returns a {@link GateResult} whose `checked` is the
 * number of surface declarations actually inspected. Zero means the layout was
 * renamed underneath the check, and `gateOutcome` turns that into a loud
 * abstention rather than "all surfaces agree" (#508).
 */

import { accessSync, constants, readFileSync, readdirSync } from 'node:fs';
import { basename, extname, join } from 'node:path';

import type { GateResult } from './gate-result.js';
import { SkillRegistry } from './skill-registry.js';

/** Where a skill name was declared. */
export enum SurfaceKind {
  /** `agents/skills/<host>/<dir>/SKILL.md` — the skill itself. */
  Skill = 'skill',
  /** `agents/skills/*.md` — a flat slash-command skill. */
  FlatSkill = 'flat-skill',
  /** `commands/*.md` — the plugin slash command fronting a skill. */
  PluginCommand = 'plugin-command',
  /** `agents/*.md` — the plugin agent definition. */
  PluginAgent = 'plugin-agent',
  /** `agents/commands/<host>/**` — the per-host command definition. */
  HarnessCommand = 'harness-command',
  /** `agents/agents/<host>/**` — the per-host agent definition. */
  HarnessAgent = 'harness-agent',
}

/** One declaration of a skill name on one surface. */
export interface SurfaceDeclaration {
  kind: SurfaceKind;
  /** Frontmatter `name:` when present, else the file or directory stem. */
  name: string;
  /** Directory stem for a nested skill; `null` for flat, single-file surfaces. */
  dirName: string | null;
  /** Absolute path of the declaring file. */
  path: string;
  description: string;
  /** Declared `cli:` path, relative to the declaring file's directory. */
  cli: string | null;
  /**
   * Skill names this surface tells a reader to invoke, from every
   * `canary skills run <name>` in the document. Placeholders (`<name>`) are
   * excluded — reporting an unreachable skill literally called `<name>` would
   * be a finding about the checker, not the docs.
   */
  references: string[];
  /** Raw file body, so downstream checks re-use this parse (see #487). */
  text: string;
}

/** What a cross-surface check found. */
export enum SurfaceFindingKind {
  /** Frontmatter `name:` disagrees with the directory docs invoke it by. */
  NameMismatch = 'name-mismatch',
  /** A declared `cli:` target does not exist. */
  CliMissing = 'cli-missing',
  /** A declared `cli:` target exists but is not executable (#478). */
  CliNotExecutable = 'cli-not-executable',
  /** A documented `canary skills run <name>` names no discoverable skill. */
  UnreachableReference = 'unreachable-reference',
}

export interface SurfaceFinding {
  kind: SurfaceFindingKind;
  surface: SurfaceKind;
  /** The declaring surface's name, so a finding is attributable. */
  name: string;
  path: string;
  detail: string;
}

/**
 * Injected filesystem predicate, so executability is decided in one place.
 *
 * Intentionally NOT exported, along with {@link defaultSurfaceDeps}: nothing
 * outside this module constructs one, and ADR 0012 asks that a provably dead
 * export be unexported rather than left to pad the entropy count. Export both
 * the day a caller genuinely needs to inject.
 */
interface SurfaceDeps {
  /** True when `path` exists and carries the execute bit. */
  isExecutable(path: string): boolean;
  /** True when `path` exists at all. */
  exists(path: string): boolean;
}

/** Vendored trees are not first-party skill surfaces. */
const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage']);

/**
 * A literal canary skill name. Anchored on the `canary-`/`canary:` prefix every
 * first-party skill carries, which keeps a hypothetical `canary skills run
 * my-skill` in prose from being reported as a dead reference.
 */
const SKILL_NAME = /^canary[-:][a-z0-9:_-]*$/;

/** Every `canary skills run <name>` in the document, placeholders excluded. */
function referencedSkills(text: string): string[] {
  const found = new Set<string>();
  const pattern = /canary\s+skills\s+run\s+(\S+)/g;
  for (const match of text.matchAll(pattern)) {
    const token = match[1]!.replace(/[`'"]/g, '');
    if (SKILL_NAME.test(token)) found.add(token);
  }
  return [...found].sort();
}

/** Read a file, returning null when it cannot be read. */
function readOrNull(path: string): string | null {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
}

function listDirs(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !IGNORED_DIRS.has(e.name))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

function listMarkdown(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter(
        (e) => e.isFile() && e.name.endsWith('.md') && e.name !== 'README.md',
      )
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/** Parse one declaring file into a {@link SurfaceDeclaration}. */
function declare(
  kind: SurfaceKind,
  path: string,
  fallbackName: string,
  dirName: string | null,
): SurfaceDeclaration | null {
  const text = readOrNull(path);
  if (text === null) return null;
  // The SAME frontmatter parser discovery uses, deliberately: a checker with
  // its own YAML subset would disagree with the runtime it is auditing, and
  // that disagreement is the bug class rather than a detail (#501).
  const fm = SkillRegistry.parseFrontmatter(text);
  const name =
    typeof fm['name'] === 'string' && fm['name'] ? fm['name'] : fallbackName;
  const description =
    typeof fm['description'] === 'string' ? fm['description'] : '';
  const cli = typeof fm['cli'] === 'string' && fm['cli'] ? fm['cli'] : null;
  return {
    kind,
    name,
    dirName,
    path,
    description,
    cli,
    references: referencedSkills(text),
    text,
  };
}

/** Nested `agents/skills/<host>/<dir>/SKILL.md` declarations. */
function nestedSkills(root: string): SurfaceDeclaration[] {
  const out: SurfaceDeclaration[] = [];
  const skillsRoot = join(root, 'agents', 'skills');
  for (const host of listDirs(skillsRoot)) {
    for (const dir of listDirs(join(skillsRoot, host))) {
      const path = join(skillsRoot, host, dir, 'SKILL.md');
      const decl = declare(SurfaceKind.Skill, path, dir, dir);
      if (decl) out.push(decl);
    }
  }
  return out;
}

/** Flat `*.md` surfaces directly inside `dir`. */
function flatSurfaces(dir: string, kind: SurfaceKind): SurfaceDeclaration[] {
  const out: SurfaceDeclaration[] = [];
  for (const file of listMarkdown(dir)) {
    const path = join(dir, file);
    const decl = declare(kind, path, basename(file, extname(file)), null);
    if (decl) out.push(decl);
  }
  return out;
}

/** Per-host `agents/<commands|agents>/<host>/**\/*.md` surfaces. */
function hostSurfaces(
  root: string,
  segment: 'commands' | 'agents',
  kind: SurfaceKind,
): SurfaceDeclaration[] {
  const out: SurfaceDeclaration[] = [];
  const base = join(root, 'agents', segment);
  for (const host of listDirs(base)) {
    const hostDir = join(base, host);
    out.push(...flatSurfaces(hostDir, kind));
    // Host trees nest one more level (`harness/harness/<name>.md`).
    for (const sub of listDirs(hostDir)) {
      out.push(...flatSurfaces(join(hostDir, sub), kind));
    }
  }
  return out;
}

/**
 * Enumerate every surface that declares a skill name, in a stable order.
 *
 * Purely a read: no network, no subprocess, no writes. `root` is the repository
 * root, injectable so tests build small fixture trees instead of asserting
 * against the live checkout.
 */
export function collectSurfaces(root: string): SurfaceDeclaration[] {
  return [
    ...nestedSkills(root),
    ...flatSurfaces(join(root, 'agents', 'skills'), SurfaceKind.FlatSkill),
    ...flatSurfaces(join(root, 'commands'), SurfaceKind.PluginCommand),
    ...flatSurfaces(join(root, 'agents'), SurfaceKind.PluginAgent),
    ...hostSurfaces(root, 'commands', SurfaceKind.HarnessCommand),
    ...hostSurfaces(root, 'agents', SurfaceKind.HarnessAgent),
  ];
}

/** Process-backed defaults. */
function defaultSurfaceDeps(): SurfaceDeps {
  return {
    isExecutable: (path) => {
      try {
        // X_OK is exactly what `canary skills run` needs; R_OK alone is #478.
        accessSync(path, constants.X_OK);
        return true;
      } catch {
        return false;
      }
    },
    exists: (path) => {
      try {
        accessSync(path, constants.F_OK);
        return true;
      } catch {
        return false;
      }
    },
  };
}

/** Findings for one declaration's `cli:` target. */
function cliFindings(
  decl: SurfaceDeclaration,
  deps: SurfaceDeps,
): SurfaceFinding[] {
  if (decl.cli === null) return [];
  const target = join(decl.path, '..', decl.cli);
  if (!deps.exists(target)) {
    return [
      {
        kind: SurfaceFindingKind.CliMissing,
        surface: decl.kind,
        name: decl.name,
        path: decl.path,
        detail:
          `declares \`cli: ${decl.cli}\` but the target does not exist, so ` +
          '`canary skills run` cannot invoke it',
      },
    ];
  }
  if (!deps.isExecutable(target)) {
    return [
      {
        kind: SurfaceFindingKind.CliNotExecutable,
        surface: decl.kind,
        name: decl.name,
        path: decl.path,
        detail:
          `declares \`cli: ${decl.cli}\` but the target is not executable ` +
          '(#478: mode 0644 installs, lists, and documents cleanly, then fails ' +
          'with EACCES mapped to a bare exit 1)',
      },
    ];
  }
  return [];
}

/**
 * Verify every declaration against reality.
 *
 * Classified **advisory**: it is landing on a repository whose surfaces have
 * never been checked before, so its precision is not yet known and promoting it
 * to a blocking gate would teach people to ignore it (ADR 0010). The
 * zero-denominator abstention is not advisory — that path is loud either way.
 */
export function checkSurfaces(
  root: string,
  deps: SurfaceDeps = defaultSurfaceDeps(),
): GateResult<SurfaceFinding> {
  const surfaces = collectSurfaces(root);
  const known = new Set(
    surfaces
      .filter(
        (s) => s.kind === SurfaceKind.Skill || s.kind === SurfaceKind.FlatSkill,
      )
      .flatMap((s) => (s.dirName ? [s.name, s.dirName] : [s.name])),
  );
  const findings: SurfaceFinding[] = [];

  for (const decl of surfaces) {
    if (
      decl.kind === SurfaceKind.Skill &&
      decl.dirName !== null &&
      decl.name !== decl.dirName
    ) {
      findings.push({
        kind: SurfaceFindingKind.NameMismatch,
        surface: decl.kind,
        name: decl.name,
        path: decl.path,
        detail:
          `frontmatter declares \`name: ${decl.name}\` but the directory is ` +
          `\`${decl.dirName}\`; discovery keys off the frontmatter, docs invoke ` +
          'the directory, so one of the two paths misses',
      });
    }
    findings.push(...cliFindings(decl, deps));
    for (const ref of decl.references) {
      if (!known.has(ref)) {
        findings.push({
          kind: SurfaceFindingKind.UnreachableReference,
          surface: decl.kind,
          name: decl.name,
          path: decl.path,
          detail:
            `documents \`canary skills run ${ref}\`, and no discoverable skill ` +
            'answers to that name',
        });
      }
    }
  }

  return { checked: surfaces.length, findings };
}
