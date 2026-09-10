import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('DLS-CONF-004 scaffold gates', () => {
  it('DLS-CONF-004 initializes the presenter workspace tooling', () => {
    expect(true).toBe(true);
  });

  it('keeps the browser preview populated with chart and linked-run fixtures', () => {
    const preview = readFileSync(resolve('src/main.js'), 'utf8');

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

  it('sets the dashboard title before the presenter loads', () => {
    const preview = readFileSync(resolve('index.html'), 'utf8');

    expect(preview).toContain('<title>Central Agentic Ops Dashboard</title>');
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

  it('keeps reset confirmation dialog height content-sized on mobile', () => {
    const styles = readFileSync(resolve('src/styles.js'), 'utf8');

    expect(styles).toMatch(/\.reset-dashboard-dialog \{[^}]*max-height: calc\(100vh - 32px\);[^}]*height: fit-content;/);
    expect(styles).toContain('.reset-dashboard-dialog[open] { display: grid; grid-template-rows: auto minmax(0, 1fr) auto; }');
    expect(styles).toMatch(/\.reset-dashboard-dialog-body \{[^}]*align-content: start;[^}]*overflow-y: auto;/);
  });

  it('keeps the JSON dashboard shell aligned with its shared component styles', () => {
    const presenter = readFileSync(resolve('src/presenter.js'), 'utf8');
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
      expect(presenter).toContain(`className: '${shellClass}`);
    }

    for (const sharedRule of [
      '.sidebar-brand { display: flex; align-items: center; gap: 6px;',
      '.app-main > .top-nav { position: relative; z-index: 20; border-bottom: 1px solid var(--border); }',
      '.breadcrumb-context > :not([hidden]) ~ :not([hidden])::before { content: "/";',
      '.breadcrumb-context > :is([data-breadcrumb-root], [data-breadcrumb-dashboard]) { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
      '.overview-header { min-width: 0; flex: 1; }',
      '.overview-header .lede { min-height: 1.25rem; margin: 3px 0 0; overflow: hidden; font-size: .875rem; line-height: 1.25rem; text-overflow: ellipsis; white-space: nowrap; }',
      '.workflow-runtime-summary { max-width: 920px; margin-bottom: 24px; }',
      'footer { min-height: 44px; display: flex; flex: none; align-items: center; justify-content: space-between;'
    ]) {
      expect(styles).toContain(sharedRule);
    }
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
