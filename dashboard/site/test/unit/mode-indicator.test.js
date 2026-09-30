import { describe, expect, it } from 'vitest';
import { resolveModeIndicator } from '../../src/components/mode-indicator.js';

describe('mode indicator component', () => {
  it('reports review when the mode query parameter is review', () => {
    expect(resolveModeIndicator('?mode=review')).toBe('review');
  });

  it('reports live when the mode query parameter is live', () => {
    expect(resolveModeIndicator('?mode=live')).toBe('live');
  });

  it('reports an empty string for an unrecognized mode value', () => {
    expect(resolveModeIndicator('?mode=draft')).toBe('');
  });

  it('reports an empty string when no mode parameter is present', () => {
    expect(resolveModeIndicator('')).toBe('');
    expect(resolveModeIndicator('?other=1')).toBe('');
  });

  it('ignores unrelated query parameters alongside mode', () => {
    expect(resolveModeIndicator('?campaign=daily-ops&mode=live&sort=asc')).toBe('live');
  });
});
