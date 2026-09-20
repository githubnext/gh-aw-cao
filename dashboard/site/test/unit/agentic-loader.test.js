import { afterEach, describe, expect, it } from 'vitest';
import { renderAgenticLoader } from '../../src/components/agentic-loader.js';
import { agenticLoaderStylesheet } from '../../src/components/agentic-loader-styles.js';

afterEach(() => {
  document.body.replaceChildren();
});

describe('agentic loader', () => {
  it('renders the rhythm wave and outlined riders', () => {
    const loader = renderAgenticLoader({ label: 'Loading view', compact: true });
    document.body.append(loader);

    expect(loader.getAttribute('role')).toBe('status');
    expect(loader.getAttribute('aria-label')).toBe('Loading view');
    expect(loader.classList.contains('agentic-loader-compact')).toBe(true);
    expect(loader.querySelector('.agentic-loader-brand')).toBeNull();
    expect(loader.querySelectorAll('.agentic-loader-rhythm i')).toHaveLength(13);
    expect(loader.querySelectorAll('.agentic-loader-rider')).toHaveLength(3);
    expect(loader.querySelectorAll('img.agentic-loader-rider-icon')).toHaveLength(3);
    expect(loader.querySelector('.agentic-loader-caption-eyebrow')?.textContent)
      .toBe('Agentic campaigns');
    expect(loader.querySelector('.agentic-loader-caption-text')?.textContent)
      .toBe('Loading activity');
    expect(loader.querySelectorAll('.agentic-loader-caption')).toHaveLength(1);
    expect(loader.querySelectorAll('.agentic-loader-caption-dots')).toHaveLength(1);
    expect(loader.querySelectorAll('.agentic-loader-caption-dot')).toHaveLength(3);
    expect(loader.querySelector('.agentic-loader-rider-icon-duck')?.getAttribute('src'))
      .toBe('./src/assets/loaders/duck.svg?v=filled-1');
    expect(loader.querySelector('.agentic-loader-rider-icon-octocat')?.getAttribute('src'))
      .toBe('./src/assets/loaders/octocat.svg?v=filled-1');
    expect(loader.querySelector('.agentic-loader-rider-icon-copilot')?.getAttribute('src'))
      .toBe('./src/assets/loaders/copilot.svg?v=filled-1');
    expect(loader.querySelector('.agentic-loader-stages')).toBeNull();
    expect(loader.querySelector('.agentic-loader-sparkle')).toBeNull();
    expect(loader.querySelector('.agentic-loader-copy')).toBeNull();
  });

  it('uses the website logo colors and sends the rhythm wave from left to right', () => {
    const styles = agenticLoaderStylesheet();

    expect(styles).toContain('--agentic-logo-purple: #c06eff');
    expect(styles).toContain('animation: agentic-loader-wave 6.6s ease-in-out infinite');
    expect(styles).toContain('i:nth-of-type(1) { animation-delay: -6s; }');
    expect(styles).toContain('i:nth-of-type(7) { animation-delay: -3.6s; }');
    expect(styles).toContain('i:nth-of-type(13) { animation-delay: -1.2s; }');
    expect(styles).toContain('@keyframes agentic-loader-bar-color-1');
    expect(styles).toContain('@keyframes agentic-loader-bar-color-7');
    expect(styles).toContain('@keyframes agentic-loader-bar-color-13');
    expect(styles).toContain('animation-duration: 19.8s');
    expect(styles).toContain('3.030% { background: linear-gradient(180deg, color-mix(in srgb, var(--agentic-rider-yellow) 100%');
    expect(styles).toContain('29.505% { background: linear-gradient(180deg, color-mix(in srgb, var(--agentic-rider-yellow) 20%');
    expect(styles).toContain('32.535% { background: linear-gradient(180deg, color-mix(in srgb, var(--agentic-rider-yellow) 0%');
    expect(styles).toContain('var(--agentic-rider-yellow)');
    expect(styles).toContain('var(--agentic-rider-pink)');
    expect(styles).toContain('var(--agentic-rider-blue)');
    expect(styles).not.toContain('i:nth-of-type(2),');
    expect(styles).toContain('.agentic-loader-rider-duck { color: var(--yellow);');
    expect(styles).toContain('.agentic-loader-rider-octocat { color: var(--agentic-logo-purple);');
    expect(styles).toContain('.agentic-loader-rider-copilot { color: var(--accent);');
    expect(styles).toContain('.agentic-loader-rider-duck { color: var(--yellow); offset-path: path("M 20 40 L 428 40")');
    expect(styles).toContain('.agentic-loader-rider-octocat { color: var(--agentic-logo-purple); offset-path: path("M 20 40 L 428 40")');
    expect(styles).toContain('.agentic-loader-rider-copilot { color: var(--accent); offset-path: path("M 20 40 L 428 40")');
    expect(styles).toContain('offset-rotate: auto');
    expect(styles).toContain('animation: agentic-loader-rider-cruise 19.8s linear infinite');
    expect(styles).toContain('animation-delay: -13.2s');
    expect(styles).toContain('3.03% { opacity: 1; offset-distance: 9.314%; }');
    expect(styles).toContain('29.505% { opacity: 1; offset-distance: 90.686%; }');
    expect(styles).toContain('32.535% { opacity: 0; offset-distance: 100%; }');
    expect(styles).toContain('animation: agentic-loader-reveal 0s linear 300ms forwards');
    expect(styles).toContain('animation: agentic-loader-caption-dot 1.2s ease-in-out infinite');
    expect(styles).toContain('color: var(--fgColor-default, #f0f6fc)');
    expect(styles).toContain('text-transform: uppercase');
    expect(styles).toContain('background: var(--fgColor-default, #f0f6fc)');
    expect(styles).toContain('@keyframes agentic-loader-rider-cruise');
    expect(styles).toContain('> .factory-stations { visibility: hidden; }');
  });
});
