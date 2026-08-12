/**
 * Proof that a module has no runtime content at all (#562) — the one
 * suppression that is about the FILE rather than the fidelity tier.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { splitLines } from './types.js';

/**
 * Filenames/paths that plausibly hold nothing but type declarations (#562).
 *
 * A NAME GATE ONLY -- it decides which files are worth reading, never which
 * are suppressed. {@link isTypeOnlyModule} always confirms against content,
 * because a `types.ts` that also exports an enum or a const map is ordinary
 * TypeScript and its findings are real.
 */
function isTypeModuleCandidate(path: string): boolean {
  const base = path.slice(path.lastIndexOf('/') + 1);
  if (base.endsWith('.d.ts')) return true;
  if (!/\.(ts|tsx|mts|cts)$/.test(base)) return false;
  if (base === 'types.ts' || base.endsWith('.types.ts')) return true;
  return path.split('/').slice(0, -1).includes('types');
}

/**
 * True if `path` is a module with no runtime content at all (#562).
 *
 * The false-positive class this closes is the one the heuristic-tier fix
 * (#413) structurally cannot reach. `filterHeuristicNoise` is gated on
 * `fidelity === HEURISTIC` on purpose -- a coverage-verified verdict rests on
 * a real lcov row, so suppressing by path at that tier would discard
 * evidence. A type-only module is the case that breaks the symmetry: the lcov
 * row is accurate (39 lines, genuinely never executed) and the finding is
 * still unsatisfiable, because an interface has no runtime existence for a
 * test to reach. The evidence needed is therefore about the FILE, not the
 * tier: prove there is nothing executable in it.
 *
 * Conservative in one direction on purpose. Every uncertainty -- an
 * unreadable file, an unrecognised construct -- resolves to `false`, keeping
 * the finding. A missed suppression costs one noisy finding; a wrong
 * suppression hides untested code, which is the thing the guardian exists to
 * catch.
 */
export function isTypeOnlyModule(path: string, repoRoot: string): boolean {
  if (!isTypeModuleCandidate(path)) return false;
  let source: string;
  try {
    source = readFileSync(join(repoRoot, path), 'utf-8');
  } catch {
    return false; // unreadable -> unproven -> keep the finding
  }
  return isTypeOnlySource(source);
}

/** Drop `//` and `/* *\/` comments so keywords inside prose never count. */
function stripComments(source: string): string {
  const out: string[] = [];
  let inBlock = false;
  for (const line of splitLines(source)) {
    let text = line;
    if (inBlock) {
      const end = text.indexOf('*/');
      if (end === -1) {
        out.push('');
        continue;
      }
      text = text.slice(end + 2);
      inBlock = false;
    }
    for (;;) {
      const start = text.indexOf('/*');
      if (start === -1) break;
      const end = text.indexOf('*/', start + 2);
      if (end === -1) {
        text = text.slice(0, start);
        inBlock = true;
        break;
      }
      text = text.slice(0, start) + text.slice(end + 2);
    }
    const line2 = text.indexOf('//');
    out.push(line2 === -1 ? text : text.slice(0, line2));
  }
  return out.join('\n');
}

/**
 * Top-level constructs TypeScript erases entirely at compile time (#562).
 *
 * An ALLOWLIST, not a denylist, and that is the load-bearing choice. A
 * denylist of runtime keywords misses everything it did not enumerate -- a
 * bare `register('widget')` declares nothing and still runs -- and every gap
 * in it suppresses a real finding. An allowlist fails the other way: an
 * unrecognised construct reads as runtime and the finding survives.
 *
 * Plain `import { X } from '...'` is allowed because TypeScript elides an
 * import whose bindings are only used in type positions; if a binding were
 * used as a value, the using statement itself would appear at top level and
 * be rejected. A side-effect `import './x'` carries no binding, is never
 * elided, and is therefore not matched.
 */
function isErasableTopLevelLine(line: string): boolean {
  if (line === '') return true;
  if (/^[})\];,]+$/.test(line)) return true;
  if (/^import\s+type\b/.test(line)) return true;
  if (/^import\b.*\sfrom\s/.test(line)) return true;
  if (/^export\s+type\b/.test(line)) return true;
  const bare = line.replace(
    /^(?:export\s+default\s+|export\s+|declare\s+)+/,
    '',
  );
  return /^(?:interface|type)\s/.test(bare);
}

/**
 * True if every TOP-LEVEL statement in `source` is compile-time-only.
 *
 * Brace depth is tracked so an interface body is never mistaken for
 * statements: only depth-0 lines are judged. An unbalanced file (depth does
 * not return to zero) is treated as unproven rather than type-only -- brace
 * counting is lexical, so a `{` inside a string literal could otherwise hide
 * the rest of the file from inspection.
 */
function isTypeOnlySource(source: string): boolean {
  let depth = 0;
  for (const raw of splitLines(stripComments(source))) {
    const line = raw.trim();
    if (depth === 0 && !isErasableTopLevelLine(line)) return false;
    depth += bracketDelta(line);
    if (depth < 0) return false;
  }
  return depth === 0;
}

/** Net nesting change across one line: openers minus closers. */
function bracketDelta(line: string): number {
  let delta = 0;
  for (const ch of line) {
    if (ch === '{' || ch === '(' || ch === '[') delta += 1;
    else if (ch === '}' || ch === ')' || ch === ']') delta -= 1;
  }
  return delta;
}
