import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Widget } from '../src/widget';

describe('Widget', () => {
  it('renders the label', () => {
    expect(render(Widget).text).toBe('hello');
  });
});
