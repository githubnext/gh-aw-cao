// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { createAnimatedNumber } from '../../src/components/animated-number.js';

it('reactively replaces animated number content and stops with its owner', () => {
  const lifetime = new AbortController();
  const counter = createAnimatedNumber({ animate: true, signal: lifetime.signal });

  counter.set({ text: '2', target: 2, href: '#page-runs' });
  expect(counter.element.querySelector('a')?.textContent).toBe('2');
  expect(counter.element.querySelector('.metric-number-animated')?.getAttribute('style')).toContain('--metric-number-target: 2');

  lifetime.abort();
  counter.set({ text: '3', target: 3 });
  expect(counter.element.textContent).toBe('2');
});
