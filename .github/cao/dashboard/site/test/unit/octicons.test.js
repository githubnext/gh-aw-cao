// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { octicon } from '../../src/octicons.js';

describe('octicons', () => {
  it('renders the report-compatible issue glyph without a missing sprite reference', () => {
    const rendered = octicon('issue');

    expect(rendered.classList.contains('octicon-issue')).toBe(true);
    expect(rendered.querySelector('path')?.getAttribute('d')).toBe(
      'M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1Zm0 12.5a5.5 5.5 0 1 1 0-11 5.5 5.5 0 0 1 0 11Zm-.75-9.25a.75.75 0 0 1 1.5 0v3a.75.75 0 0 1-1.5 0ZM8 9.5a1 1 0 1 1 0 2 1 1 0 0 1 0-2Z'
    );
    expect(rendered.querySelector('use')).toBeNull();
  });

  it('continues to render packaged Octicons through the sprite', () => {
    const rendered = octicon('alert');

    expect(rendered.querySelector('use')?.getAttribute('href')).toMatch(/\/src\/octicons\.svg#octicon-alert$/);
  });
});
