// render -- Markdown renderer for Playwright test results (self-contained,
// pure). Ported behavior-for-behavior from the Python original.
//
// Output glyphs are kept as \u escapes so the source stays ASCII while the
// emitted Markdown bytes are byte-identical to the Python original:
//   MIDDOT   U+00B7 MIDDLE DOT         -- status-line separator
//   ELLIPSIS U+2026 HORIZONTAL ELLIPSIS -- error-truncation marker
//   EMDASH   U+2014 EM DASH            -- flaky-line separator
const MIDDOT = '\u00b7';
const ELLIPSIS = '\u2026';
const EMDASH = '\u2014';

const ERROR_LINE_LIMIT = 10;

// Reproduce Python str.splitlines(): it splits on \n, \r, \r\n, \v, \f, and the
// \x1c-\x1e / \x85 / \u2028 / \u2029 boundaries, and yields NO trailing empty
// element for a trailing boundary. A naive "a\n".split("\n") would add a
// spurious blank line inside the fenced error block, so match splitlines.
function splitlines(s) {
  const re = /\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/g;
  const parts = [];
  let last = 0;
  let m;
  while ((m = re.exec(s)) !== null) {
    parts.push(s.slice(last, m.index));
    last = m.index + m[0].length;
  }
  if (last < s.length) parts.push(s.slice(last));
  return parts;
}

// Match Python's f"{ms/1000:.1f}" byte-for-byte, including round-half-to-EVEN
// on exact ties. JS `(ms/1000).toFixed(1)` rounds half-UP, so it diverges
// wherever ms/1000 lands on an exactly-representable .5-tenths tie -- which for
// integer milliseconds is precisely ms == 250 (mod 500) (x.25 / x.75, the only
// dyadic half-tenths): 250ms -> Python "0.2s" vs toFixed "0.3s". At those ties
// the two candidate tenths are floor(ms/100) and +1; Python picks the even one.
// Non-tie values are not exact halves, so toFixed already rounds them to the
// same nearest tenth Python does. Assumes the integer-ms contract (a fractional
// duration is rounded by toFixed, matching Python for all non-tie inputs).
function formatDurationSeconds(ms) {
  if (ms % 500 === 250) {
    const lowerTenths = Math.floor(ms / 100);
    const tenths = lowerTenths % 2 === 0 ? lowerTenths : lowerTenths + 1;
    return (tenths / 10).toFixed(1);
  }
  return (ms / 1000).toFixed(1);
}

function formatLocation(r) {
  if (!r.file) return '';
  return r.line ? '`' + r.file + ':' + r.line + '`' : '`' + r.file + '`';
}

/** Render a ReportData to the themed Markdown report. */
export function renderMarkdown(data) {
  const parts = ['# Test Report\n\n'];

  // Status line, e.g.:
  //   **2 failed** <MIDDOT> **1 flaky** <MIDDOT> **14 passed** <MIDDOT>
  //   **1 skipped** <MIDDOT> 18 tests <MIDDOT> 12.4s
  const chips = [];
  if (data.failed) chips.push(`**${data.failed} failed**`);
  if (data.flaky) chips.push(`**${data.flaky} flaky**`);
  if (data.passed) chips.push(`**${data.passed} passed**`);
  if (data.skipped) chips.push(`**${data.skipped} skipped**`);
  const durationS = formatDurationSeconds(data.duration_ms);
  let statusLine = `${data.total} tests ${MIDDOT} ${durationS}s\n`;
  if (chips.length) {
    statusLine = chips.join(` ${MIDDOT} `) + ` ${MIDDOT} ` + statusLine;
  }
  parts.push(statusLine);

  // Failed section
  const failed = data.results.filter((r) => r.status === 'failed');
  if (failed.length) {
    parts.push(`\n## Failed (${failed.length})\n`);
    for (const r of failed) {
      parts.push(`\n### ${r.title}\n`);
      const loc = formatLocation(r);
      if (loc) parts.push(`\n${loc}\n`);
      if (r.error) {
        let lines = splitlines(r.error);
        if (lines.length > ERROR_LINE_LIMIT) {
          lines = lines
            .slice(0, ERROR_LINE_LIMIT)
            .concat([`${ELLIPSIS} (truncated)`]);
        }
        parts.push(`\n\`\`\`\n${lines.join('\n')}\n\`\`\`\n`);
      }
    }
  }

  // Flaky section
  const flaky = data.results.filter((r) => r.status === 'flaky');
  if (flaky.length) {
    parts.push(`\n## Flaky (${flaky.length})\n`);
    for (const r of flaky) {
      const loc = formatLocation(r);
      parts.push(`\n- ${loc ? loc + ` ${EMDASH} ` : ''}${r.title}\n`);
    }
  }

  // Summary table
  parts.push('\n## Summary\n');
  parts.push('\n| Status | Count |\n| --- | --- |\n');
  parts.push(`| Passed | ${data.passed} |\n`);
  parts.push(`| Failed | ${data.failed} |\n`);
  parts.push(`| Flaky | ${data.flaky} |\n`);
  parts.push(`| Skipped | ${data.skipped} |\n`);
  parts.push(`| **Total** | **${data.total}** |\n`);

  return parts.join('');
}
