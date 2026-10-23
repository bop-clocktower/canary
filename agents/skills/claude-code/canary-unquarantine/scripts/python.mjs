// python -- where a pytest / unittest test is switched off.
//
// Line-oriented, like the JS reader in markers.mjs: comments are blanked, a
// decorator whose arguments wrap is joined into one, and blank or comment-only
// lines never break a decorator stack (`@skip` / `# why` / `def test_x`).
//
// Skips are read from the test's own decorators and from the decorators of
// every class it is nested in. A module-level `pytestmark` that skips is
// reported as `unsure`: this reader cannot tell which tests it covers, so the
// audit abstains rather than call a test released.

const PY_DEF = /^(\s*)(?:async\s+)?def\s+(\w+)\s*\(/;
const PY_CLASS = /^(\s*)class\s+\w+/;
const PY_SKIP =
  /^\s*@((?:pytest\.)?mark\.(?:skip|skipif|xfail)\b.*|unittest\.(?:skip|skipIf|skipUnless|expectedFailure)\b.*)$/;
const PYTESTMARK = /^pytestmark\s*=[\s\S]{0,300}?\b(?:skip|skipif|xfail)\b/m;

/**
 * One python line with its `#` comment blanked (a `#` inside a string is
 * kept), and the net bracket depth of what is left.
 */
export function pyLine(text) {
  let quote = '';
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quote) {
      if (c === '\\') i += 1;
      else if (c === quote) quote = '';
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '#') return { code: text.slice(0, i), depth };
    else if ('([{'.includes(c)) depth += 1;
    else if (')]}'.includes(c)) depth -= 1;
  }
  return { code: text, depth };
}

/** `['f(', 'a,', 'b', ')']` -> `f(a, b)`: a wrapped call read as one line. */
const joinArgs = (parts) =>
  parts
    .filter(Boolean)
    .join(' ')
    .replace(/([([{])\s+/g, '$1')
    .replace(/,?\s+([)\]}])/g, '$1');

const indentOf = (s) => /^\s*/.exec(s)[0].length;

/** The skip decorators in a stack, as the ledger writes them. */
const skipsOf = (stack) =>
  stack.flatMap((d) => {
    const skip = PY_SKIP.exec(d.text);
    return skip ? [skip[1]] : [];
  });

/** The decorator starting at line `i`, joined across wrapped lines; and where it ends. */
function decoratorAt(lines, i) {
  let { code, depth } = pyLine(lines[i]);
  const parts = [code.trim()];
  let end = i;
  while (depth > 0 && end + 1 < lines.length) {
    end += 1;
    const next = pyLine(lines[end]);
    parts.push(next.code.trim());
    depth += next.depth;
  }
  return { text: joinArgs(parts), end };
}

/**
 * Every python test function, with the skip decorators that apply to it: its
 * own, then those of the classes it is nested in. `markerLine` is the first
 * own decorator, else the def itself (a class's skip is shared by its methods,
 * so the def keeps each method's marker distinct).
 */
export function pyDeclarations(source) {
  const lines = source.split('\n');
  const out = [];
  let stack = [];
  let classes = [];
  for (let i = 0; i < lines.length; i += 1) {
    const text = lines[i];
    if (!pyLine(text).code.trim()) continue;
    const indent = indentOf(text);
    classes = classes.filter((c) => indent > c.indent);
    if (/^\s*@/.test(text)) {
      const d = decoratorAt(lines, i);
      stack.push({ line: i + 1, text: d.text });
      i = d.end;
      continue;
    }
    const def = PY_DEF.exec(text);
    if (def) {
      out.push({
        callee: 'def',
        title: def[2],
        line: i + 1,
        markerLine: stack.length ? stack[0].line : i + 1,
        decorators: [...skipsOf(stack), ...classes.flatMap((c) => c.skips)],
      });
    } else if (PY_CLASS.test(text)) {
      classes.push({ indent, skips: skipsOf(stack) });
    }
    stack = [];
  }
  return out;
}

/** Does a module-level `pytestmark` skip or xfail some of this file's tests? */
export const skipsModule = (source) => PYTESTMARK.test(source);
