// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderEffect } from '../../src/components/experiment-effect.js';

describe('experiment effect indicator', () => {
  it('renders a positive effect with an improvement description', () => {
    const element = renderEffect(0.125);
    expect(element.className).toBe('effect effect-positive');
    expect(element.textContent).toContain('+0.125');
    expect(element.textContent).toContain('▲');
    expect(element.querySelector('.sr-only')?.textContent).toContain('improvement');
  });

  it('renders a negative effect with a regression description', () => {
    const element = renderEffect(-0.5);
    expect(element.className).toBe('effect effect-negative');
    expect(element.textContent).toContain('-0.500');
    expect(element.textContent).toContain('▼');
    expect(element.querySelector('.sr-only')?.textContent).toContain('regression');
  });

  it('renders a neutral effect for exactly zero', () => {
    const element = renderEffect(0);
    expect(element.className).toBe('effect effect-neutral');
    expect(element.textContent).toContain('·');
    expect(element.querySelector('.sr-only')?.textContent).toContain('no change');
  });

  it('renders an unknown state for non-finite values', () => {
    const element = renderEffect(NaN);
    expect(element.className).toBe('effect effect-unknown');
    expect(element.textContent).toContain('—');
    expect(element.querySelector('.sr-only')?.textContent).toContain('insufficient evidence');
  });
});
