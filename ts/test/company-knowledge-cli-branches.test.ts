/**
 * Branch coverage for the `canary company-knowledge` sub-app (#481).
 *
 * `show` renders one optional block per configured field and `init` writes one
 * optional key per answered prompt — a long ladder of independent `if`s that the
 * existing suite only ever walked with an empty config. These tests drive the
 * FULL ladder (every block present, then every block absent) and the init
 * wizard's answered / skipped / gitignore paths, asserting on the rendered text
 * and the written JSON rather than merely reaching the lines.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { CompanyKnowledge } from '../src/core/company-knowledge.js';
import { invokeCanary } from './canary-cli-testkit.js';

/** An empty, isolated home so the `~/.canary/company.json` tier never loads. */
const HOME = mkdtempSync(join(tmpdir(), 'canary-ck-cli-home-'));

function mkTmp(): string {
  return mkdtempSync(join(tmpdir(), 'canary-ck-cli-'));
}

function writeCompanyJson(root: string, data: unknown): void {
  mkdirSync(join(root, '.canary'), { recursive: true });
  writeFileSync(
    join(root, '.canary', 'company.json'),
    JSON.stringify(data),
    'utf-8',
  );
}

/** Run `company-knowledge show` against a config written at `root`. */
async function show(root: string, args: string[] = []) {
  return invokeCanary(['company-knowledge', ...args], {
    deps: {
      loadCompanyKnowledge: (env) => CompanyKnowledge.load(root, env, HOME),
    },
  });
}

const FULL_CONFIG = {
  confluence_spaces: ['QA', 'ENG'],
  jira_projects: ['PROJ'],
  internal_doc_urls: [
    'https://docs.example.com/a',
    'https://docs.example.com/b',
  ],
  internal_domains: ['corp.example.com'],
  mcp_servers: ['plugin_atlassian_atlassian'],
  claude_code_skills: ['team:skill-name'],
  dashboard_url: 'https://dash.example.com',
  otel_exporter_endpoint: 'https://otel.example.com',
  notes: 'ask the QA channel first',
  brand: { company_name: 'Acme Corp', primary_color: '#112233' },
};

describe('company-knowledge show (every block populated)', () => {
  it('renders each configured field in its own labelled block', async () => {
    const tmp = mkTmp();
    try {
      writeCompanyJson(tmp, FULL_CONFIG);
      const res = await show(tmp, ['show']);
      expect(res.code).toBe(0);
      expect(res.stdout).toContain('Company Knowledge');
      expect(res.stdout).toContain('sources: .canary/company.json');
      expect(res.stdout).toContain('Confluence spaces: QA, ENG');
      expect(res.stdout).toContain('Jira projects:     PROJ');
      expect(res.stdout).toContain('Reference docs:');
      expect(res.stdout).toContain('  https://docs.example.com/a');
      expect(res.stdout).toContain('  https://docs.example.com/b');
      expect(res.stdout).toContain('Internal domains:  corp.example.com');
      expect(res.stdout).toContain(
        'MCP servers:       plugin_atlassian_atlassian',
      );
      expect(res.stdout).toContain('Claude Code skills: team:skill-name');
      expect(res.stdout).toContain(
        'Dashboard URL:     https://dash.example.com',
      );
      expect(res.stdout).toContain(
        'OTel endpoint:     https://otel.example.com',
      );
      expect(res.stdout).toContain('Notes: ask the QA channel first');
      expect(res.stdout).toContain('Brand:            Acme Corp');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('omits every block a config does not set', async () => {
    const tmp = mkTmp();
    try {
      writeCompanyJson(tmp, { confluence_spaces: ['QA'] });
      const res = await show(tmp, ['show']);
      expect(res.stdout).toContain('Confluence spaces: QA');
      for (const label of [
        'Jira projects:',
        'Reference docs:',
        'Internal domains:',
        'MCP servers:',
        'Claude Code skills:',
        'Dashboard URL:',
        'OTel endpoint:',
        'Notes:',
        'Brand:',
      ]) {
        expect(res.stdout).not.toContain(label);
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('labels an unnamed brand rather than printing an empty label', async () => {
    const tmp = mkTmp();
    try {
      writeCompanyJson(tmp, { brand: { primary_color: '#445566' } });
      const res = await show(tmp, ['show']);
      expect(res.stdout).toContain('Brand:');
      expect(res.stdout).toContain('(unnamed)');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('surfaces validation warnings after the rendered config', async () => {
    const tmp = mkTmp();
    try {
      // `internal_doc_urls` entries must be URLs; a bare token is dropped with
      // a warning rather than silently accepted.
      writeCompanyJson(tmp, {
        confluence_spaces: ['QA'],
        internal_doc_urls: ['not-a-url'],
      });
      const res = await show(tmp, ['show']);
      expect(res.code).toBe(0);
      expect(res.stdout).toContain('internal_doc_urls');
      expect(res.stdout).toContain('not-a-url');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('reports "no sources" wording when nothing is configured', async () => {
    const tmp = mkTmp();
    try {
      const res = await show(tmp, ['show']);
      expect(res.code).toBe(0);
      expect(res.stdout).toContain('No company knowledge configured.');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('--json emits the merged config as a parseable object', async () => {
    const tmp = mkTmp();
    try {
      writeCompanyJson(tmp, FULL_CONFIG);
      const res = await show(tmp, ['show', '--json']);
      const obj = JSON.parse(res.stdout) as Record<string, unknown>;
      expect(obj['jira_projects']).toEqual(['PROJ']);
      expect(obj['notes']).toBe('ask the QA channel first');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

/** Drive `company-knowledge init` with a scripted prompt queue. */
async function initWith(
  cwd: string,
  answers: string[],
  args: string[] = [],
): Promise<{ code: number; stdout: string; written: Record<string, unknown> }> {
  let i = 0;
  const res = await invokeCanary(['company-knowledge', 'init', ...args], {
    deps: {
      cwd: () => cwd,
      home: () => HOME,
      prompt: (_text: string, def: string) =>
        i < answers.length ? answers[i++]! : def,
    },
  });
  const outPath = join(cwd, '.canary', 'company.json');
  const written = existsSync(outPath)
    ? (JSON.parse(readFileSync(outPath, 'utf-8')) as Record<string, unknown>)
    : {};
  return { code: res.code, stdout: res.stdout, written };
}

// Prompt order in ckInitCmd: confluence, jira, then doc-URL loop (terminated by
// a blank answer), then domains, mcp, skills, notes, then 8 brand fields.
const ANSWERS_FULL = [
  'qa, eng',
  'proj',
  'https://docs.example.com/x',
  '', // ends the doc-URL loop
  'CORP.EXAMPLE.COM',
  'plugin_one, plugin_two',
  'Team:Skill-Name',
  'notes here',
  'Acme Corp',
  'assets/logo.svg',
  'https://cdn.example.com/logo.png',
  '#111111',
  '#222222',
  '#333333',
  '#444444',
  'Acme QA report',
];

describe('company-knowledge init', () => {
  it('normalises case per field and writes every answered key', async () => {
    const tmp = mkTmp();
    try {
      const { code, stdout, written } = await initWith(tmp, ANSWERS_FULL);
      expect(code).toBe(0);
      expect(stdout).toContain('Written to');
      expect(written['confluence_spaces']).toEqual(['QA', 'ENG']);
      expect(written['jira_projects']).toEqual(['PROJ']);
      expect(written['internal_doc_urls']).toEqual([
        'https://docs.example.com/x',
      ]);
      expect(written['internal_domains']).toEqual(['corp.example.com']);
      expect(written['mcp_servers']).toEqual(['plugin_one', 'plugin_two']);
      expect(written['claude_code_skills']).toEqual(['team:skill-name']);
      expect(written['notes']).toBe('notes here');
      expect(written['brand']).toMatchObject({
        company_name: 'Acme Corp',
        logo_path: 'assets/logo.svg',
        primary_color: '#111111',
        footer_note: 'Acme QA report',
      });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('omits keys entirely when every prompt is skipped', async () => {
    const tmp = mkTmp();
    try {
      const { code, written } = await initWith(tmp, []);
      expect(code).toBe(0);
      expect(written).toEqual({});
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('collects multiple doc URLs until a blank line ends the loop', async () => {
    const tmp = mkTmp();
    try {
      const { written } = await initWith(tmp, [
        '',
        '',
        'https://a.example.com',
        'https://b.example.com',
        '',
      ]);
      expect(written['internal_doc_urls']).toEqual([
        'https://a.example.com',
        'https://b.example.com',
      ]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('truncates notes to 2048 characters', async () => {
    const tmp = mkTmp();
    try {
      const long = 'x'.repeat(3000);
      const { written } = await initWith(tmp, ['', '', '', '', '', '', long]);
      expect((written['notes'] as string).length).toBe(2048);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('keeps existing values as the shown defaults and warns without --force', async () => {
    const tmp = mkTmp();
    try {
      writeCompanyJson(tmp, { jira_projects: ['KEEP'], notes: 'old note' });
      const { code, stdout, written } = await initWith(tmp, []);
      expect(code).toBe(0);
      expect(stdout).toContain('already exists');
      expect(stdout).toContain('--force');
      // Every prompt fell back to its default, so the existing config survives.
      expect(written['jira_projects']).toEqual(['KEEP']);
      expect(written['notes']).toBe('old note');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('--force suppresses the already-exists warning', async () => {
    const tmp = mkTmp();
    try {
      writeCompanyJson(tmp, { jira_projects: ['KEEP'] });
      const { stdout } = await initWith(tmp, [], ['--force']);
      expect(stdout).not.toContain('already exists');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('appends .canary/ to an existing .gitignore that lacks it', async () => {
    const tmp = mkTmp();
    try {
      const gitignore = join(tmp, '.gitignore');
      writeFileSync(gitignore, 'node_modules\n\n', 'utf-8');
      await initWith(tmp, []);
      expect(readFileSync(gitignore, 'utf-8')).toBe('node_modules\n.canary/\n');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('leaves a .gitignore that already ignores .canary/ untouched', async () => {
    const tmp = mkTmp();
    try {
      const gitignore = join(tmp, '.gitignore');
      writeFileSync(gitignore, 'node_modules\n.canary/\n', 'utf-8');
      await initWith(tmp, []);
      expect(readFileSync(gitignore, 'utf-8')).toBe('node_modules\n.canary/\n');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('does not create a .gitignore when the repo has none', async () => {
    const tmp = mkTmp();
    try {
      await initWith(tmp, []);
      expect(existsSync(join(tmp, '.gitignore'))).toBe(false);
      expect(existsSync(join(tmp, '.canary', 'company.json'))).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
