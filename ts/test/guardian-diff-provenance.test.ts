/**
 * #761 — guardian must state what its diff was taken between.
 *
 * The measured failure this pins (capwell#1853): a PR whose entire
 * diff was ONE markdown file was analyzed as 43 files, because CI checked out
 * the `pull_request` MERGE REF — the base branch merged with the PR head — and
 * diffed to that. The triple-dot merge base degenerates to the base sha itself
 * (it is an ancestor of the merge commit), so the range swept in every commit
 * merged into the base branch since. Guardian then reported six files the PR
 * never touched.
 *
 * Nothing on any surface contradicted it. The comment named the HEAD side only,
 * via finding permalinks, and never said what it diffed AGAINST or how many
 * files it saw — so a 43-file diff on a one-file PR looked unremarkable.
 *
 * Worse, the wrong diff DEFEATED the zero-denominator guard: that PR was
 * docs-only, no lcov existed, and the run should have abstained ("verified zero
 * items"). Abstention requires zero findings-eligible units, and the phantom
 * files supplied findings — so a run that verified nothing headlined a finding
 * count instead. Provenance is the cheapest surface that makes the shape
 * self-evident before a reader trusts a single row.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { GuardianDeps, detectMergeRef } from '../src/guardian/cli.js';
import { CoverageInputState, Fidelity } from '../src/guardian/coverage.js';
import { Severity } from '../src/guardian/impact-mapper.js';
import {
  DiffProvenance,
  GuardianFinding,
  provenanceLine,
  renderFindings,
} from '../src/guardian/pr-check.js';

const PR_HEAD = '2cfb03cbfbd74e04d0a76869d062c816090c75d3';
const MERGE_REF_HEAD = '9f1e4d7a3b2c5e8f0a1d6c9b4e7f2a5d8c3b6e90';
const BASE = '90e550148f3ad609aa8435c7f44a363d627c07ed';

const BLIND: CoverageInputState = {
  requested: null,
  found: false,
  parsed: false,
  filesInReport: 0,
  unitsMatched: 0,
  unitsTotal: 1,
};

function finding(): GuardianFinding[] {
  return [
    new GuardianFinding({
      path: 'apps/web-e2e/tests/auth.setup.ts',
      unit: 'auth.setup',
      fidelity: Fidelity.Heuristic,
      severity: Severity.LOW,
      evidence: 'added test asserts nothing',
    }),
  ];
}

/** The honest shape: base…real PR head, one file, no merge ref. */
const CLEAN: DiffProvenance = {
  base: BASE,
  head: PR_HEAD,
  origin: 'ci-base',
  fileCount: 1,
};

/** The capwell#1853 shape: same base, HEAD is the merge ref, 43 files. */
const INFLATED: DiffProvenance = {
  base: BASE,
  head: MERGE_REF_HEAD,
  origin: 'file',
  fileCount: 43,
  mergeRef: true,
};

describe('provenanceLine states both endpoints and the size (#761)', () => {
  it('abbreviates shas to 10 chars and names the file count and origin', () => {
    const line = provenanceLine(CLEAN);
    expect(line).toContain('90e550148f...2cfb03cbfb');
    expect(line).toContain('1 file');
    expect(line).toContain('via ci-base');
    // A clean run carries no alarm prose — otherwise the warning stops meaning
    // anything on the run that has one.
    expect(line).not.toContain('MERGE REF');
  });

  it('pluralizes the file count', () => {
    expect(provenanceLine(INFLATED)).toContain('43 files');
  });

  it('renders a ref name verbatim rather than truncating it to 10 chars', () => {
    // `origin/main` is 11 chars; a blind slice(0,10) would print `origin/mai`.
    const line = provenanceLine({ ...CLEAN, base: 'origin/main' });
    expect(line).toContain('origin/main...2cfb03cbfb');
  });

  it('renders an unresolvable endpoint as ? rather than omitting the range', () => {
    // An explicit `--diff` from a file has no knowable base. The range must
    // still print: "we do not know" and "we did not say" read identically to a
    // reviewer, and only the first is true.
    const line = provenanceLine({ ...CLEAN, base: null, origin: 'file' });
    expect(line).toContain('?...2cfb03cbfb');
  });

  it('the merge-ref shape says the diff is WIDER than the PR', () => {
    const line = provenanceLine(INFLATED);
    expect(line).toContain('MERGE REF');
    expect(line).toContain('WIDER than the PR');
  });
});

describe('the sticky comment carries provenance (#761)', () => {
  const meta = (provenance: DiffProvenance) => ({
    checked: 1,
    abstained: false,
    coverage: BLIND,
    provenance,
  });

  it('a findings comment states what was diffed', () => {
    const body = renderFindings(finding(), 'comment', 0, null, meta(CLEAN));
    expect(body).toContain('90e550148f...2cfb03cbfb');
    expect(body).toContain('1 file');
  });

  it('a no-findings comment states it too', () => {
    // The clean surface needs it MORE, not less: "no gaps" over a diff that
    // never contained the PR's files is the false green this exists to expose.
    const body = renderFindings([], 'comment', 0, null, meta(CLEAN));
    expect(body).toContain('90e550148f...2cfb03cbfb');
  });

  it('the capwell#1853 regression: 43 files and the merge-ref warning both show', () => {
    const body = renderFindings(finding(), 'comment', 0, null, meta(INFLATED));
    expect(body).toContain('43 files');
    expect(body).toContain('MERGE REF');
  });

  it('provenance sits with the confidence footer, not above the findings table', () => {
    const body = renderFindings(finding(), 'comment', 0, null, meta(CLEAN));
    const prov = body.indexOf('Diff: ');
    const table = body.indexOf('| Sev |');
    const footer = body.indexOf('Confidence —');
    expect(table).toBeGreaterThan(-1);
    expect(prov).toBeGreaterThan(table);
    expect(prov).toBeLessThan(footer);
  });

  it('omitting provenance leaves the comment unchanged (non-pr-check producers)', () => {
    const body = renderFindings(finding(), 'comment', 0, null, {
      checked: 1,
      abstained: false,
      coverage: BLIND,
    });
    expect(body).not.toContain('Diff: ');
  });
});

describe('machine and terminal surfaces carry provenance (#761)', () => {
  it('--format json exposes the block for downstream consumers', () => {
    const payload = JSON.parse(
      renderFindings(finding(), 'json', 0, null, {
        checked: 1,
        abstained: false,
        coverage: BLIND,
        provenance: INFLATED,
      }),
    ) as { provenance: DiffProvenance };
    expect(payload.provenance.fileCount).toBe(43);
    expect(payload.provenance.mergeRef).toBe(true);
    expect(payload.provenance.base).toBe(BASE);
    expect(payload.provenance.head).toBe(MERGE_REF_HEAD);
  });

  it('the text surface states it without markdown backticks', () => {
    const body = renderFindings(finding(), 'text', 0, null, {
      checked: 1,
      abstained: false,
      coverage: BLIND,
      provenance: CLEAN,
    });
    expect(body).toContain('90e550148f...2cfb03cbfb');
    expect(body).not.toContain('`');
  });
});

describe('detectMergeRef compares, it does not guess (#761)', () => {
  const depsWith = (env: Record<string, string | undefined>): GuardianDeps =>
    ({ env }) as unknown as GuardianDeps;

  const eventFile = (headSha: string): string => {
    const dir = mkdtempSync(join(tmpdir(), 'guardian-prov-'));
    const path = join(dir, 'event.json');
    writeFileSync(
      path,
      JSON.stringify({ pull_request: { head: { sha: headSha } } }),
    );
    return path;
  };

  it('flags HEAD that differs from the event-declared PR head', () => {
    const deps = depsWith({
      GITHUB_EVENT_NAME: 'pull_request',
      GITHUB_EVENT_PATH: eventFile(PR_HEAD),
    });
    expect(detectMergeRef(MERGE_REF_HEAD, deps)).toBe(true);
  });

  it('stays quiet when HEAD already IS the PR head', () => {
    const deps = depsWith({
      GITHUB_EVENT_NAME: 'pull_request',
      GITHUB_EVENT_PATH: eventFile(PR_HEAD),
    });
    expect(detectMergeRef(PR_HEAD, deps)).toBe(false);
  });

  it('does not fire outside a pull_request event', () => {
    // A `push` build has no PR head to differ from; claiming a merge ref there
    // would be a false alarm on every main-branch run.
    const deps = depsWith({
      GITHUB_EVENT_NAME: 'push',
      GITHUB_EVENT_PATH: eventFile(PR_HEAD),
    });
    expect(detectMergeRef(MERGE_REF_HEAD, deps)).toBe(false);
  });

  it('returns false when either side is unknown, rather than asserting clean', () => {
    // Undetectable is not the same as detected-clean. This function's false is
    // "no claim"; the provenance line still prints the endpoints, so an
    // undetectable case is still legible — it just carries no warning.
    expect(
      detectMergeRef(null, depsWith({ GITHUB_EVENT_NAME: 'pull_request' })),
    ).toBe(false);
    expect(
      detectMergeRef(
        MERGE_REF_HEAD,
        depsWith({ GITHUB_EVENT_NAME: 'pull_request' }),
      ),
    ).toBe(false);
  });

  it('survives an unreadable or malformed event payload', () => {
    const deps = depsWith({
      GITHUB_EVENT_NAME: 'pull_request',
      GITHUB_EVENT_PATH: '/nonexistent/event.json',
    });
    expect(detectMergeRef(MERGE_REF_HEAD, deps)).toBe(false);
  });
});
