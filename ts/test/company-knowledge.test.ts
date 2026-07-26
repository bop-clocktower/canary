/**
 * Tests for the `company-knowledge` port (`agent/core/company_knowledge.py`).
 *
 * Ports `tests/unit/test_company_knowledge.py` and
 * `tests/unit/test_report_branding.py`. Every Python case is preserved.
 *
 * Python patches `Path.home()` to isolate the org-wide tier; this port injects
 * an empty temp `home` into `CompanyKnowledge.load` so the home layer is always
 * absent, matching the assumption those tests make about the runner's home.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Brand, CompanyKnowledge } from '../src/core/company-knowledge.js';

// Empty, isolated home so the `~/.canary/company.json` tier never contributes.
const HOME = mkdtempSync(join(tmpdir(), 'canary-ck-home-'));
afterAll(() => rmSync(HOME, { recursive: true, force: true }));

function mkTmp(): string {
  return mkdtempSync(join(tmpdir(), 'canary-ck-'));
}

function writeCompanyJson(
  tmp: string,
  data: unknown,
  name = 'company.json',
): void {
  const canaryDir = join(tmp, '.canary');
  mkdirSync(canaryDir, { recursive: true });
  writeFileSync(join(canaryDir, name), JSON.stringify(data), 'utf-8');
}

function load(root: string, env?: string | null): CompanyKnowledge {
  return CompanyKnowledge.load(root, env ?? null, HOME);
}

function loadData(data: unknown): CompanyKnowledge {
  const tmp = mkTmp();
  try {
    writeCompanyJson(tmp, data);
    return load(tmp);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// -- load / missing file ------------------------------------------------------

describe('TestLoadMissingFile', () => {
  it('returns empty when file absent', () => {
    const tmp = mkTmp();
    try {
      const ck = load(tmp);
      expect(ck.isEmpty).toBe(true);
      expect(ck.error).toBe('');
      expect(ck.warnings).toEqual([]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('is_empty true on all empty fields', () => {
    expect(new CompanyKnowledge().isEmpty).toBe(true);
  });
});

// -- malformed json -----------------------------------------------------------

describe('TestLoadMalformedJson', () => {
  it('returns empty on malformed json', () => {
    const tmp = mkTmp();
    try {
      const canaryDir = join(tmp, '.canary');
      mkdirSync(canaryDir);
      writeFileSync(
        join(canaryDir, 'company.json'),
        '{not valid json',
        'utf-8',
      );
      const ck = load(tmp);
      expect(ck.isEmpty).toBe(true);
      expect(ck.error).toBeTruthy();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('returns empty on non-object root', () => {
    const ck = loadData([]);
    expect(ck.isEmpty).toBe(true);
  });

  // Regression (adversarial review #2): a file whose entire content is the bare
  // literal `null` is present-but-not-an-object. Python's raw json.loads path
  // sets "expected JSON object at root"; the shared reader collapses absent and
  // `null` to the same [null, null], so the port re-derives the split via an
  // existence check. `null` must set an error, not silently skip.
  it('sets an error on a bare null root (present but not an object)', () => {
    const ck = loadData(null);
    expect(ck.isEmpty).toBe(true);
    expect(ck.error).toContain('expected JSON object at root');
  });
});

// -- valid file ---------------------------------------------------------------

describe('TestLoadValidFile', () => {
  let ck: CompanyKnowledge;
  let tmp: string;
  beforeEach(() => {
    tmp = mkTmp();
    writeCompanyJson(tmp, {
      confluence_spaces: ['QA', 'ENG', 'ACME'],
      jira_projects: ['ORACLE', 'ACME'],
      internal_doc_urls: [
        'https://wiki.example.com/wiki/spaces/QA/pages/1/Test-Conventions',
      ],
      internal_domains: ['corp.example.com', 'engage.example.com'],
      mcp_servers: ['plugin_atlassian_atlassian'],
      claude_code_skills: ['team:ui', 'team:vulcan'],
      notes: 'Use idiomatic Playwright helpers.',
    });
    ck = load(tmp);
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it('is not empty', () => expect(ck.isEmpty).toBe(false));
  it('confluence spaces loaded', () =>
    expect(ck.confluence_spaces).toEqual(['QA', 'ENG', 'ACME']));
  it('jira projects loaded', () =>
    expect(ck.jira_projects).toEqual(['ORACLE', 'ACME']));
  it('internal doc urls loaded', () => {
    expect(ck.internal_doc_urls.length).toBe(1);
    expect(ck.internal_doc_urls[0]).toContain('wiki.example.com');
  });
  it('internal domains loaded', () =>
    expect(ck.internal_domains).toContain('corp.example.com'));
  it('mcp servers loaded', () =>
    expect(ck.mcp_servers).toEqual(['plugin_atlassian_atlassian']));
  it('claude code skills loaded', () =>
    expect(ck.claude_code_skills).toContain('team:ui'));
  it('notes loaded', () => expect(ck.notes).toContain('Playwright'));
  it('no error', () => expect(ck.error).toBe(''));
});

// -- field validation ---------------------------------------------------------

describe('TestFieldValidation', () => {
  it('confluence spaces uppercased', () =>
    expect(
      loadData({ confluence_spaces: ['qa', 'eng'] }).confluence_spaces,
    ).toEqual(['QA', 'ENG']));
  it('confluence spaces deduped', () =>
    expect(
      loadData({ confluence_spaces: ['QA', 'QA', 'ENG'] }).confluence_spaces,
    ).toEqual(['QA', 'ENG']));
  it('confluence spaces invalid dropped', () => {
    const ck = loadData({ confluence_spaces: ['QA', 'has space', 'VALID'] });
    expect(ck.confluence_spaces).not.toContain('has space');
    expect(ck.confluence_spaces).toContain('QA');
  });
  it('internal domains lowercased', () =>
    expect(
      loadData({ internal_domains: ['CORP.EXAMPLE.COM'] }).internal_domains,
    ).toEqual(['corp.example.com']));
  it('internal doc urls invalid scheme dropped', () =>
    expect(
      loadData({ internal_doc_urls: ['ftp://bad.example.com/page'] })
        .internal_doc_urls,
    ).toEqual([]));
  it('internal doc urls http accepted', () =>
    expect(
      loadData({ internal_doc_urls: ['http://internal.example.com/page'] })
        .internal_doc_urls.length,
    ).toBe(1));
  // Regression (adversarial review #5): Python's urlsplit strips leading
  // C0-control/space bytes before parsing, so a URL with accidental leading
  // whitespace is a valid http URL and is accepted -- not dropped.
  it('internal doc url with leading whitespace is accepted (urlsplit front-strip)', () =>
    expect(
      loadData({ internal_doc_urls: [' http://internal.example.com/page'] })
        .internal_doc_urls.length,
    ).toBe(1));
  it('mcp server invalid chars dropped', () => {
    const ck = loadData({ mcp_servers: ['valid_server', 'bad server!'] });
    expect(ck.mcp_servers).toContain('valid_server');
    expect(ck.mcp_servers).not.toContain('bad server!');
  });
  it('skill bare slug accepted', () =>
    expect(
      loadData({ claude_code_skills: ['verify'] }).claude_code_skills,
    ).toContain('verify'));
  it('skill scoped slug accepted', () =>
    expect(
      loadData({ claude_code_skills: ['team:ui'] }).claude_code_skills,
    ).toContain('team:ui'));
  it('skill invalid dropped', () => {
    const ck = loadData({ claude_code_skills: ['UPPERCASE', 'team:ui'] });
    expect(ck.claude_code_skills).not.toContain('UPPERCASE');
    expect(ck.claude_code_skills).toContain('team:ui');
  });
  it('notes capped at 2048', () =>
    expect(loadData({ notes: 'x'.repeat(3000) }).notes.length).toBe(2048));
  it('notes fence stripped', () =>
    expect(
      loadData({ notes: 'context ```rm -rf /``` end' }).notes,
    ).not.toContain('```'));
  it('dashboard token env accepted', () =>
    expect(
      loadData({ dashboard_token_env: 'ACME_DASHBOARD_TOKEN' })
        .dashboard_token_env,
    ).toBe('ACME_DASHBOARD_TOKEN'));
  it('dashboard token env lowercase dropped', () =>
    expect(
      loadData({ dashboard_token_env: 'my_token' }).dashboard_token_env,
    ).toBe(''));
  it('unknown keys tolerated', () =>
    expect(
      loadData({ unknown_future_field: 'ignored', confluence_spaces: ['QA'] })
        .isEmpty,
    ).toBe(false));
  it('unknown key emits warning', () => {
    const ck = loadData({ legacy_dashboard_url: 'https://x.example.com' });
    expect(
      ck.warnings.some((w) =>
        w.includes('ignored unknown field: legacy_dashboard_url'),
      ),
    ).toBe(true);
    expect(ck.dashboard_url).toBe('');
  });
  it('known keys emit no unknown warning', () => {
    const ck = loadData({
      confluence_spaces: ['QA'],
      dashboard_url: 'https://x.example.com',
    });
    expect(ck.warnings.some((w) => w.includes('ignored unknown field'))).toBe(
      false,
    );
  });
  it('otel exporter endpoint http accepted', () =>
    expect(
      loadData({ otel_exporter_endpoint: 'http://localhost:4318' })
        .otel_exporter_endpoint,
    ).toBe('http://localhost:4318'));
  it('otel exporter endpoint grpc accepted', () =>
    expect(
      loadData({ otel_exporter_endpoint: 'grpc://collector.example.com:4317' })
        .otel_exporter_endpoint,
    ).toBe('grpc://collector.example.com:4317'));
  it('otel exporter endpoint empty is silent default', () => {
    const ck = loadData({
      otel_exporter_endpoint: '',
      confluence_spaces: ['QA'],
    });
    expect(ck.otel_exporter_endpoint).toBe('');
    expect(ck.warnings).toEqual([]);
    expect(ck.error).toBe('');
  });
  it('otel exporter endpoint invalid scheme dropped', () =>
    expect(
      loadData({ otel_exporter_endpoint: 'ftp://bad.example.com:4317' })
        .otel_exporter_endpoint,
    ).toBe(''));
  it('otel exporter endpoint no netloc dropped', () =>
    expect(
      loadData({ otel_exporter_endpoint: 'not-a-url' }).otel_exporter_endpoint,
    ).toBe(''));
  it('otel exporter endpoint secret rejected', () => {
    const ck = loadData({
      otel_exporter_endpoint: 'Bearer-super-secret-token-value',
    });
    expect(ck.error).toBeTruthy();
    expect(ck.error).toContain('secret');
  });
});

// -- secret rejection ---------------------------------------------------------

describe('TestSecretRejection', () => {
  it('sk prefix in notes field not rejected', () =>
    expect(
      loadData({ notes: 'Use sk-pattern selectors for tests.' }).error,
    ).toBeFalsy());
  it('sk prefix in mcp servers rejected', () => {
    const ck = loadData({ mcp_servers: ['sk-live-abc123xyz'] });
    expect(ck.isEmpty).toBe(true);
    expect(ck.error).toContain('secret');
  });
  it('api_key prefix rejected', () => {
    const ck = loadData({ confluence_spaces: ['api_key-actual-secret-value'] });
    expect(ck.isEmpty).toBe(true);
    expect(ck.error).toBeTruthy();
  });
  it('long value in non-notes field rejected', () => {
    const ck = loadData({ mcp_servers: ['a'.repeat(129)] });
    expect(ck.isEmpty).toBe(true);
    expect(ck.error).toBeTruthy();
  });
  it('error set means is_empty', () =>
    expect(loadData({ mcp_servers: ['sk-secret'] }).isEmpty).toBe(true));
});

// -- prompt block -------------------------------------------------------------

describe('TestPromptBlock', () => {
  it('empty returns empty string', () =>
    expect(new CompanyKnowledge().promptBlock()).toBe(''));
  it('non empty includes header', () =>
    expect(
      new CompanyKnowledge({ confluence_spaces: ['QA'] }).promptBlock(),
    ).toContain('--- COMPANY KNOWLEDGE ---'));
  it('confluence spaces in block', () =>
    expect(
      new CompanyKnowledge({ confluence_spaces: ['QA', 'ENG'] }).promptBlock(),
    ).toContain('QA, ENG'));
  it('mcp servers appear in hint', () => {
    const block = new CompanyKnowledge({
      confluence_spaces: ['QA'],
      mcp_servers: ['plugin_atlassian_atlassian'],
    }).promptBlock();
    expect(block).toContain('plugin_atlassian_atlassian');
  });
  it('skills formatted with slash', () => {
    const block = new CompanyKnowledge({
      claude_code_skills: ['team:ui', 'verify'],
    }).promptBlock();
    expect(block).toContain('/team:ui');
    expect(block).toContain('/verify');
  });
  it('notes included verbatim', () =>
    expect(
      new CompanyKnowledge({
        notes: 'Follow our Playwright conventions.',
      }).promptBlock(),
    ).toContain('Follow our Playwright conventions.'));
  it('do not invent footer present', () =>
    expect(
      new CompanyKnowledge({ confluence_spaces: ['QA'] }).promptBlock(),
    ).toContain('Do not invent'));
});

// -- to_dict ------------------------------------------------------------------

describe('TestToDict', () => {
  it('includes is_empty', () => {
    const d = new CompanyKnowledge().toDict();
    expect('is_empty' in d).toBe(true);
    expect(d['is_empty']).toBe(true);
  });
  it('error key present when set', () =>
    expect(
      'error' in
        new CompanyKnowledge({ error: 'something went wrong' }).toDict(),
    ).toBe(true));
  it('error key absent when clear', () =>
    expect(
      'error' in new CompanyKnowledge({ confluence_spaces: ['QA'] }).toDict(),
    ).toBe(false));
});

// -- merge cascade ------------------------------------------------------------

describe('TestMergeCascade', () => {
  function write(base: string, filename: string, data: unknown): void {
    writeCompanyJson(base, data, filename);
  }

  function withTmp<T>(fn: (tmp: string) => T): T {
    const tmp = mkTmp();
    try {
      return fn(tmp);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  it('project local only', () =>
    withTmp((tmp) => {
      write(tmp, 'company.json', { confluence_spaces: ['QA'] });
      const ck = load(tmp);
      expect(ck.confluence_spaces).toContain('QA');
      expect(ck.sources).toContain('.canary/company.json');
    }));

  it('env override loaded when canary env set', () =>
    withTmp((tmp) => {
      write(tmp, 'company.json', { confluence_spaces: ['QA'] });
      write(tmp, 'company.uat.json', { confluence_spaces: ['UAT'] });
      const ck = load(tmp, 'uat');
      expect(ck.confluence_spaces).toContain('QA');
      expect(ck.confluence_spaces).toContain('UAT');
      expect(ck.sources).toContain('.canary/company.uat.json');
    }));

  it('env override not loaded without env', () =>
    withTmp((tmp) => {
      write(tmp, 'company.json', { confluence_spaces: ['QA'] });
      write(tmp, 'company.uat.json', { confluence_spaces: ['UAT'] });
      const ck = load(tmp);
      expect(ck.confluence_spaces).not.toContain('UAT');
    }));

  it('lists are unioned across layers', () =>
    withTmp((tmp) => {
      write(tmp, 'company.json', {
        mcp_servers: ['plugin_atlassian_atlassian'],
        internal_domains: ['corp.example.com'],
      });
      write(tmp, 'company.uat.json', {
        mcp_servers: ['harness'],
        internal_domains: ['engage.example.com'],
      });
      const ck = load(tmp, 'uat');
      expect(ck.mcp_servers).toContain('plugin_atlassian_atlassian');
      expect(ck.mcp_servers).toContain('harness');
      expect(ck.internal_domains).toContain('corp.example.com');
      expect(ck.internal_domains).toContain('engage.example.com');
    }));

  it('lists deduped across layers', () =>
    withTmp((tmp) => {
      write(tmp, 'company.json', { mcp_servers: ['harness'] });
      write(tmp, 'company.prod.json', { mcp_servers: ['harness'] });
      const ck = load(tmp, 'prod');
      expect(ck.mcp_servers.filter((s) => s === 'harness').length).toBe(1);
    }));

  it('scalar notes replaced by higher priority', () =>
    withTmp((tmp) => {
      write(tmp, 'company.json', { notes: 'base note' });
      write(tmp, 'company.prod.json', { notes: 'prod note' });
      expect(load(tmp, 'prod').notes).toBe('prod note');
    }));

  it('scalar notes falls back to lower layer', () =>
    withTmp((tmp) => {
      write(tmp, 'company.json', { notes: 'base note' });
      write(tmp, 'company.prod.json', { mcp_servers: ['harness'] });
      expect(load(tmp, 'prod').notes).toBe('base note');
    }));

  it('otel exporter endpoint replaced by env layer', () =>
    withTmp((tmp) => {
      write(tmp, 'company.json', {
        otel_exporter_endpoint: 'http://localhost:4318',
      });
      write(tmp, 'company.uat.json', {
        otel_exporter_endpoint: 'grpc://collector.uat.example.com:4317',
      });
      expect(load(tmp, 'uat').otel_exporter_endpoint).toBe(
        'grpc://collector.uat.example.com:4317',
      );
    }));

  it('dashboard url replaced by env layer', () =>
    withTmp((tmp) => {
      write(tmp, 'company.json', {
        dashboard_url: 'https://dashboard.example.com/base',
      });
      write(tmp, 'company.uat.json', {
        dashboard_url: 'https://dashboard.example.com/uat',
      });
      expect(load(tmp, 'uat').dashboard_url).toBe(
        'https://dashboard.example.com/uat',
      );
    }));

  it('secret in env layer skipped but base merged', () =>
    withTmp((tmp) => {
      write(tmp, 'company.json', { confluence_spaces: ['QA'] });
      write(tmp, 'company.uat.json', { mcp_servers: ['sk-secret'] });
      const ck = load(tmp, 'uat');
      expect(ck.confluence_spaces).toContain('QA');
      expect(ck.error).toBeTruthy();
    }));

  it('missing env file is silent', () =>
    withTmp((tmp) => {
      write(tmp, 'company.json', { confluence_spaces: ['QA'] });
      const ck = load(tmp, 'nonexistent');
      expect(ck.confluence_spaces).toContain('QA');
      expect(ck.error).toBe('');
    }));

  it('sources tracks all loaded files', () =>
    withTmp((tmp) => {
      write(tmp, 'company.json', { confluence_spaces: ['QA'] });
      write(tmp, 'company.staging.json', { jira_projects: ['PROJ'] });
      const ck = load(tmp, 'staging');
      expect(ck.sources).toContain('.canary/company.json');
      expect(ck.sources).toContain('.canary/company.staging.json');
    }));

  it('to_dict includes sources', () =>
    withTmp((tmp) => {
      write(tmp, 'company.json', { confluence_spaces: ['QA'] });
      expect('sources' in load(tmp).toDict()).toBe(true);
    }));
});

// ===========================================================================
// test_report_branding.py
// ===========================================================================

const FULL_BRAND = {
  company_name: 'Acme Corp',
  logo_path: 'assets/logo.svg',
  primary_color: '#26A9E1',
  secondary_color: '#F4A114',
  text_color: '#212121',
  background_color: '#FFF8EC',
  footer_note: 'Acme QA report',
};

describe('TestBrandParsing', () => {
  it('recognized fields round trip', () => {
    const ck = loadData({ brand: FULL_BRAND });
    const a = ck.brand.assets;
    expect(a['company_name']).toBe('Acme Corp');
    expect(a['primary_color']).toBe('#26A9E1');
    expect(a['text_color']).toBe('#212121');
    expect(a['background_color']).toBe('#FFF8EC');
    expect(a['logo_path']).toBe('assets/logo.svg');
    expect(ck.warnings).toEqual([]);
  });

  it('unknown key passes through', () => {
    const ck = loadData({
      brand: { tagline: 'Trusted testing', product_hue: '#695189' },
    });
    expect(ck.brand.assets['tagline']).toBe('Trusted testing');
    expect(ck.brand.assets['product_hue']).toBe('#695189');
  });

  it('extra that looks like bad color is dropped', () => {
    const ck = loadData({ brand: { product_hue: '#zzzz' } });
    expect('product_hue' in ck.brand.assets).toBe(false);
    expect(ck.warnings.some((w) => w.includes('product_hue'))).toBe(true);
  });

  it('invalid hex in recognized field dropped with warning', () => {
    const ck = loadData({ brand: { primary_color: 'blue' } });
    expect('primary_color' in ck.brand.assets).toBe(false);
    expect(ck.warnings.some((w) => w.includes('primary_color'))).toBe(true);
  });

  it('accents list filters invalid', () => {
    const ck = loadData({ brand: { accents: ['#F4A114', 'nope', '#78BD31'] } });
    expect(ck.brand.assets['accents']).toEqual(['#F4A114', '#78BD31']);
  });

  it('badge and logo variants', () => {
    const ck = loadData({
      brand: {
        badge_accent: '#26A9E1',
        logo_variants: {
          horizontal: 'logos/horizontal.svg',
          stacked: 'logos/stacked.svg',
        },
      },
    });
    expect(ck.brand.assets['badge_accent']).toBe('#26A9E1');
    expect(
      (ck.brand.assets['logo_variants'] as Record<string, string>)[
        'horizontal'
      ],
    ).toBe('logos/horizontal.svg');
  });

  it('secret in extra is rejected', () => {
    const ck = loadData({ brand: { api_hint: 'sk-live-abc123' } });
    expect(ck.brand.isEmpty).toBe(true);
    expect(ck.error.toLowerCase()).toContain('secret');
  });

  it('non-dict brand skipped with warning', () => {
    const ck = loadData({ brand: 'nope' });
    expect(ck.brand.isEmpty).toBe(true);
    expect(ck.warnings.some((w) => w.includes('brand'))).toBe(true);
  });
});

describe('TestBrandMerge', () => {
  function withTmp<T>(fn: (tmp: string) => T): T {
    const tmp = mkTmp();
    try {
      return fn(tmp);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  it('per key merge env over project', () =>
    withTmp((tmp) => {
      writeCompanyJson(tmp, {
        brand: { logo_path: 'assets/logo.svg', primary_color: '#111111' },
      });
      writeCompanyJson(
        tmp,
        { brand: { primary_color: '#222222', footer_note: 'UAT build' } },
        'company.uat.json',
      );
      const a = load(tmp, 'uat').brand.assets;
      expect(a['logo_path']).toBe('assets/logo.svg');
      expect(a['primary_color']).toBe('#222222');
      expect(a['footer_note']).toBe('UAT build');
    }));

  it('extras merge by key too', () =>
    withTmp((tmp) => {
      writeCompanyJson(tmp, { brand: { tagline: 'org tagline' } });
      writeCompanyJson(
        tmp,
        { brand: { tagline: 'project tagline' } },
        'company.uat.json',
      );
      expect(load(tmp, 'uat').brand.assets['tagline']).toBe('project tagline');
    }));
});

describe('TestToDictAndEmptiness', () => {
  it('to_dict emits flat brand map', () => {
    const ck = new CompanyKnowledge({
      brand: new Brand({ company_name: 'Acme', tagline: 'hi' }),
    });
    expect(ck.toDict()['brand']).toEqual({
      company_name: 'Acme',
      tagline: 'hi',
    });
  });
  it('brand only config is not empty', () => {
    const ck = loadData({ brand: { company_name: 'Acme' } });
    expect(ck.isEmpty).toBe(false);
  });
  it('empty brand keeps empty ck empty', () => {
    expect(new CompanyKnowledge({ brand: new Brand() }).isEmpty).toBe(true);
  });
});

describe('TestReportBranding', () => {
  function ck(): CompanyKnowledge {
    return new CompanyKnowledge({ brand: new Brand({ ...FULL_BRAND }) });
  }

  // Snapshot + restore the two flavor env vars around each case.
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const v of ['CANARY_NO_FLAVOR', 'NO_FLAVOR'])
      saved[v] = process.env[v];
  });
  afterEach(() => {
    for (const v of ['CANARY_NO_FLAVOR', 'NO_FLAVOR']) {
      if (saved[v] === undefined) delete process.env[v];
      else process.env[v] = saved[v];
    }
  });

  it('present assets pass through with attribution', () => {
    const b = ck().reportBranding(true);
    expect(b['company_name']).toBe('Acme Corp');
    expect(b['primary_color']).toBe('#26A9E1');
    expect(b['attribution']).toBe('made with Canary');
    expect(b['flavor']).toBe(true);
    expect(b['voice_line']).toBeTruthy();
  });

  it('flavor off drops voice but keeps attribution', () => {
    const b = ck().reportBranding(false);
    expect(b['voice_line']).toBe('');
    expect(b['attribution']).toBe('made with Canary');
    expect(b['flavor']).toBe(false);
  });

  it('logo path resolved against cwd', () => {
    const tmp = mkTmp();
    const prev = process.cwd();
    try {
      process.chdir(tmp);
      const b = ck().reportBranding(false);
      const expected = join(process.cwd(), 'assets/logo.svg');
      expect(b['logo_path_resolved']).toBe(expected);
    } finally {
      process.chdir(prev);
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('no logo path no resolved key', () => {
    const c = new CompanyKnowledge({
      brand: new Brand({ company_name: 'Acme' }),
    });
    expect('logo_path_resolved' in c.reportBranding()).toBe(false);
  });

  it('env off switch disables flavor', () => {
    for (const v of ['CANARY_NO_FLAVOR', 'NO_FLAVOR']) {
      delete process.env['CANARY_NO_FLAVOR'];
      delete process.env['NO_FLAVOR'];
      process.env[v] = '1';
      const b = ck().reportBranding();
      expect(b['flavor']).toBe(false);
      expect(b['voice_line']).toBe('');
    }
  });

  it('default flavor on when no env', () => {
    delete process.env['CANARY_NO_FLAVOR'];
    delete process.env['NO_FLAVOR'];
    expect(ck().reportBranding()['flavor']).toBe(true);
  });

  it('falsey env value keeps flavor on', () => {
    process.env['CANARY_NO_FLAVOR'] = 'false';
    delete process.env['NO_FLAVOR'];
    expect(ck().reportBranding()['flavor']).toBe(true);
  });
});

// ===========================================================================
// Edge coverage: validator type-name warnings, brand edges, prompt block
// ===========================================================================

describe('EdgeCoverage', () => {
  it('prompt block renders every field kind', () => {
    const block = new CompanyKnowledge({
      confluence_spaces: ['QA'],
      jira_projects: ['PROJ'],
      internal_doc_urls: ['https://docs.example.com/page'],
      internal_domains: ['corp.example.com'],
      mcp_servers: ['m'],
      claude_code_skills: ['s'],
      notes: 'be careful',
    }).promptBlock();
    expect(block).toContain('Jira projects');
    expect(block).toContain('Reference docs');
    expect(block).toContain('https://docs.example.com/page');
    expect(block).toContain('Internal domains');
    expect(block).toContain('Notes from the project owner');
  });

  it('non-list list-field warns with python type name', () => {
    expect(
      loadData({ confluence_spaces: 5 }).warnings.some((w) =>
        w.includes('expected list, got int'),
      ),
    ).toBe(true);
    expect(
      loadData({ jira_projects: true }).warnings.some((w) =>
        w.includes('expected list, got bool'),
      ),
    ).toBe(true);
    expect(
      loadData({ mcp_servers: 1.5 }).warnings.some((w) =>
        w.includes('expected list, got float'),
      ),
    ).toBe(true);
  });

  it('non-string url field warns', () => {
    expect(
      loadData({ dashboard_url: 123 }).warnings.some((w) =>
        w.includes('expected string, got int'),
      ),
    ).toBe(true);
  });

  it('non-string otel endpoint warns', () => {
    expect(
      loadData({ otel_exporter_endpoint: 123 }).warnings.some((w) =>
        w.includes('expected string, got int'),
      ),
    ).toBe(true);
  });

  it('brand accents non-list warns', () => {
    const ck = loadData({ brand: { accents: 'not-a-list' } });
    expect(ck.warnings.some((w) => w.includes('brand.accents'))).toBe(true);
    expect('accents' in ck.brand.assets).toBe(false);
  });

  it('brand logo_variants non-object warns', () => {
    const ck = loadData({ brand: { logo_variants: 'nope' } });
    expect(ck.warnings.some((w) => w.includes('brand.logo_variants'))).toBe(
      true,
    );
  });

  it('brand extra non-string warns and is dropped', () => {
    const ck = loadData({ brand: { weird_extra: 123 } });
    expect(ck.warnings.some((w) => w.includes('brand.weird_extra'))).toBe(true);
    expect('weird_extra' in ck.brand.assets).toBe(false);
  });

  it('brand logo_url non-string dropped', () => {
    const ck = loadData({ brand: { logo_url: 123, company_name: 'Acme' } });
    expect('logo_url' in ck.brand.assets).toBe(false);
  });

  it('brand recognized text field non-string warns', () => {
    const ck = loadData({ brand: { company_name: 123 } });
    expect(ck.warnings.some((w) => w.includes('brand.company_name'))).toBe(
      true,
    );
    expect('company_name' in ck.brand.assets).toBe(false);
  });

  it('brand null value is silently empty', () => {
    const ck = loadData({ brand: null });
    expect(ck.brand.isEmpty).toBe(true);
    expect(ck.warnings).toEqual([]);
  });

  it('brand logo_url string validated', () => {
    const ck = loadData({
      brand: { logo_url: 'https://cdn.example.com/logo.png' },
    });
    expect(ck.brand.assets['logo_url']).toBe(
      'https://cdn.example.com/logo.png',
    );
  });

  it('logo variant non-string path skipped', () => {
    const ck = loadData({
      brand: { logo_variants: { good: 'a.svg', bad: 123 } },
    });
    const variants = ck.brand.assets['logo_variants'] as Record<
      string,
      unknown
    >;
    expect(variants['good']).toBe('a.svg');
    expect('bad' in variants).toBe(false);
  });

  it('report branding resolves an absolute logo path as-is', () => {
    const abs = join(HOME, 'logo.svg');
    const b = new CompanyKnowledge({
      brand: new Brand({ logo_path: abs }),
    }).reportBranding(false);
    expect(b['logo_path_resolved']).toBe(abs);
  });
});
