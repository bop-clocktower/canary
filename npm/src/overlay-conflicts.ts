'use strict';

/**
 * Overlay skill-name conflict detection (#333).
 *
 * When two registered overlays ship a skill of the same name, which definition
 * wins was previously undefined and undocumented. This module detects those
 * collisions and decides — from each overlay's declared `precedence` — whether
 * the winner is *declared* (resolved) or *accidental* (unresolved).
 *
 * Winner rule (must match the Python skill loader, `agent/core/skill_registry`):
 * among the overlays contending for a skill name, the one with the highest
 * `precedence` wins; a null/absent precedence counts as 0. The collision is
 * only **resolved** when exactly one overlay holds that highest value —
 * otherwise the winner is arbitrary (directory-name order) and `doctor` flags
 * it so the operator declares a precedence.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { OverlayEntry, OverlayRegistry } from './overlays-registry.js';

/** One overlay contending for a skill name, with its effective precedence. */
export interface Contender {
  overlay: string;
  /** Declared precedence, or 0 when the entry left it null/absent. */
  precedence: number;
}

/** A skill name shipped by two or more registered overlays. */
export interface SkillConflict {
  skill: string;
  /** All contending overlays, ordered by precedence desc then name asc. */
  contenders: Contender[];
  /** The overlay that wins by declared precedence, or null when it is a tie. */
  winner: string | null;
  /** True iff a single overlay holds the highest precedence. */
  resolved: boolean;
}

export interface ConflictDeps {
  /** List the skill (directory) names an overlay ships. Injectable for tests. */
  readSkillNames?: (entry: OverlayEntry) => string[];
}

/** Effective precedence: null/absent is 0. */
function effectivePrecedence(entry: OverlayEntry): number {
  return typeof entry.precedence === 'number' ? entry.precedence : 0;
}

/**
 * Skill (directory) names an overlay ships, read from
 * `<overlay>/.canary/skills/<name>/SKILL.md`. A missing or unreadable skills
 * dir yields no names (never throws) — mirrors the Python loader's tolerance.
 */
export function readOverlaySkillNames(entry: OverlayEntry): string[] {
  // A hand-edited overlays.json (which #333 invites, to add `precedence`) may
  // carry an entry with no `path`. Tolerate it rather than throwing — the
  // "never throws" contract must hold before path.join, not only around readdir.
  if (typeof entry.path !== 'string' || entry.path === '') return [];
  const skillsDir = path.join(entry.path, '.canary', 'skills');
  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(skillsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const names: string[] = [];
  for (const d of dirents) {
    if (!d.isDirectory()) continue;
    if (fs.existsSync(path.join(skillsDir, d.name, 'SKILL.md'))) {
      names.push(d.name);
    }
  }
  return names;
}

/**
 * Detect skill-name collisions across the registered overlays. Returns one
 * {@link SkillConflict} per skill name shipped by two or more overlays, sorted
 * by skill name.
 */
export function detectSkillConflicts(
  reg: OverlayRegistry,
  deps: ConflictDeps = {},
): SkillConflict[] {
  const readSkillNames = deps.readSkillNames ?? readOverlaySkillNames;

  // skill name -> contending overlays
  const bySkill = new Map<string, Contender[]>();
  for (const entry of reg.overlays) {
    const precedence = effectivePrecedence(entry);
    for (const skill of readSkillNames(entry)) {
      const list = bySkill.get(skill) ?? [];
      list.push({ overlay: entry.name, precedence });
      bySkill.set(skill, list);
    }
  }

  const conflicts: SkillConflict[] = [];
  for (const [skill, contenders] of bySkill) {
    if (contenders.length < 2) continue;
    const ordered = [...contenders].sort(
      (a, b) =>
        b.precedence - a.precedence || a.overlay.localeCompare(b.overlay),
    );
    const top = ordered[0].precedence;
    const topHolders = ordered.filter((c) => c.precedence === top);
    const resolved = topHolders.length === 1;
    conflicts.push({
      skill,
      contenders: ordered,
      winner: resolved ? topHolders[0].overlay : null,
      resolved,
    });
  }

  return conflicts.sort((a, b) => a.skill.localeCompare(b.skill));
}
