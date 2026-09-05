// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { completenessCaveat, coverageWindowHours, copyTextToClipboard, createCopyControl, formatMediumUtcDate, formatMediumUtcDateTime, formatUtcDateTime, isPlainObject, isSafeHttpsUrl, renderCloseButton, renderDlRow, renderEmptyTableRow, renderIconSpan, renderIdentityLink, renderLabeledControl, renderLegendList, renderLegendSwatch, renderListWithFallback, renderSectionHeading, renderTableHeadRow, renderTableSummaryEmpty, renderTooltip, renderVitalStat } from '../../src/components/ui-primitives.js';

describe('ui primitives', () => {
  it('renders shared section-heading markup with configurable heading levels', () => {
    const rendered = renderSectionHeading({
      kicker: 'Current decision window',
      id: 'overview-heading',
      title: 'Overview',
      description: 'Daily status',
      summary: '3 signals',
      headingTag: 'h2'
    });

    expect(rendered.className).toBe('section-heading');
    expect(rendered.querySelector('.scope-kicker')?.textContent).toBe('Current decision window');
    expect(rendered.querySelector('h2')?.id).toBe('overview-heading');
    expect(rendered.querySelector('h2')?.textContent).toBe('Overview');
    expect(rendered.querySelector('p')?.textContent).toBe('Daily status');
    expect(rendered.querySelector('strong')?.textContent).toBe('3 signals');
  });

  it('omits the summary node when no summary is provided', () => {
    const rendered = renderSectionHeading({
      kicker: 'Workflow topology',
      id: 'topology-heading',
      title: 'Orchestrator and workers'
    });

    expect(rendered.querySelector('h3')?.textContent).toBe('Orchestrator and workers');
    expect(rendered.querySelector('strong')).toBeNull();
  });

  it('renders shared vital stats with and without detail text', () => {
    const withDetail = renderVitalStat('Root episodes', 4, 'observed orchestrator runs');
    const withoutDetail = renderVitalStat('Measured AIC', '—');

    expect(withDetail.textContent).toBe('Root episodes4observed orchestrator runs');
    expect(withDetail.querySelector('dt')?.textContent).toBe('Root episodes');
    expect(withDetail.querySelector('dd')?.textContent).toBe('4');
    expect(withDetail.querySelector('p')?.textContent).toBe('observed orchestrator runs');
    expect(withoutDetail.textContent).toBe('Measured AIC—');
    expect(withoutDetail.querySelector('p')).toBeNull();
  });

  it('renders the shared dt/dd row primitive used across metadata and stat lists', () => {
    const row = renderDlRow('Freshness', 'Fresh', 'Updated moments ago');
    expect(row.querySelector('dt')?.textContent).toBe('Freshness');
    expect(row.querySelector('dd')?.textContent).toBe('Fresh');
    expect(row.querySelector('p')?.textContent).toBe('Updated moments ago');

    const compositeTerm = renderDlRow([document.createTextNode('!'), 'Label'], 'Value');
    expect(compositeTerm.querySelector('dt')?.textContent).toBe('!Label');
    expect(compositeTerm.querySelector('p')).toBeNull();
  });

  it('renders a shared table head row of scope="col" cells from plain labels', () => {
    const headRow = renderTableHeadRow(['Package', 'Runs', 'Failed']);
    const headCells = headRow.querySelectorAll('th');

    expect(headRow.tagName).toBe('TR');
    expect(headCells).toHaveLength(3);
    expect(Array.from(headCells).map((cell) => cell.textContent)).toEqual(['Package', 'Runs', 'Failed']);
    expect(Array.from(headCells).every((cell) => cell.getAttribute('scope') === 'col')).toBe(true);
  });

  it('renders accessible tooltip semantics around arbitrary rich content', () => {
    const tooltip = renderTooltip({
      id: 'example-tooltip',
      label: 'Example details',
      description: 'Additional context.',
      icon: document.createTextNode('?'),
      content: document.createElement('strong')
    });

    expect(tooltip.querySelector('.tooltip-trigger')?.getAttribute('aria-label')).toBe('Example details');
    expect(tooltip.querySelector('.tooltip-trigger')?.getAttribute('aria-describedby')).toBe('example-tooltip');
    expect(tooltip.querySelector('.tooltip-content')?.getAttribute('role')).toBe('tooltip');
    expect(tooltip.querySelector('.tooltip-description')?.textContent).toBe('Additional context.');
    expect(tooltip.querySelector('.tooltip-content strong')).not.toBeNull();
  });

  it('formats UTC date-time text and preserves the unavailable fallback', () => {
    expect(formatUtcDateTime('2026-08-30T10:00:00Z')).toBe('Aug 30, 2026, 10:00 AM');
    expect(formatUtcDateTime('not-a-date')).toBe('Time unavailable');
  });

  it('formats a Date or millisecond timestamp as medium-date, short-time UTC text', () => {
    expect(formatMediumUtcDateTime(new Date('2026-08-30T10:00:00Z'))).toBe('Aug 30, 2026, 10:00 AM');
    expect(formatMediumUtcDateTime(Date.parse('2026-08-30T10:00:00Z'))).toBe('Aug 30, 2026, 10:00 AM');
  });

  it('formats a Date or millisecond timestamp as medium-date-only UTC text', () => {
    expect(formatMediumUtcDate(new Date('2026-08-30T10:00:00Z'))).toBe('Aug 30, 2026');
    expect(formatMediumUtcDate(Date.parse('2026-08-30T10:00:00Z'))).toBe('Aug 30, 2026');
  });

  it('computes whole-hour coverage windows and rejects invalid or non-increasing bounds', () => {
    expect(coverageWindowHours({ 'coverage-start': '2026-08-30T00:00:00Z', 'coverage-end': '2026-08-30T05:00:00Z' })).toBe(5);
    expect(coverageWindowHours({ 'coverage-start': '2026-08-30T05:00:00Z', 'coverage-end': '2026-08-30T00:00:00Z' })).toBeNull();
    expect(coverageWindowHours({ 'coverage-start': 'not-a-date', 'coverage-end': '2026-08-30T05:00:00Z' })).toBeNull();
    expect(coverageWindowHours(undefined)).toBeNull();
  });

  it('builds a completeness caveat sentence for a named subject', () => {
    expect(completenessCaveat('partial', 'usage')).toBe('Partial usage coverage.');
    expect(completenessCaveat('unknown', 'run')).toBe('Run coverage is unknown.');
    expect(completenessCaveat('complete', 'usage')).toBe('');
    expect(completenessCaveat(undefined, 'usage')).toBe('');
  });

  it('renders the shared table-summary empty-state placeholder with the given message', () => {
    const rendered = renderTableSummaryEmpty('No timestamps');
    expect(rendered.tagName).toBe('SPAN');
    expect(rendered.className).toBe('table-summary-empty');
    expect(rendered.textContent).toBe('No timestamps');
  });

  it('renders the shared list-with-fallback pattern for populated and empty item sets', () => {
    const populated = renderListWithFallback('my-list', [1, 2], (value) => `item ${value}`, 'No items.');
    expect(populated.tagName).toBe('UL');
    expect(populated.className).toBe('my-list');
    expect([...populated.querySelectorAll('li')].map((li) => li.textContent)).toEqual(['item 1', 'item 2']);

    const empty = renderListWithFallback('my-list', [], (value) => `item ${value}`, 'No items.');
    expect(empty.querySelectorAll('li')).toHaveLength(1);
    expect(empty.textContent).toBe('No items.');
  });

  it('renders the shared empty-table-row placeholder spanning the given column count', () => {
    const rendered = renderEmptyTableRow(8, 'No packages discovered.');

    expect(rendered.tagName).toBe('TR');
    const cell = rendered.querySelector('td');
    expect(cell?.getAttribute('colspan')).toBe('8');
    expect(rendered.textContent).toBe('No packages discovered.');
  });

  it('renders the shared decorative legend swatch with the requested class and aria-hidden', () => {
    const rendered = renderLegendSwatch('chart-series-a');

    expect(rendered.tagName).toBe('I');
    expect(rendered.className).toBe('chart-series-a');
    expect(rendered.getAttribute('aria-hidden')).toBe('true');
  });

  it('renders a legend list pairing a swatch with per-item content and any extra list attributes', () => {
    const rendered = renderLegendList(
      'chart-legend chart-legend-line',
      ['alpha', 'beta'],
      (item, index) => `chart-series-${index}`,
      (item) => [`label ${item}`],
      { 'data-chart-legend': 'visual' }
    );

    expect(rendered.tagName).toBe('UL');
    expect(rendered.className).toBe('chart-legend chart-legend-line');
    expect(rendered.getAttribute('data-chart-legend')).toBe('visual');
    const items = rendered.querySelectorAll('li');
    expect(items).toHaveLength(2);
    expect(items[0].querySelector('i')?.className).toBe('chart-series-0');
    expect(items[0].textContent).toBe('label alpha');
    expect(items[1].querySelector('i')?.className).toBe('chart-series-1');
    expect(items[1].textContent).toBe('label beta');
  });

  it('renders the shared icon span with the requested class and a single octicon', () => {
    const rendered = renderIconSpan('signal-icon', 'check-circle');

    expect(rendered.tagName).toBe('SPAN');
    expect(rendered.className).toBe('signal-icon');
    expect(rendered.hasAttribute('aria-hidden')).toBe(false);
    expect(rendered.querySelector('svg use')?.getAttribute('href')).toContain('#octicon-check-circle');
  });

  it('renders the shared icon span with aria-hidden when requested', () => {
    const rendered = renderIconSpan('readiness-verdict-icon', 'x-circle', { ariaHidden: true });

    expect(rendered.getAttribute('aria-hidden')).toBe('true');
    expect(rendered.querySelector('svg use')?.getAttribute('href')).toContain('#octicon-x-circle');
  });

  it('renders the shared close/dismiss icon button with matching title and aria-label text', () => {
    const onClick = () => {};
    const rendered = renderCloseButton({
      className: 'site-callout-dismiss',
      label: 'Dismiss Notice',
      onClick
    });

    expect(rendered.tagName).toBe('BUTTON');
    expect(rendered.getAttribute('type')).toBe('button');
    expect(rendered.className).toBe('site-callout-dismiss');
    expect(rendered.getAttribute('title')).toBe('Dismiss Notice');
    expect(rendered.getAttribute('aria-label')).toBe('Dismiss Notice');
    expect(rendered.querySelector('svg use')?.getAttribute('href')).toContain('#octicon-x');
  });

  it('renders the shared identity link with an icon, label element, and optional class name', () => {
    const withStrong = renderIdentityLink({
      href: '#page-package-insights?package=self-care',
      icon: 'package',
      label: 'SelfCare',
      className: 'package-status-identity',
      labelTag: 'strong'
    });

    expect(withStrong.tagName).toBe('A');
    expect(withStrong.getAttribute('href')).toBe('#page-package-insights?package=self-care');
    expect(withStrong.className).toBe('package-status-identity');
    expect(withStrong.querySelector('svg use')?.getAttribute('href')).toContain('#octicon-package');
    expect(withStrong.querySelector('strong')?.textContent).toBe('SelfCare');

    const withDefaultLabelTag = renderIdentityLink({
      href: '#page-package-insights?package=dashboard',
      icon: 'graph',
      label: 'Dashboard'
    });

    expect(withDefaultLabelTag.className).toBe('');
    expect(withDefaultLabelTag.querySelector('span')?.textContent).toBe('Dashboard');
  });

  it('identifies plain objects while rejecting arrays and null', () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject({ foo: 'bar' })).toBe(true);
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject(null)).toBe(false);
    expect(isPlainObject('string')).toBe(false);
    expect(isPlainObject(42)).toBe(false);
    expect(isPlainObject(undefined)).toBe(false);
  });

  it('accepts https URLs with no embedded credentials and rejects everything else', () => {
    expect(isSafeHttpsUrl('https://example.com/path')).toBe(true);
    expect(isSafeHttpsUrl('http://example.com')).toBe(false);
    expect(isSafeHttpsUrl('https://user:pass@example.com')).toBe(false);
    expect(isSafeHttpsUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeHttpsUrl('not a url')).toBe(false);
    expect(isSafeHttpsUrl('')).toBe(false);
    expect(isSafeHttpsUrl(null)).toBe(false);
    expect(isSafeHttpsUrl(42)).toBe(false);
  });

  it('renders a labeled control wrapping the given control node', () => {
    const input = document.createElement('input');
    const rendered = renderLabeledControl('Filter rows', input);

    expect(rendered.tagName).toBe('LABEL');
    expect(rendered.className).toBe('');
    expect(rendered.querySelector('span')?.textContent).toBe('Filter rows');
    expect(rendered.querySelector('input')).toBe(input);
  });

  it('renders a labeled control with an optional class name and prefix node', () => {
    const select = document.createElement('select');
    const prefix = document.createElement('svg');
    const rendered = renderLabeledControl('Window', select, { className: 'table-filter-facet', prefix });

    expect(rendered.className).toBe('table-filter-facet');
    expect(rendered.firstChild).toBe(prefix);
    expect(rendered.querySelector('span')?.textContent).toBe('Window');
    expect(rendered.querySelector('select')).toBe(select);
  });

  it('copies text to the clipboard and resolves true on success', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });

    await expect(copyTextToClipboard('hello world')).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith('hello world');
  });

  it('resolves false when the clipboard write rejects', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });

    await expect(copyTextToClipboard('hello world')).resolves.toBe(false);
  });

  it('resolves false when the Clipboard API is unavailable', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });

    await expect(copyTextToClipboard('hello world')).resolves.toBe(false);
  });

  it('builds a copy control that reports success and resets its status', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });

    const { button, status, reset } = createCopyControl({
      getContent: () => 'copy me',
      label: 'Copy prompt',
      buttonClassName: 'table-intent-copy-button',
      statusClassName: 'table-intent-copy-status',
      successText: 'Prompt copied.',
      failureText: 'Could not copy prompt.',
      trackState: true
    });

    expect(button.className).toBe('table-intent-copy-button');
    expect(status.className).toBe('table-intent-copy-status');
    expect(button.textContent).toBe('Copy prompt');

    button.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(writeText).toHaveBeenCalledWith('copy me');
    expect(status.textContent).toBe('Prompt copied.');
    expect(button.getAttribute('data-copy-state')).toBe('success');

    reset();
    expect(status.textContent).toBe('');
    expect(button.hasAttribute('data-copy-state')).toBe(false);
  });

  it('reports failure text without tracking button state when trackState is unset', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });

    const { button, status } = createCopyControl({
      getContent: () => 'copy me',
      label: 'Copy JSON',
      buttonClassName: 'configuration-copy-button',
      statusClassName: 'configuration-copy-status'
    });

    button.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(status.textContent).toBe('Copy unavailable.');
    expect(button.hasAttribute('data-copy-state')).toBe(false);
  });
});
