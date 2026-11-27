/**
 * canary-harley (#616) -- proposal assembly and its two renderers. Cases are
 * tagged with the spec's success criteria
 * (docs/changes/616-canary-harley/proposal.md). Fixtures are synthetic.
 */
import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { BOUNDARY } from '../claude-code/canary-harley/scripts/cues.mjs';
import {
  buildProposal,
  renderJson,
  renderMarkdown,
} from '../claude-code/canary-harley/scripts/proposal.mjs';

const CODEC_TS = `export function encodeToken(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}
export function decodeToken(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}
export function normalizeSlug(value: string): string {
  return value.trim().toLowerCase();
}
export const isSlug = (value: string): boolean => /^[a-z0-9-]+$/.test(value);
export function mergeCounts(a: number[], b: number[]): number[] {
  return a.map((n, i) => n + (b[i] ?? 0));
}
export function sortScores(values: number[]): number[] {
  return [...values].sort((x, y) => x - y);
}
export function scoreWidget(widget: Widget): number {
  return widget.weight;
}
function clampLevel(level: number): number {
  return Math.max(0, level);
}
`;

const CODEC_NAMES_TS = [
  'encodeToken',
  'decodeToken',
  'normalizeSlug',
  'mergeCounts',
  'sortScores',
  'scoreWidget',
  'clampLevel',
  'isSlug',
];

const CRUD_UI_TS = `export function createWidget(name: string): string {
  return name;
}
export function renderBadge(label: string): string {
  return label;
}
`;

type Candidate = {
  id: string;
  kind: string;
  functions: string[];
  statement: string;
  score: number;
  tier: string;
  failsWhen: string;
  emittable: boolean;
  blocked: string[];
};

type Proposal = {
  schema: string;
  source: { path: string; sha256: string };
  functions: string[];
  signatures: { name: string }[];
  skipped: { name: string; reason: string }[];
  candidates: Candidate[];
  boundary: string;
  abstained: string | null;
  capped: boolean;
};

const build = (input: {
  path?: string;
  source?: string;
  names?: string[];
  only?: string;
}) =>
  buildProposal({
    path: 'src/codec.ts',
    source: CODEC_TS,
    names: CODEC_NAMES_TS,
    ...input,
  }) as Proposal;

describe('canary-harley proposal: buildProposal', () => {
  it('assembles the proposal for the codec fixture', () => {
    const proposal = build({});
    expect(Object.keys(proposal)).toEqual([
      'schema',
      'source',
      'functions',
      'signatures',
      'skipped',
      'candidates',
      'boundary',
      'abstained',
      'capped',
    ]);
    expect(proposal.schema).toBe('canary.harley-proposal/1');
    expect(proposal.source).toEqual({
      path: 'src/codec.ts',
      sha256: createHash('sha256').update(CODEC_TS).digest('hex'),
    });
    expect(proposal.functions).toEqual(CODEC_NAMES_TS);
    expect(proposal.signatures).toHaveLength(8);
    expect(proposal.skipped).toEqual([]);
    expect(proposal.candidates[0].kind).toBe('round-trip');
    expect(proposal.boundary).toBe(BOUNDARY);
    expect(proposal.abstained).toBeNull();
    expect(proposal.capped).toBe(false);
  });

  it('builds the same proposal twice (SC2)', () => {
    expect(build({})).toEqual(build({}));
  });

  it('skips CRUD- and UI-shaped names before reading them (SC7)', () => {
    const proposal = build({
      source: CODEC_TS + CRUD_UI_TS,
      names: [...CODEC_NAMES_TS, 'createWidget', 'renderBadge'],
    });
    expect(proposal.skipped).toEqual([
      { name: 'createWidget', reason: 'CRUD-shaped by name (create)' },
      { name: 'renderBadge', reason: 'UI-shaped by name (render)' },
    ]);
    expect(proposal.signatures.map((sig) => sig.name)).toEqual(CODEC_NAMES_TS);
    expect(proposal.functions).toHaveLength(10);
    expect(proposal.abstained).toBeNull();
    expect(
      proposal.candidates.flatMap((candidate) => candidate.functions),
    ).not.toContain('createWidget');
  });

  it('lists a reader skip after the boundary skips', () => {
    const proposal = build({
      source: `${CRUD_UI_TS}export async function hashLater(t: string) {}\n`,
      names: ['createWidget', 'hashLater', 'renderBadge'],
    });
    expect(proposal.skipped.map((skip) => skip.name)).toEqual([
      'createWidget',
      'renderBadge',
      'hashLater',
    ]);
    expect(proposal.skipped[2].reason).toBe('async function');
  });

  it('abstains when the file holds no functions (SC7)', () => {
    const proposal = build({ source: 'export const LIMIT = 3;\n', names: [] });
    expect(proposal.abstained).toContain('no functions');
    expect(proposal.candidates).toEqual([]);
  });

  it('abstains on only CRUD- or UI-shaped functions (SC7)', () => {
    const proposal = build({
      source: CRUD_UI_TS,
      names: ['createWidget', 'renderBadge'],
    });
    expect(proposal.abstained).toContain('only CRUD- or UI-shaped functions');
    expect(proposal.skipped).toHaveLength(2);
    expect(proposal.signatures).toEqual([]);
  });

  it('abstains when no function yields a candidate (SC7)', () => {
    const proposal = build({
      source: 'export function now(): number {\n  return 0;\n}\n',
      names: ['now'],
    });
    expect(proposal.abstained).toContain('no candidates');
    expect(proposal.signatures).toHaveLength(1);
  });

  it('abstains on a file type it does not read', () => {
    const proposal = build({
      path: 'notes.rb',
      source: 'def encode(text)\nend\n',
      names: [],
    });
    expect(proposal.abstained).toContain('unsupported file type');
    expect(proposal.abstained).toContain('notes.rb');
    expect(proposal.signatures).toEqual([]);
  });

  it('keeps only the candidates of the function asked for', () => {
    const proposal = build({ only: 'normalizeSlug' });
    expect(proposal.candidates.length).toBeGreaterThan(0);
    expect(
      proposal.candidates.every((candidate) =>
        candidate.functions.includes('normalizeSlug'),
      ),
    ).toBe(true);
    expect(proposal.abstained).toBeNull();
    expect(proposal.functions).toEqual(CODEC_NAMES_TS);
  });

  it('keeps a pair candidate when either function is asked for', () => {
    const kinds = build({ only: 'decodeToken' }).candidates.map(
      (candidate) => candidate.kind,
    );
    expect(kinds).toEqual(['round-trip', 'determinism']);
  });

  it('abstains when the function asked for is not in the file', () => {
    const proposal = build({ only: 'missing' });
    expect(proposal.abstained).toContain("no function named 'missing'");
    expect(proposal.candidates).toEqual([]);
  });

  it('abstains when the function asked for yields no candidate', () => {
    const proposal = build({
      source: `${CODEC_TS}export function now(): number {}\n`,
      names: [...CODEC_NAMES_TS, 'now'],
      only: 'now',
    });
    expect(proposal.abstained).toContain('no candidates');
    expect(proposal.abstained).toContain("'now'");
  });

  it('marks the list as capped at 20 names (A10)', () => {
    const names = Array.from({ length: 20 }, (_item, index) => `tidy${index}`);
    const source = names
      .map((name) => `export function ${name}(v: string): string {}\n`)
      .join('');
    expect(build({ source, names }).capped).toBe(true);
    expect(build({ source, names: names.slice(0, 19) }).capped).toBe(false);
  });

  it('reads a Python source by its extension', () => {
    const proposal = build({
      path: 'src/codec.py',
      source: 'def encode_token(text: str) -> bytes:\n    return b""\n',
      names: ['encode_token'],
    });
    expect(proposal.abstained).toBeNull();
    expect(proposal.candidates.map((candidate) => candidate.kind)).toEqual([
      'determinism',
    ]);
  });
});

describe('canary-harley proposal: renderJson', () => {
  it('round-trips the proposal and ends with a newline', () => {
    const proposal = build({});
    const text = renderJson(proposal);
    expect(JSON.parse(text)).toEqual(proposal);
    expect(text.endsWith('}\n')).toBe(true);
    expect(text).toContain('\n  "schema": "canary.harley-proposal/1"');
  });

  it('renders the same bytes twice (SC2)', () => {
    expect(renderJson(build({}))).toBe(renderJson(build({})));
  });
});

/** The numbered candidate lines of a rendered proposal, in order. */
const numbered = (text: string) =>
  text.split('\n').filter((line) => /^\d+\. /.test(line));

describe('canary-harley proposal: renderMarkdown', () => {
  const withSkips = () =>
    build({
      source: CODEC_TS + CRUD_UI_TS,
      names: [...CODEC_NAMES_TS, 'createWidget', 'renderBadge'],
    });

  it('opens with the source path and the facts read from it', () => {
    const proposal = withSkips();
    const text = renderMarkdown(proposal);
    expect(text.split('\n')[0]).toBe('# canary-harley proposal: src/codec.ts');
    expect(text).toContain(`sha256: ${proposal.source.sha256}`);
    expect(text).toContain('functions seen: 10');
    expect(text).toContain('signatures read: 8');
    expect(text).toContain('skipped: 2');
    expect(text).toContain(BOUNDARY);
    expect(text).toContain('heuristic');
  });

  it('numbers the candidates in rank order with tier and score', () => {
    const proposal = build({});
    const lines = numbered(renderMarkdown(proposal));
    expect(lines).toHaveLength(proposal.candidates.length);
    expect(lines).toEqual(
      proposal.candidates.map(
        (candidate, index) =>
          `${index + 1}. [${candidate.tier} ${candidate.score.toFixed(2)}] ` +
          `${candidate.kind}: ${candidate.statement}`,
      ),
    );
    expect(lines[0]).toBe(
      '1. [likely 0.90] round-trip: decodeToken(encodeToken(x)) equals x',
    );
  });

  it('prints id, evidence, fails-when and emittable per candidate', () => {
    const proposal = build({});
    const text = renderMarkdown(proposal);
    const first = proposal.candidates[0];
    expect(text).toContain(`   - id: ${first.id}\n`);
    expect(text).toContain(
      '   - evidence: shape: encodeToken(string) -> bytes; ' +
        'decodeToken(bytes) -> string; name cue: encode/decode\n',
    );
    expect(text).toContain(`   - fails when: ${first.failsWhen}\n`);
    expect(text).toContain('   - emittable: yes\n');
    const count = (needle: string) => text.split(needle).length - 1;
    expect(count('   - id: ')).toBe(proposal.candidates.length);
    expect(count('   - emittable: ')).toBe(proposal.candidates.length);
  });

  it('names the type that blocks a candidate (SC3)', () => {
    const text = renderMarkdown(build({ only: 'scoreWidget' }));
    expect(text).toContain(
      "   - emittable: no (scoreWidget: parameter widget has type 'Widget' " +
        '(named type))\n',
    );
    expect(text).not.toContain('emittable: yes');
  });

  it('lists the skipped functions with their reasons', () => {
    const text = renderMarkdown(withSkips());
    expect(text).toContain('- createWidget: CRUD-shaped by name (create)\n');
    expect(text).toContain('- renderBadge: UI-shaped by name (render)\n');
    expect(renderMarkdown(build({}))).not.toContain('## Skipped');
  });

  it('ends by saying nothing was generated and how to confirm', () => {
    const lines = renderMarkdown(build({})).trimEnd().split('\n');
    expect(lines.at(-1)).toContain(
      'canary-harley emit src/codec.ts --confirm <id>[,<id>...]',
    );
    expect(lines.slice(-4).join('\n')).toContain('Nothing was generated');
  });

  it('says the function list may be cut short when capped (A10)', () => {
    const names = Array.from({ length: 20 }, (_item, index) => `tidy${index}`);
    const source = names
      .map((name) => `export function ${name}(v: string): string {}\n`)
      .join('');
    const capped = renderMarkdown(build({ source, names }));
    expect(capped).toContain('may be cut short at 20');
    expect(renderMarkdown(build({}))).not.toContain('cut short');
  });

  it('prints the reason and no candidate list when abstained (SC7)', () => {
    const proposal = build({
      source: CRUD_UI_TS,
      names: ['createWidget', 'renderBadge'],
    });
    const text = renderMarkdown(proposal);
    expect(text).toContain(`Abstained: ${proposal.abstained}`);
    expect(text).not.toContain('## Candidates');
    expect(numbered(text)).toEqual([]);
    expect(text).not.toContain('--confirm');
    expect(text).toContain('Nothing was generated');
    expect(text).toContain('- createWidget: CRUD-shaped by name (create)\n');
  });

  it('is ASCII, ends with one newline and is byte-identical twice (SC2)', () => {
    const text = renderMarkdown(withSkips());
    expect(text).toMatch(/^[\t\n\r\x20-\x7E]*$/);
    expect(text.endsWith('\n')).toBe(true);
    expect(text.endsWith('\n\n')).toBe(false);
    expect(renderMarkdown(withSkips())).toBe(text);
  });
});
