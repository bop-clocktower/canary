'use strict';

/**
 * SKILL.md frontmatter parsing for `canary overlay lint` (#501). Mirror of
 * the engine's `SkillRegistry.parseFrontmatterWithDiagnostics`
 * (ts/src/core/skill-registry.ts) — keep in sync — so lint and `canary
 * migrate` never disagree on what a SKILL.md declares. The packages compile
 * separately (CJS here, ESM engine), so the rules are mirrored, not imported;
 * parity is pinned by equivalent fixtures in both test suites. Rules: flow
 * lists may wrap across indented lines, block sequences (`- item`) are read,
 * indented continuations fold into the scalar above, and a list-shaped value
 * that cannot be read (an unterminated `[`) is a recorded error — never a
 * silent empty list.
 */

/** Parsed frontmatter entries: scalar strings or list values. */
export type Frontmatter = Record<string, string | string[]>;

export interface ParsedFrontmatter {
  frontmatter: Frontmatter;
  errors: string[];
}

/** Frontmatter body: comment-free lines between the `---` fences. */
function frontmatterBody(md: string): string[] {
  const rest = md.split('\n').slice(1);
  const end = rest.findIndex((l) => l.trim() === '---');
  return (end === -1 ? rest : rest.slice(0, end)).filter(
    (l) => !l.trim().startsWith('#'),
  );
}

/** Block-sequence items; a dash-less line folds into the item above it. */
function blockListItems(cont: string[]): string[] {
  const items: string[] = [];
  for (const c of cont) {
    if (c.startsWith('- ')) items.push(c.slice(2).trim());
    else if (c !== '-' && items.length > 0)
      items[items.length - 1] = `${items[items.length - 1]} ${c}`.trim();
  }
  return items.filter(Boolean);
}

/** Assign one entry from its inline value plus indented continuation lines. */
function assignValue(
  fm: Frontmatter,
  errors: string[],
  key: string,
  inline: string,
  cont: string[],
): void {
  const flow = inline.startsWith('[')
    ? [inline, ...cont]
    : inline === '' && cont[0]?.startsWith('[')
      ? cont
      : null;
  if (flow !== null) {
    const joined = flow.join(' ').trim();
    if (!joined.endsWith(']')) {
      errors.push(
        `\`${key}\`: unterminated flow list (no closing \`]\`): ${joined}`,
      );
      fm[key] = [];
      return;
    }
    fm[key] = joined
      .slice(1, -1)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  } else if (inline === '' && /^-( |$)/.test(cont[0] ?? '')) {
    const items = blockListItems(cont);
    if (items.length === 0)
      errors.push(`\`${key}\`: block list has no parseable items`);
    fm[key] = items;
  } else {
    // Scalar; indented continuation lines fold in (plain multiline YAML).
    fm[key] = [inline, ...cont].join(' ').trim();
  }
}

/** Parse a SKILL.md's frontmatter, collecting diagnostics (never throws). */
export function parseFrontmatter(md: string): ParsedFrontmatter {
  const frontmatter: Frontmatter = {};
  const errors: string[] = [];
  if (!md.startsWith('---')) return { frontmatter, errors };
  const body = frontmatterBody(md);
  let i = 0;
  while (i < body.length) {
    const line = body[i]!;
    const idx = line.indexOf(':'); // first colon, like the engine
    i++;
    // A line is a key only when top-level, non-blank, and colon-bearing.
    if (!line.trim() || /^\s/.test(line) || idx === -1) continue;
    const cont: string[] = []; // indented continuation lines for this key
    while (i < body.length && /^\s+\S/.test(body[i]!)) {
      cont.push(body[i]!.trim());
      i++;
    }
    assignValue(
      frontmatter,
      errors,
      line.slice(0, idx).trim(),
      line.slice(idx + 1).trim(),
      cont,
    );
  }
  return { frontmatter, errors };
}

/** A scalar entry as `string | undefined` (list-valued entries are not scalars). */
export function scalarField(fm: Frontmatter, key: string): string | undefined {
  const v = fm[key];
  return typeof v === 'string' && v ? v : undefined;
}

/** An entry normalized to `string[]` (a bare scalar becomes a one-item list). */
export function listField(fm: Frontmatter, key: string): string[] {
  const v = fm[key];
  if (Array.isArray(v)) return v;
  return typeof v === 'string' && v ? [v.trim()] : [];
}
