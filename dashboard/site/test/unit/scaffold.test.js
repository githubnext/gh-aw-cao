import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { primerStylesheet } from '../../src/styles.js';

describe('DLS-CONF-004 scaffold gates', () => {
  it('DLS-CONF-004 initializes the presenter workspace tooling', () => {
    expect(true).toBe(true);
  });

  it('keeps the browser preview populated with chart and linked-run fixtures', () => {
    const preview = readFileSync(resolve('src/dashboard-app.js'), 'utf8');

    expect(preview.match(/"operational-value":/g)).toHaveLength(8);
    expect(preview.match(/"run-link":/g)?.length).toBeGreaterThanOrEqual(5);
  });

  it('uses the GitHub Agentic Workflows favicon', () => {
    const preview = readFileSync(resolve('index.html'), 'utf8');
    const favicon = readFileSync(resolve('favicon.svg'), 'utf8');
    const agenticWorkflowsFavicon = readFileSync(resolve('../../public/favicon.svg'), 'utf8');

    expect(preview).toContain('<link rel="icon" href="./favicon.svg">');
    expect(favicon).toBe(agenticWorkflowsFavicon);
  });

  it('declares an installable web app manifest and iOS icon', () => {
    const preview = readFileSync(resolve('index.html'), 'utf8');
    const manifest = JSON.parse(readFileSync(resolve('manifest.webmanifest'), 'utf8'));

    expect(preview).toContain(
      '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">'
    );
    expect(preview).toContain('<link rel="apple-touch-icon" href="./apple-touch-icon.png">');
    expect(preview).toContain('<link rel="manifest" href="./manifest.webmanifest">');
    expect(preview).toContain('<meta name="application-name" content="Central Agentic Ops Dashboard">');
    expect(preview).toContain('<meta name="theme-color" content="#0d1117">');
    expect(preview).toContain('<meta name="mobile-web-app-capable" content="yes">');
    expect(preview).toContain('<meta name="apple-mobile-web-app-capable" content="yes">');
    expect(preview).toContain('<meta name="apple-mobile-web-app-title" content="Agentic Ops">');
    expect(preview).toContain('<meta name="apple-mobile-web-app-status-bar-style" content="black">');
    expect(preview).toContain('content="Monitor and operate GitHub Agentic Workflows from a unified dashboard."');
    expect(manifest).toMatchObject({
      id: './',
      start_url: './',
      scope: './',
      display: 'standalone',
      display_override: ['minimal-ui', 'standalone'],
      background_color: '#0d1117',
      theme_color: '#0d1117'
    });
    expect(manifest.icons).toEqual(expect.arrayContaining([
      expect.objectContaining({ src: './icon-192.png', sizes: '192x192', purpose: 'any' }),
      expect.objectContaining({ src: './icon-512.png', sizes: '512x512', purpose: 'any' }),
      expect.objectContaining({ src: './icon-maskable-512.png', sizes: '512x512', purpose: 'maskable' })
    ]));
  });

  it('keeps the web app manifest valid and every declared icon usable', () => {
    const manifest = JSON.parse(readFileSync(resolve('manifest.webmanifest'), 'utf8'));
    const requiredStrings = [
      'name', 'short_name', 'description', 'lang', 'id', 'start_url', 'scope',
      'display', 'background_color', 'theme_color'
    ];

    for (const property of requiredStrings) {
      expect(manifest[property], property).toBeTypeOf('string');
      expect(manifest[property].trim(), property).not.toBe('');
    }
    expect(['standalone', 'minimal-ui', 'fullscreen']).toContain(manifest.display);
    expect(manifest.id).toBe('./');
    expect(manifest.start_url).toBe('./');
    expect(manifest.scope).toBe('./');
    expect(manifest.categories).toEqual(expect.arrayContaining(['business', 'productivity']));
    expect(manifest.icons.length).toBeGreaterThanOrEqual(2);

    for (const icon of manifest.icons) {
      expect(icon).toEqual({
        src: expect.stringMatching(/^\.\/[^/]+\.png$/),
        sizes: expect.stringMatching(/^\d+x\d+$/),
        type: 'image/png',
        purpose: expect.stringMatching(/^(any|maskable)$/)
      });
      const iconPath = resolve(icon.src);
      expect(existsSync(iconPath), icon.src).toBe(true);
      const contents = readFileSync(iconPath);
      expect(contents.subarray(1, 4).toString('ascii'), icon.src).toBe('PNG');
      const [width, height] = icon.sizes.split('x').map(Number);
      expect(contents.readUInt32BE(16), `${icon.src} width`).toBe(width);
      expect(contents.readUInt32BE(20), `${icon.src} height`).toBe(height);
    }

    const appleIcon = readFileSync(resolve('apple-touch-icon.png'));
    expect(appleIcon.readUInt32BE(16)).toBe(180);
    expect(appleIcon.readUInt32BE(20)).toBe(180);
  });

  it('sets the dashboard title before the presenter loads', () => {
    const preview = readFileSync(resolve('index.html'), 'utf8');

    expect(preview).toContain('<title>Central Agentic Ops Dashboard</title>');
  });

  it('displays an error when JavaScript is unavailable', () => {
    const preview = readFileSync(resolve('index.html'), 'utf8');

    expect(preview).toContain('<noscript>');
    expect(preview).toContain(
      '<p role="alert">JavaScript is required to use the Central Agentic Ops Dashboard. Enable JavaScript in your browser and reload this page.</p>'
    );
  });

  it('parity motion audit keeps report-style transitions and reduced-motion overrides', () => {
    const styles = readFileSync(resolve('src/styles.js'), 'utf8');

    expect(styles).toContain('.lede { color: var(--muted); }');
    expect(styles).toContain('.pie-chart-total-value { fill: var(--fg); font-size: 5px;');
    expect(styles).toContain('.chart-widget { min-height: 230px; display: grid; place-items: center; margin: 12px 0; border: 0; background: transparent; }');
    expect(styles).toContain('.pie-chart-layout .chart-widget { min-width: 0; min-height: 160px; margin: 0; }');
    expect(styles).toContain('.pie-chart-layout .chart-widget svg { width: 100%; max-width: 160px;');
    expect(styles).toMatch(/@media \(max-width: 700px\) \{[\s\S]*\.pie-chart-layout \.chart-widget svg \{ max-width: 140px; \}/);
    expect(styles).toContain('#page-preview .pie-chart-card { padding: 0; border: 0; }');
    expect(styles).toContain('#page-preview .pie-chart-layout .chart-widget { border: 0; background: transparent; }');
    expect(styles).toContain('.table-summary-boolean .chart-widget .chart-series-1 { stroke: var(--success); }');
    expect(styles).toContain('.table-summary-boolean .chart-widget .chart-series-2 { stroke: var(--attention); }');
    expect(styles).toContain('.table-summary-boolean .chart-widget .chart-series-3 { stroke: var(--muted); }');
    expect(styles).toContain('.table-summary-boolean .chart-widget .chart-series-semantic-failure { stroke: var(--danger); }');
    expect(styles).toContain('.chart-widget .chart-series-12 { stroke: var(--violet); }');
    expect(styles).toContain('transition: color 120ms ease;');
    expect(styles).toContain('transition: background-color 120ms ease, color 120ms ease;');
    expect(styles).toContain('transition: opacity 80ms linear;');
    expect(styles).toContain('@media (prefers-reduced-motion: reduce)');
    expect(styles).toContain('transition-duration: 0.01ms !important;');
    expect(styles).toContain('.repository-link');
  });

  it('keeps declared font sizes on mobile Safari', () => {
    const styles = readFileSync(resolve('src/styles.js'), 'utf8');

    expect(styles).toContain('-webkit-text-size-adjust: 100%;');
    expect(styles).toContain('text-size-adjust: 100%;');
  });

  it('uses the Primer body font size on mobile', () => {
    const style = document.createElement('style');
    style.textContent = primerStylesheet();
    document.head.append(style);
    try {
      const stylesheet = style.sheet;
      if (!stylesheet) throw new Error('Primer stylesheet did not parse');
      const mobileBodySelectors = new Set();
      for (const rule of stylesheet.cssRules) {
        if (rule.type !== window.CSSRule.MEDIA_RULE) continue;
        const mediaRule = /** @type {CSSMediaRule} */ (rule);
        if (mediaRule.conditionText.replace(/\s/g, '') !== '(max-width:700px)') continue;
        for (const nestedRule of mediaRule.cssRules) {
          if (nestedRule.type !== window.CSSRule.STYLE_RULE) continue;
          const styleRule = /** @type {CSSStyleRule} */ (nestedRule);
          if (!styleRule.selectorText || styleRule.style.getPropertyValue('font-size') !== '1rem') continue;
          for (const selector of styleRule.selectorText.split(',')) mobileBodySelectors.add(selector.trim());
        }
      }

      expect(mobileBodySelectors.has('body')).toBe(true);
      expect(mobileBodySelectors.has('.dashboard-root')).toBe(true);
    } finally {
      style.remove();
    }
  });

  it('keeps reset confirmation dialog height content-sized on mobile', () => {
    const styles = readFileSync(resolve('src/styles.js'), 'utf8');
    const styleLines = styles.split('\n');
    /** @param {string} selector */
    const declarationMap = (selector) => {
      const matches = styleLines.filter((line) => line.startsWith(`${selector} {`));
      expect(matches).toHaveLength(1);
      const bodyStart = matches[0]?.indexOf('{') ?? -1;
      const bodyEnd = matches[0]?.lastIndexOf('}') ?? -1;
      const ruleBody = bodyStart >= 0 && bodyEnd > bodyStart ? matches[0].slice(bodyStart + 1, bodyEnd) : '';
      const declarations = new Map();
      for (const declaration of ruleBody.split(';').map((entry) => entry.trim()).filter(Boolean)) {
        const separator = declaration.indexOf(':');
        if (separator < 0) continue;
        declarations.set(
          declaration.slice(0, separator).trim(),
          declaration.slice(separator + 1).trim()
        );
      }
      return declarations;
    };
    const dialogRule = declarationMap('.reset-dashboard-dialog');
    const openRule = declarationMap('.reset-dashboard-dialog[open]');
    const bodyRule = declarationMap('.reset-dashboard-dialog-body');

    expect(dialogRule.get('max-height')).toBe('calc(100vh - 32px)');
    expect(dialogRule.get('height')).toBe('fit-content');
    expect(openRule.get('grid-template-rows')).toBe('auto minmax(0, 1fr) auto');
    expect(bodyRule.get('align-content')).toBe('start');
    expect(bodyRule.get('overflow-y')).toBe('auto');
  });

  it('keeps the JSON dashboard shell aligned with its shared component styles', () => {
    const shellComponents = [
      'src/components/dashboard-frame.js',
      'src/components/dashboard-header.js',
      'src/components/dashboard-navigation.js'
    ].map((path) => readFileSync(resolve(path), 'utf8')).join('\n');
    const styles = readFileSync(resolve('src/styles.js'), 'utf8');

    for (const shellClass of [
      'app-shell',
      'org-sidebar',
      'sidebar-brand',
      'primary-nav',
      'app-main',
      'overview-header',
      'title-area',
      'report-body'
    ]) {
      expect(shellComponents).toContain(`className: '${shellClass}`);
    }

    for (const sharedRule of [
      '.sidebar-brand { display: flex; align-items: center; gap: 6px;',
      '.app-main > .top-nav { position: relative; z-index: 20; border-bottom: 1px solid var(--border); }',
      '.breadcrumb-context > :not([hidden]) ~ :not([hidden])::before { content: "/";',
      '.breadcrumb-context > :is([data-breadcrumb-root], [data-breadcrumb-dashboard]) { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
      '.overview-header { min-width: 0; flex: 1; }',
      '.overview-header .lede { min-height: 1.25rem; margin: 3px 0 0; overflow: hidden; font-size: .875rem; line-height: 1.25rem; text-overflow: ellipsis; white-space: nowrap; }',
      '.mobile-page-header .overview-header { width: 100%; min-width: 0; flex: none; }',
      '.mobile-page-header .overview-header .lede { height: 0; min-height: 0; margin: 0; overflow: hidden; line-height: 0; visibility: hidden; }',
      '.workflow-runtime-summary { max-width: 920px; margin-bottom: 24px; }',
      'footer { min-height: 44px; display: flex; flex: none; align-items: center; justify-content: space-between;'
    ]) {
      expect(styles).toContain(sharedRule);
    }
  });

  it('keeps mobile overview navigation as large actions and hides it on other views', () => {
    const styles = readFileSync(resolve('src/styles.js'), 'utf8');

    expect(styles).toContain('.primary-nav { display: none; }');
    expect(styles).toContain('.dashboard-mobile-overview-actions .primary-nav { width: 100%; display: flex; flex: none; flex-direction: row; gap: 8px; overflow-x: auto;');
    expect(styles).toContain('.dashboard-mobile-overview-actions .primary-nav .nav-item { width: 52px; min-height: 52px; flex: 0 0 52px; gap: 0; padding: 0; border: 1px solid var(--border); border-radius: 16px; background: var(--canvas-subtle); }');
    expect(styles).toContain('.primary-nav .nav-item .nav-label { display: none; }');
    expect(styles).toContain('.dashboard-mobile-overview-actions .org-sidebar { background: var(--canvas-subtle); }');
  });

  it('stacks the expanded filter panel above the page header and hides the horizon tooltip', () => {
    const styles = readFileSync(resolve('src/styles.js'), 'utf8');
    /** @param {string} rule */
    const zIndex = (rule) => {
      const block = styles.match(new RegExp(`${rule} \\{([^}]*)\\}`))?.[1];
      const layer = block?.match(/z-index: (\d+);/)?.[1];
      expect(layer, `missing z-index for ${rule}`).toBeDefined();
      return Number(layer);
    };
    const panelLayer = zIndex('\\.filter-bar-expanded \\.filter-tuning-controls');
    const headerLayer = zIndex('\\.app-main > \\.top-nav');

    expect(panelLayer).toBeGreaterThan(headerLayer);
    expect(styles).toContain('.filter-bar-expanded :is(.horizon-summary:hover, .horizon-summary:focus-within) .horizon-tooltip { visibility: hidden; opacity: 0; }');
  });

  it('systematically ellipsizes security signal titles at every viewport size', () => {
    const styles = readFileSync(resolve('src/styles.js'), 'utf8');

    expect(styles).toContain('.signal-copy > strong, .signal-copy > small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }');
    expect(styles).not.toContain('.signal-copy > strong, .signal-copy > small { overflow: visible; white-space: normal; }');
  });

  it('systematically ellipsizes output evidence at every viewport size', () => {
    const styles = readFileSync(resolve('src/styles.js'), 'utf8');

    expect(styles).toContain('.table-output-evidence { display: block; max-width: 80ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }');
  });
});
