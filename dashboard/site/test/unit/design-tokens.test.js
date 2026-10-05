import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import tokens from '../../src/design-tokens.json' with { type: 'json' };
import { primerStylesheet } from '../../src/styles.js';

/** @param {string} color */
function luminance(color) {
  const components = color.slice(1).match(/../g);
  if (!components) throw new Error(`Expected an RGB hex color: ${color}`);
  const [r, g, b] = components.map((component) => {
    const value = parseInt(component, 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return r * 0.2126 + g * 0.7152 + b * 0.0722;
}

describe('Agentic Workflows docs design tokens', () => {
  it('defines the same semantic properties for every theme', () => {
    expect(Object.keys(tokens.light).sort()).toEqual(Object.keys(tokens.dark).sort());
    expect(tokens.typography['font-sans']).toMatch(/^"CAO Sans",/);
    expect(tokens.typography['font-mono']).toContain('ui-monospace');
    expect(tokens.dark.canvas).toBe('#0c0a09');
    expect(tokens.light.canvas).toBe('#fcfcfb');
    expect(tokens.dark.accent).toBe('#c3b5e4');
    expect(tokens.light.accent).toBe('#5f489a');
  });

  it('keeps small text, links, and semantic status colors readable on both canvases', () => {
    for (const theme of [tokens.light, tokens.dark]) {
      for (const background of [theme.canvas, theme['canvas-subtle']]) {
        for (const name of /** @type {const} */ (['fg', 'muted', 'accent', 'success', 'danger', 'attention', 'coral', 'cancelled'])) {
          const foregroundLuminance = luminance(theme[name]);
          const backgroundLuminance = luminance(background);
          const contrast = (Math.max(foregroundLuminance, backgroundLuminance) + 0.05)
            / (Math.min(foregroundLuminance, backgroundLuminance) + 0.05);
          expect(contrast, `${name} on ${background}`).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });

  it('uses one token source for system, explicit, and first-load themes', () => {
    const css = primerStylesheet();
    expect(css).toContain('@media (prefers-color-scheme:light)');
    for (const name of /** @type {const} */ (['light', 'dark'])) {
      expect(css).toContain(`:is(.dashboard-root, .first-load-overlay)[data-theme="${name}"]{color-scheme:${name}`);
      for (const [token, value] of Object.entries(tokens[name])) {
        expect(css).toContain(`--${token}:${value}`);
      }
    }
    expect(css).toContain('font-optical-sizing:auto');
    expect(css).toContain('font-weight:400;letter-spacing:var(--tracking-tight)');
  });

  it('ships licensed, locally served normal and italic variable fonts', () => {
    for (const filename of ['CAOSansVF.woff2', 'CAOSansVF-Italic.woff2']) {
      const font = readFileSync(resolve('src/fonts', filename));
      expect(font.subarray(0, 4).toString('ascii')).toBe('wOF2');
      expect(font.readUInt32BE(8)).toBe(font.length);
      expect(font.length).toBeLessThanOrEqual(256 * 1024);
    }
    const license = readFileSync(resolve('src/fonts/MonaSans-LICENSE.txt'), 'utf8');
    expect(license).toContain('SIL OPEN FONT LICENSE');
    const css = primerStylesheet();
    expect(css).toContain('font-style:normal;font-weight:200 900');
    expect(css).toContain('font-style:italic;font-weight:200 900');
    expect(css).toContain('font-display:swap');
    expect(css).not.toContain('fonts.googleapis.com');
    const index = readFileSync(resolve('index.html'), 'utf8');
    expect(index).toContain('href="./src/fonts/CAOSansVF.woff2" as="font" type="font/woff2" crossorigin');
  });
});
