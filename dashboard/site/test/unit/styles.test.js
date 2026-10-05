import { describe, expect, it } from 'vitest';
import { getPrimerStyles, notificationStylesheet, primerStylesheet } from '../../src/styles.js';

describe('shared stylesheets', () => {
  it('preserves the public Primer stylesheet alias', () => {
    expect(getPrimerStyles).toBe(primerStylesheet);
  });

  it('composes style sections in cascade order with global overrides last', () => {
    const css = primerStylesheet();
    const selectors = [
      ':root{',
      '.app-shell{',
      '.dashboard-pages{',
      '.chart-widget{',
      '.metric-link a, .custom-table a{',
      '.notifications-inbox{',
      'main.dashboard-prototype:has(.dashboard-overview-page:not([hidden])){',
      '.dashboard-next-work-page .custom-view-grid{',
      'table{',
      '@media (min-width:701px) and (max-width:900px){',
      '@media (prefers-reduced-motion:reduce){html{',
      '@media (forced-colors:active){',
      '@media print{'
    ];
    let previousIndex = -1;
    for (const selector of selectors) {
      const index = css.indexOf(selector, previousIndex + 1);
      expect(index, selector).toBeGreaterThan(previousIndex);
      previousIndex = index;
    }
  });

  it('keeps notification-only styles independent of the Primer shell', () => {
    const css = notificationStylesheet();

    expect(css).toContain('.dashboard-notifications{');
    expect(css).toContain('.dashboard-notification-toggle[aria-expanded="true"]');
    expect(css).toContain('@media (max-width:700px){');
    expect(css).toContain('@media (prefers-reduced-motion:reduce){');
    expect(css).not.toContain('.app-shell');
    expect(primerStylesheet()).not.toContain('.dashboard-notifications{');
  });

  it('preserves quoted content and fonts when minifying composed styles', () => {
    const css = primerStylesheet();

    expect(css).toContain('"Segoe UI"');
    expect(css).toContain('content:"Hide details"');
    expect(css).not.toContain('@@CSS_STR_');
    expect(notificationStylesheet()).not.toContain('@@CSS_STR_');
  });
});
