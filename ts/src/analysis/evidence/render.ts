/** Renders the evidence pack as Markdown for a reviewer who reads it cold (#855). Pure. */

import type { EvidencePack } from './types.js';

/** Items listed per source (D11); the JSON carries all of them. */
const ITEM_CAP = 25;

/** Source text is untrusted: keep it on one line and out of table syntax. */
const cell = (text: string): string =>
  text.replace(/[\u0000-\u001F\u007F]+/g, ' ').replace(/\|/g, '\\|');

function table(head: string[], rows: string[][]): string[] {
  const line = (cells: string[]): string => `| ${cells.join(' | ')} |`;
  return [line(head), line(head.map(() => '---')), ...rows.map(line), ''];
}

function sourcesTable(pack: EvidencePack): string[] {
  const rows = pack.sources.map((s) => [
    `${s.id} (${cell(s.path)})`,
    s.state,
    String(s.read),
    String(s.inWindow),
    cell(s.reason ?? ''),
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
    c.id,
    cell(`${c.framework}, ${c.reference}`),
    cell(c.supports),
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
    const sha = commit === undefined ? '' : `, commit \`${cell(commit)}\``;
    const link = url === undefined ? '' : ` ([commit](${url}))`;
    return `- ${item.at}: ${cell(item.summary)} (${kind} \`${cell(refId)}\`${sha})${link}`;
  });
  const more = items.length - shown.length;
  const tail =
    more > 0 ? [`${more} more item(s) are in evidence-pack.json.`, ''] : [];
  return [`### ${id}`, '', ...shown, '', ...tail];
}

export function renderMarkdown(pack: EvidencePack): string {
  const { since, until } = pack.window;
  const lines = [
    `# Audit evidence pack\n\n- Window: ${since} up to, not including, ${until}`,
    `- Generated: ${pack.generated_at}\n- Commit: ${pack.commit ?? 'not resolved'}`,
    `\n> ${pack.disclaimer}\n\n## Sources\n`,
    ...sourcesTable(pack),
    '## Controls\n',
    ...controlsTable(pack),
    '## Evidence by source\n',
    ...pack.sources.flatMap((s) => sourceSection(pack, s.id)),
  ];
  return `${lines.join('\n').trimEnd()}\n`;
}
