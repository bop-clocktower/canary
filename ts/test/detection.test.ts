/**
 * Faithful TypeScript port of `tests/unit/test_detection.py`.
 *
 * The shared "fail loud" auto-detection helper: uncertainDetectionMessage()
 * renders one clear, actionable message so every uncertain-detection path
 * reads the same way instead of each call site inventing its own ad hoc string.
 */

import { describe, expect, it } from 'vitest';

import { uncertainDetectionMessage } from '../src/core/detection.js';

describe('uncertainDetectionMessage', () => {
  it('names what could not be detected', () => {
    const msg = uncertainDetectionMessage('test framework');
    expect(msg).toContain('test framework');
  });

  it('includes override hint when given', () => {
    const msg = uncertainDetectionMessage('test framework', {
      overrideHint: '--framework <name>',
    });
    expect(msg).toContain('--framework <name>');
  });

  it('includes candidates when given', () => {
    const msg = uncertainDetectionMessage('test framework', {
      candidates: ['playwright', 'pytest', 'wdio'],
    });
    expect(msg).toContain('playwright');
    expect(msg).toContain('pytest');
    expect(msg).toContain('wdio');
  });

  it('includes reason when given', () => {
    const msg = uncertainDetectionMessage('test framework', {
      reason: 'no config file or dependency matched',
    });
    expect(msg).toContain('no config file or dependency matched');
  });

  it('never returns a bare "unknown"', () => {
    const msg = uncertainDetectionMessage('test framework');
    expect(msg.trim().toLowerCase()).not.toBe('unknown');
    expect(msg.length).toBeGreaterThan('unknown'.length);
  });

  it('is a single string carrying every supplied piece', () => {
    const msg = uncertainDetectionMessage('doctor persona', {
      candidates: ['frontend', 'backend'],
      overrideHint: '--persona <tag>',
      reason: 'no --persona flag was given',
    });
    expect(typeof msg).toBe('string');
    expect(msg).toContain('doctor persona');
    expect(msg).toContain('frontend');
    expect(msg).toContain('--persona <tag>');
  });

  it('empty candidates omits the candidates section', () => {
    const msg = uncertainDetectionMessage('test framework', { candidates: [] });
    // Should not print an empty "Known test framework(s): ." clause.
    expect(msg).not.toContain('Known test framework');
  });

  // Extra (not in the Python oracle): pin the exact byte-for-byte rendering
  // with every clause present, guarding the join/format against drift.
  it('renders the exact full message text', () => {
    const msg = uncertainDetectionMessage('doctor persona', {
      reason: 'no --persona flag was given',
      candidates: ['frontend', 'backend'],
      overrideHint: '--persona <tag>',
    });
    expect(msg).toBe(
      'Could not confidently auto-detect the doctor persona. ' +
        'Reason: no --persona flag was given. ' +
        'Known doctor persona(s): frontend, backend. ' +
        'Set it explicitly with --persona <tag>.',
    );
  });

  it('renders just the lead sentence with no options', () => {
    expect(uncertainDetectionMessage('test framework')).toBe(
      'Could not confidently auto-detect the test framework.',
    );
  });
});
