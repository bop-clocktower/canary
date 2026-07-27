/**
 * Tests for the `feedback` port (`agent/core/feedback.py`,
 * `tests/unit/test_feedback_command.py`). Only the pure-core `TestFeedbackCore`
 * cases port here — the `TestFeedbackCli` cases exercise the typer CLI, which is
 * outside this module's scope.
 */

import { describe, expect, it } from 'vitest';

import {
  VALID_CATEGORIES,
  buildFeedback,
  buildIssueUrl,
  collectContext,
} from '../src/core/feedback.js';

describe('feedback core', () => {
  it('context has non-sensitive fields only', () => {
    const ctx = collectContext();
    expect(ctx).toHaveProperty('version');
    expect(ctx).toHaveProperty('os');
    expect(ctx).toHaveProperty('python');
    // Must never leak env vars or file contents.
    const joined = JSON.stringify(ctx).toLowerCase();
    expect(joined).not.toContain('secret');
    expect(joined).not.toContain('token');
    expect(joined).not.toContain('api_key');
  });

  it('build_feedback bundles message, category, context', () => {
    const fb = buildFeedback('login button is broken', 'bug');
    expect(fb.category).toBe('bug');
    expect(fb.message).toBe('login button is broken');
    expect(fb).toHaveProperty('context');
    expect(fb).toHaveProperty('issue_url');
  });

  it('issue url is prefilled and encoded', () => {
    const url = buildIssueUrl('bug', 'spaces and & symbols', {
      version: '5.11.0',
    });
    const parsed = new URL(url);
    expect(parsed.host).toContain('github.com');
    expect(parsed.pathname.endsWith('/issues/new')).toBe(true);
    const q = parsed.searchParams;
    // Title carries the category; body carries the message + context.
    expect((q.get('title') ?? '').toLowerCase()).toContain('bug');
    expect(q.get('body')).toContain('spaces and & symbols');
    expect(q.get('body')).toContain('5.11.0');
    expect(q.has('labels')).toBe(true);
  });

  it('valid categories', () => {
    expect(VALID_CATEGORIES).toEqual(['bug', 'ux', 'docs', 'idea']);
  });

  // Regression (adversarial review, Divergence B): Python `message[:60]` slices
  // by code point; JS `slice` by UTF-16 unit, so a run of astral chars would
  // truncate the title 2x early. 40 emoji + tail is 43 code points (< 60) so
  // the tail must survive in the title.
  it('title slices by code point (astral chars do not truncate early)', () => {
    const message = '\u{1F600}'.repeat(40) + 'TAIL';
    const url = buildIssueUrl('bug', message, { version: '5.11.0' });
    const title = new URL(url).searchParams.get('title') ?? '';
    expect(title).toContain('TAIL');
  });
});
