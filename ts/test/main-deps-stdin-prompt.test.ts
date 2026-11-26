/**
 * `defaultMainDeps().prompt` — the stdin-backed `makeStdinPrompt` (#1752).
 *
 * The real reader blocks until EOF, and a test runner's stdin never closes, so
 * `readStdinToEof` is mocked here (in its own file, so no other defaults test
 * sees the mock). What is under test is the prompt's own policy: read piped
 * stdin once, hand out one line per call, and fall back to the shown default
 * when a line is empty, when stdin runs out, or when stdin cannot be read.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const stdin = vi.hoisted(() => ({ read: vi.fn<() => string>() }));
vi.mock('../src/util/read-stdin.js', () => ({
  readStdinToEof: stdin.read,
}));

import { defaultMainDeps } from '../src/main-deps.js';

beforeEach(() => {
  stdin.read.mockReset();
});

describe('defaultMainDeps().prompt', () => {
  it('answers one piped line per call, then the default once stdin runs out', () => {
    stdin.read.mockReturnValue('alpha\nbeta');
    const { prompt } = defaultMainDeps();
    expect(prompt('first?', 'd1')).toBe('alpha');
    expect(prompt('second?', 'd2')).toBe('beta');
    expect(prompt('third?', 'd3')).toBe('d3');
    expect(prompt('fourth?', 'd4')).toBe('d4');
  });

  it('reads stdin once, not once per prompt', () => {
    stdin.read.mockReturnValue('only');
    const { prompt } = defaultMainDeps();
    prompt('a', 'x');
    prompt('b', 'y');
    prompt('c', 'z');
    expect(stdin.read).toHaveBeenCalledTimes(1);
  });

  it('takes the default for an empty line, without skipping the line after it', () => {
    stdin.read.mockReturnValue('\nnext\n');
    const { prompt } = defaultMainDeps();
    expect(prompt('blank?', 'kept')).toBe('kept');
    expect(prompt('next?', 'unused')).toBe('next');
    // The trailing newline leaves a final empty line: the default again.
    expect(prompt('trailing?', 'tail')).toBe('tail');
  });

  it('takes the default for every prompt when stdin is empty', () => {
    stdin.read.mockReturnValue('');
    const { prompt } = defaultMainDeps();
    expect(prompt('a', 'one')).toBe('one');
    expect(prompt('b', 'two')).toBe('two');
  });

  it('takes the default, without retrying the read, when stdin cannot be read', () => {
    stdin.read.mockImplementation(() => {
      throw Object.assign(new Error('EBADF: bad file descriptor'), {
        code: 'EBADF',
      });
    });
    const { prompt } = defaultMainDeps();
    expect(prompt('a', 'fallback-a')).toBe('fallback-a');
    expect(prompt('b', 'fallback-b')).toBe('fallback-b');
    expect(stdin.read).toHaveBeenCalledTimes(1);
  });

  it('gives each defaultMainDeps() its own read of stdin', () => {
    stdin.read.mockReturnValueOnce('first').mockReturnValueOnce('second');
    expect(defaultMainDeps().prompt('q', 'd')).toBe('first');
    expect(defaultMainDeps().prompt('q', 'd')).toBe('second');
  });
});
