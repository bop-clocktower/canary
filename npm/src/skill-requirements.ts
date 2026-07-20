'use strict';

/**
 * Skill runtime-requirement verification (#336).
 *
 * Skills declare the runtime tools they need in SKILL.md frontmatter:
 *
 *     requires: [python3>=3.11, node>=20]
 *
 * `canary doctor` reads those declarations from the skills installed in a
 * consuming repo (overlay / global / local) and reports named, remediable
 * failures — so a skill fails at `doctor` time with a clear message instead of
 * cryptically at first run.
 *
 * Scope / naming: `requires` is deliberately distinct from harness's *planned*
 * `capabilities:` field (Intense-Visions/harness-engineering#558). The two are
 * orthogonal: harness `capabilities` bounds the Claude Code tools/network/file
 * access a skill may use (a permission ceiling); canary `requires` verifies the
 * runtime environment (is the interpreter installed, at a new-enough version).
 * Keeping the field names separate avoids a future collision.
 *
 * Token grammar (v1): `<command>` or `<command><op><version>`, op in
 * `>=` | `>` | `==`, version a dotted numeric (`3`, `3.11`, `1.22.0`). Non-command
 * capability tokens (e.g. browser bundles) are intentionally NOT invented here;
 * an unparseable token verifies as `unverifiable`, never a hard failure.
 */

export type RequirementOp = '>=' | '>' | '==';

export interface Requirement {
  /** The original token, verbatim. */
  raw: string;
  /** The command to look for on PATH, or null when the token is unparseable. */
  command: string | null;
  op: RequirementOp | null;
  /** Dotted numeric version constraint, or null for a presence-only token. */
  version: string | null;
}

export type RequirementStatus = 'ok' | 'missing' | 'too-old' | 'unverifiable';

export interface RequirementResult {
  requirement: Requirement;
  status: RequirementStatus;
  detail: string;
}

/** What a command probe reports: is it on PATH, and its detected version. */
export interface ProbeResult {
  present: boolean;
  version: string | null;
}
export type CommandProbe = (command: string) => ProbeResult;

const OP_RE = /^(.+?)\s*(>=|==|>)\s*([0-9][0-9.]*)\s*$/;
const BARE_RE = /^[A-Za-z0-9._+-]+$/;

/** Parse one requirement token into its command + optional version constraint. */
export function parseRequirement(token: string): Requirement {
  const m = token.match(OP_RE);
  if (m) {
    return {
      raw: token,
      command: m[1].trim(),
      op: m[2] as RequirementOp,
      version: m[3],
    };
  }
  const bare = token.trim();
  if (BARE_RE.test(bare)) {
    return { raw: token, command: bare, op: null, version: null };
  }
  return { raw: token, command: null, op: null, version: null };
}

/** Numeric tuple from a dotted version; non-numeric parts stop the parse. */
function toParts(v: string): number[] {
  const parts: number[] = [];
  for (const seg of v.split('.')) {
    const n = Number.parseInt(seg, 10);
    if (Number.isNaN(n)) break;
    parts.push(n);
  }
  return parts;
}

/** Compare a against b over the length of `len` segments. -1 / 0 / 1. */
function cmpParts(a: number[], b: number[], len: number): number {
  for (let i = 0; i < len; i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av !== bv) return av < bv ? -1 : 1;
  }
  return 0;
}

/** Does `have` satisfy `op want`? Compares over the constraint's precision. */
function satisfies(have: string, op: RequirementOp, want: string): boolean {
  const h = toParts(have);
  const w = toParts(want);
  if (w.length === 0) return true;
  // `==` compares only the segments the constraint pins (1.22 matches 1.22.4).
  const c = cmpParts(
    h,
    w,
    op === '==' ? w.length : Math.max(h.length, w.length),
  );
  if (op === '==') return c === 0;
  if (op === '>') return c > 0;
  return c >= 0; // '>='
}

/** Verify one requirement against a command probe. Never throws. */
export function checkRequirement(
  req: Requirement,
  probe: CommandProbe,
): RequirementResult {
  if (req.command === null) {
    return {
      requirement: req,
      status: 'unverifiable',
      detail: `cannot parse requirement "${req.raw}"`,
    };
  }
  const p = probe(req.command);
  if (!p.present) {
    return {
      requirement: req,
      status: 'missing',
      detail: `${req.command} not found on PATH`,
    };
  }
  if (req.version === null) {
    return { requirement: req, status: 'ok', detail: `${req.command} present` };
  }
  if (p.version === null) {
    return {
      requirement: req,
      status: 'unverifiable',
      detail: `${req.command} present but its version could not be read`,
    };
  }
  if (satisfies(p.version, req.op ?? '>=', req.version)) {
    return {
      requirement: req,
      status: 'ok',
      detail: `${req.command} ${p.version} satisfies ${req.op}${req.version}`,
    };
  }
  return {
    requirement: req,
    status: 'too-old',
    detail: `${req.command} ${p.version} does not satisfy ${req.op}${req.version}`,
  };
}

/**
 * Extract the `requires:` flow list from SKILL.md frontmatter — the same
 * tiny-YAML subset the Python loader parses (`requires: [a, b]`). Returns []
 * when absent or when there is no frontmatter. Block-sequence form is not
 * supported (kept in lockstep with the Python parser).
 */
export function parseRequiresField(md: string): string[] {
  if (!md.startsWith('---')) return [];
  const lines = md.split('\n');
  for (const line of lines.slice(1)) {
    if (line.trim() === '---') break;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    if (line.slice(0, idx).trim() !== 'requires') continue;
    const value = line.slice(idx + 1).trim();
    if (value.startsWith('[') && value.endsWith(']')) {
      return value
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    }
    return value ? [value] : [];
  }
  return [];
}
