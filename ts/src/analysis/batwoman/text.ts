/**
 * Text layout for the batwoman report.
 *
 * These are the report's typographic primitives -- how prose is broken to a
 * width and how an assembled row is fitted to one. They are separated from
 * `render.ts` because they know nothing about verdicts, registers or sections:
 * they take strings and widths and return strings. Composition lives next
 * door; measuring and breaking lines lives here.
 */

/** `2026-08-22 17:34 UTC`, stable across the runner's timezone. */
export function stamp(when: Date): string {
  return `${when.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** The report's column limit. Header and body wrap to the same width. */
export const WIDTH = 78;

/**
 * Greedy word wrap with a fixed indent. A too-long word gets its own line.
 *
 * **Explanations are single-paragraph prose.** `split(/\s+/)` normalises all
 * internal whitespace, so a newline becomes a space and a run of spaces becomes
 * one. That is a decision, not an accident, and it is recorded here because
 * the probes compose explanations out of evidence, and the temptation
 * to embed a command, a YAML fragment or an indented log line is real. A verdict
 * sentence is a sentence: the thing a probe wants to quote belongs in
 * `evidence`, which {@link fitLine} wraps without reflowing it, or in a future
 * field that declares itself preformatted. Reflowing a YAML fragment silently
 * would be worse than refusing it, so if that need arrives, add the field --
 * do not relax this.
 */
export function wrap(text: string, width: number, indent: string): string[] {
  const lines: string[] = [];
  let current = '';
  for (const word of text.split(/\s+/).filter((w) => w !== '')) {
    const candidate = current === '' ? word : `${current} ${word}`;
    if (indent.length + candidate.length <= width || current === '') {
      current = candidate;
    } else {
      lines.push(indent + current);
      current = word;
    }
  }
  if (current !== '') lines.push(indent + current);
  return lines;
}

/**
 * Fit an already-assembled line to the width, breaking it only if it overflows.
 *
 * `wrap` cannot do this job: a file path is a single whitespace-free token, so
 * `wrap` would faithfully put all 86 columns of it on one line. This breaks at a
 * space when there is one inside the remaining room and chops the token when
 * there is not, which is the only way a path fits at all.
 *
 * A line that already fits is returned untouched, so every short row keeps its
 * exact spacing -- including the two spaces the terse register puts between a
 * path and its status.
 */
export function fitLine(
  line: string,
  width: number,
  continuation: string,
): string[] {
  if (line.length <= width) return [line];
  const lines: string[] = [];
  let rest = line;
  let indent = '';
  while (indent.length + rest.length > width && rest !== '') {
    const room = width - indent.length;
    const space = rest.lastIndexOf(' ', room);
    // A space break is only taken when it fills at least half the line. Every
    // row here starts with a marker -- two spaces of indent, `  - `, `    1. `
    // -- and the last space *within the room* of a long path is the one right
    // after that marker. Breaking there emitted `  -` and `    1.` alone on a
    // line, and for a plain indented path an empty one. A path with no spaces
    // in it has to be chopped somewhere; chopping it at the width reads better
    // than orphaning its bullet.
    const cut = space * 2 >= room ? space : room;
    lines.push((indent + rest.slice(0, cut)).trimEnd());
    rest = rest.slice(cut).trimStart();
    indent = continuation;
  }
  if (rest !== '') lines.push(indent + rest);
  return lines;
}
