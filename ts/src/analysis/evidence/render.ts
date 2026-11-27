/** Renders the evidence pack for a reviewer who reads it cold, and writes both files (#855). */

import { mkdirSync, writeFileSync } from 'node:fs';

import { errnoCode, gateOutcome } from '../../core/gate-result.js';
import type { EvidencePack, Outcome } from './types.js';

/** Items listed per source (D11); the JSON carries all of them. */
const ITEM_CAP = 25;

const ANSI =
  /\u001B(\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001B]*(\u0007|\u001B\\)?|.)/g;
const SYNTAX = /[&<>\\`*_[\]|!~@]|:(?=\/\/)|(?<=www)\./gi;
const COMMIT_URL =
  /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/commit\/[0-9a-f]{40}([0-9a-f]{24})?$/;

/**
 * Source text is untrusted, and auditors and agents read the pack. Every value
 * a source supplied goes through one of these three: `plain` for a terminal
 * (one line, no control or ANSI sequence, clamped), `md` for Markdown text
 * (syntax characters become entities, so nothing is markup, a link or a cell
 * break), `code` for a code span (a backtick cannot close it).
 */
export const plain = (text: string, max = 400): string =>
  text
    .replace(ANSI, '')
    .replace(/[\u0000-\u001F\u007F-\u009F]+/g, ' ')
    .slice(0, max);
const md = (text: string): string =>
  plain(text).replace(SYNTAX, (c) => `&#${c.charCodeAt(0)};`);
const code = (text: string): string => `\`${plain(text).replace(/`/g, "'")}\``;

function table(head: string[], rows: string[][]): string[] {
  const line = (cells: string[]): string => `| ${cells.join(' | ')} |`;
  return [line(head), line(head.map(() => '---')), ...rows.map(line), ''];
}

function sourcesTable(pack: EvidencePack): string[] {
  const rows = pack.sources.map((s) => [
    `${s.id} (${md(s.path)})`,
    s.state,
    String(s.read),
    String(s.inWindow),
    md(s.reason ?? ''),
  ]);
  const head = ['Source', 'State', 'Records read', 'Items in window', 'Reason'];
  return table(head, rows);
}

function controlsTable(pack: EvidencePack): string[] {
  const stateOf = (id: string): string => {
    const s = pack.sources.find((source) => source.id === id);
    return `${id}: ${s?.state ?? 'not read'} (${s?.inWindow ?? 0})`;
  };
  const rows = pack.controls.map((c) => [
    md(c.id),
    md(`${c.framework}, ${c.reference}`),
    md(c.supports),
    c.status === 'evidence' ? `${c.items} item(s)` : 'NO EVIDENCE',
    c.sources.map(stateOf).join(', '),
  ]);
  const head = ['Control', 'Reference', 'Supports', 'Evidence', 'Sources'];
  return table(head, rows);
}

function sourceSection(pack: EvidencePack, id: string): string[] {
  const items = pack.items.filter((item) => item.source === id);
  if (items.length === 0)
    return [`### ${id}`, '', 'No items in the window.', ''];
  const shown = items.slice(0, ITEM_CAP).map((item) => {
    const { kind, id: refId, commit, url } = item.ref;
    const sha = commit === undefined ? '' : `, commit ${code(commit)}`;
    const linked = url !== undefined && COMMIT_URL.test(url);
    const link = linked ? ` ([commit](${url}))` : '';
    return `- ${md(item.at)}: ${md(item.summary)} (${kind} ${code(refId)}${sha})${link}`;
  });
  const more = items.length - shown.length;
  const tail =
    more > 0 ? [`${more} more item(s) are in evidence-pack.json.`, ''] : [];
  return [`### ${id}`, '', ...shown, '', ...tail];
}

export function renderMarkdown(pack: EvidencePack): string {
  const { since, until } = pack.window;
  const lines = [
    `# Audit evidence pack\n\n- Window: ${md(since)} up to, not including, ${md(until)}`,
    `- Generated: ${md(pack.generated_at)}\n- Commit: ${md(pack.commit ?? 'not resolved')}`,
    `\n> ${pack.disclaimer}\n\n## Sources\n`,
    ...sourcesTable(pack),
    '## Controls\n',
    ...controlsTable(pack),
    '## Evidence by source\n',
    ...pack.sources.flatMap((s) => sourceSection(pack, s.id)),
  ];
  return `${lines.join('\n').trimEnd()}\n`;
}

/** Stdout: every control, every source that is not `read`, and a warning when nothing was found (D8). */
function summaryLines(pack: EvidencePack): string[] {
  const lines = pack.controls.map((c) => {
    const n = c.status === 'evidence' ? `evidence: ${c.items}` : 'NO EVIDENCE';
    return `${c.id}  ${n}`;
  });
  const dark = pack.sources.filter((s) => s.state !== 'read');
  lines.push(...dark.map((s) => `source ${s.id}: ${s.state} (${s.reason})`));
  if (pack.items.length > 0) return lines;
  const { summaryLine } = gateOutcome({ checked: 0, findings: [] }, 'advisory');
  const cause = pack.sources.map((s) => `${s.id} ${s.state}`).join(', ');
  const step = 'record a run with `canary history record`, or widen --since';
  const why = `No source produced an item in the window (${cause})`;
  return [...lines, `${summaryLine} ${why}. First step: ${step}.`];
}

export function writePack(out: string, pack: EvidencePack): Outcome {
  const json = `${out}/evidence-pack.json`;
  const file = `${out}/evidence-pack.md`;
  try {
    mkdirSync(out, { recursive: true });
    writeFileSync(json, `${JSON.stringify(pack, null, 2)}\n`);
    writeFileSync(file, renderMarkdown(pack));
  } catch (err) {
    const code = errnoCode(err);
    if (code === null) throw err;
    const line = `evidence: cannot write the pack to ${out} (${code})`;
    return { exit: 1, lines: [plain(line)] };
  }
  const lines = [...summaryLines(pack), `Wrote ${json}`, `Wrote ${file}`];
  return { exit: 0, lines: lines.map((line) => plain(line)) };
}
