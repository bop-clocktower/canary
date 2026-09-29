/**
 * canary-manhunter (#611): the source reader, the content digest, and the
 * assembly rules every section shares.
 *
 * The contract pinned here is the one the dossier exists for: a section whose
 * source is absent is DARK and named, a dossier with a dark section can never
 * read `complete`, and the digest is a reproducible fingerprint of the
 * evidence -- independent of when the dossier was generated, sensitive to any
 * edit of what it says.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  parseJsonSource,
  readSource,
  sourceRef,
} from '../src/analysis/manhunter/sources.js';
import {
  assembleDossier,
  canonicalJson,
  finalizeDossier,
  verifyDossier,
} from '../src/analysis/manhunter/assemble.js';
import { renderDossier } from '../src/analysis/manhunter/render.js';
import {
  darkSection,
  fedSection,
  SECTION_IDS,
  type Section,
} from '../src/analysis/manhunter/types.js';
import { mkTmp, rmTmp } from './canary-cli-testkit.js';

let tmp: string;
beforeEach(() => {
  tmp = mkTmp();
});
afterEach(() => {
  rmTmp(tmp);
});

describe('readSource', () => {
  it('reports a missing file as missing, never as empty', () => {
    const read = readSource(join(tmp, 'nope.json'));
    expect(read.kind).toBe('missing');
    expect(sourceRef(read).sha256).toBeNull();
  });

  it('reports a path it cannot read as unreadable, with the reason', () => {
    const dir = join(tmp, 'a-dir');
    mkdirSync(dir);
    const read = readSource(dir);
    expect(read.kind).toBe('unreadable');
    const parsed = parseJsonSource(read);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toContain('could not be read');
  });

  it('hashes the exact bytes it read', () => {
    const path = join(tmp, 'x.json');
    writeFileSync(path, '{"a":1}\n');
    const read = readSource(path);
    expect(sourceRef(read).sha256).toBe(
      createHash('sha256').update('{"a":1}\n').digest('hex'),
    );
    writeFileSync(path, '{"a":2}\n');
    expect(sourceRef(readSource(path)).sha256).not.toBe(sourceRef(read).sha256);
  });

  it('names invalid JSON as invalid rather than treating it as empty', () => {
    const path = join(tmp, 'bad.json');
    writeFileSync(path, '{not json');
    const parsed = parseJsonSource(readSource(path));
    expect(parsed).toEqual({
      ok: false,
      reason: `${path} is not valid JSON`,
    });
  });
});

describe('canonicalJson', () => {
  it('is independent of key order at every depth', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: 3 } })).toBe(
      canonicalJson({ a: { c: 3, d: [1, { y: 2, z: 1 }] }, b: 1 }),
    );
  });
});

function fed(id: (typeof SECTION_IDS)[number]): Section {
  return fedSection(id, {
    sources: [{ path: `${id}.json`, sha256: 'a'.repeat(64) }],
    denominator: '1 item',
    facts: [`${id} fact`],
    eyes: [],
  });
}

function allFed(): Section[] {
  return SECTION_IDS.map(fed);
}

describe('assembleDossier verdict', () => {
  it('is complete only when every section is fed or excluded', () => {
    const d = assembleDossier({
      release: 'v1',
      sections: allFed(),
      exclusions: {},
    });
    expect(d.verdict).toBe('complete');
    expect(d.counts).toEqual({ fed: 7, dark: 0, excluded: 0 });
  });

  it('is incomplete when one section is dark, and the dark section heads Worth your eyes', () => {
    const sections = allFed();
    sections[5] = darkSection('sweep', [], 'no sweep report was given');
    sections[0] = fedSection('run-history', {
      sources: [],
      denominator: '3 runs',
      facts: [],
      eyes: ['suite api: latest run failed'],
    });
    const d = assembleDossier({ release: 'v1', sections, exclusions: {} });
    expect(d.verdict).toBe('incomplete');
    expect(d.worthYourEyes[0]).toEqual({
      section: 'sweep',
      text: 'DARK: no sweep report was given',
    });
    expect(d.worthYourEyes[1]).toEqual({
      section: 'run-history',
      text: 'suite api: latest run failed',
    });
  });

  it('is abstained when nothing was fed, including when everything is excluded', () => {
    const dark = SECTION_IDS.map((id) => darkSection(id, [], 'absent'));
    expect(
      assembleDossier({ release: 'v1', sections: dark, exclusions: {} })
        .verdict,
    ).toBe('abstained');
    const exclusions = Object.fromEntries(
      SECTION_IDS.map((id) => [id, 'out of scope']),
    );
    expect(
      assembleDossier({ release: 'v1', sections: dark, exclusions }).verdict,
    ).toBe('abstained');
  });

  it('turns a declared exclusion into EXCLUDED with its reason and lets the verdict complete', () => {
    const sections = allFed();
    sections[5] = darkSection('sweep', [], 'no sweep report was given');
    const d = assembleDossier({
      release: 'v1',
      sections,
      exclusions: { sweep: 'no UI surface' },
    });
    expect(d.verdict).toBe('complete');
    const sweep = d.sections.find((s) => s.id === 'sweep');
    expect(sweep?.status).toBe('excluded');
    expect(sweep?.reason).toBe('no UI surface');
    expect(d.worthYourEyes).toEqual([]);
  });

  it('caps a section eyes list at ten with an overflow line', () => {
    const s = fedSection('escapes', {
      sources: [],
      denominator: 'tracked since 2026-01-01',
      facts: [],
      eyes: Array.from({ length: 13 }, (_, i) => `escape ${i}`),
    });
    expect(s.eyes).toHaveLength(11);
    expect(s.eyes[10]).toBe('and 3 more');
  });
});

describe('digest', () => {
  const payload = () =>
    assembleDossier({ release: 'v1', sections: allFed(), exclusions: {} });

  it('does not depend on when the dossier was generated', () => {
    const a = finalizeDossier(payload(), '2026-09-01T00:00:00.000Z');
    const b = finalizeDossier(payload(), '2026-09-02T12:00:00.000Z');
    expect(a.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(a.digest).toBe(b.digest);
  });

  it('changes when any nested field of the evidence changes', () => {
    const base = finalizeDossier(payload(), 'now').digest;
    const changed = payload();
    changed.sections[3]!.facts.push('one more fact');
    expect(finalizeDossier(changed, 'now').digest).not.toBe(base);
  });

  it('verify matches an untouched dossier and rejects an edited one', () => {
    const dossier = finalizeDossier(payload(), '2026-09-01T00:00:00.000Z');
    const text = JSON.stringify(dossier, null, 2);
    expect(verifyDossier(text)).toBe('match');
    const edited = JSON.parse(text) as { verdict: string };
    edited.verdict = 'complete-ish';
    expect(verifyDossier(JSON.stringify(edited))).toBe('mismatch');
    // generatedAt sits outside the digest on purpose.
    const retimed = JSON.parse(text) as { generatedAt: string };
    retimed.generatedAt = 'later';
    expect(verifyDossier(JSON.stringify(retimed))).toBe('match');
  });

  it('calls a file with no digest malformed rather than mismatched', () => {
    expect(verifyDossier('{"verdict":"complete"}')).toBe('malformed');
    expect(verifyDossier('not json')).toBe('malformed');
    expect(verifyDossier('[1,2]')).toBe('malformed');
  });
});

describe('renderDossier', () => {
  it('states the verdict, the counts, the digest and every dark reason', () => {
    const sections = allFed();
    sections[6] = darkSection(
      'escapes',
      [{ path: '.canary/escapes.json', sha256: null }],
      'no escape log at .canary/escapes.json',
    );
    const dossier = finalizeDossier(
      assembleDossier({ release: 'v2.3.0', sections, exclusions: {} }),
      '2026-09-01T00:00:00.000Z',
    );
    const md = renderDossier(dossier);
    expect(md).toContain('# Release quality dossier: v2.3.0');
    expect(md).toContain('**Evidence verdict:** INCOMPLETE');
    expect(md).toContain('6 fed, 1 dark, 0 excluded');
    expect(md).toContain(dossier.digest);
    expect(md).toContain('## Worth your eyes');
    expect(md).toContain('DARK: no escape log at .canary/escapes.json');
    expect(md).toContain('## Escape history: DARK');
    expect(md).toContain('`.canary/escapes.json` (not read)');
  });

  it('says so plainly when there is nothing worth your eyes', () => {
    const dossier = finalizeDossier(
      assembleDossier({ release: 'v1', sections: allFed(), exclusions: {} }),
      'now',
    );
    expect(renderDossier(dossier)).toContain(
      'Nothing flagged. Every section was fed and none raised an item.',
    );
  });
});
