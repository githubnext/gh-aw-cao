// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderCellDisplay } from '../../src/components/cell-display.js';

describe('table cell display helper', () => {
  it('DLS-VIEW-004 renders JSON-selected display types through one generic helper', () => {
    /** @param {unknown} value */
    const toText = (value) => value == null || value === '' ? 'unknown' : String(value);

    const mode = renderCellDisplay('mode', 'live', toText);
    const activeState = renderCellDisplay('active-state', 'true', toText);
    const status = renderCellDisplay('status', 'failure', toText);
    const repositoryStatus = renderCellDisplay('status', 'Needs attention', toText);
    const graderPass = renderCellDisplay('grader-status', 'pass', toText);
    const graderUnavailable = renderCellDisplay('grader-status', 'unavailable', toText);

    expect(mode).toBeInstanceOf(HTMLElement);
    expect(/** @type {HTMLElement} */ (mode).className).toBe('mode-badge mode-live');
    expect(activeState).toBeInstanceOf(HTMLElement);
    expect(/** @type {HTMLElement} */ (activeState).className).toBe('status status-success');
    expect(status).toBeInstanceOf(HTMLElement);
    expect(/** @type {HTMLElement} */ (status).className).toBe('status status-danger');
    expect(/** @type {HTMLElement} */ (repositoryStatus).className).toBe('status status-danger');
    expect(/** @type {HTMLElement} */ (graderPass).className).toBe('status status-success');
    expect(/** @type {HTMLElement} */ (graderUnavailable).className).toBe('status status-attention');
    expect(renderCellDisplay('label', 'matured', toText)).toBe('Mature');
    expect(renderCellDisplay(undefined, null, toText, null, 'quantitative')).toBe('—');
    expect(/** @type {HTMLElement} */ (renderCellDisplay('digest', '1234567890abcdef', toText)).textContent).toBe('1234567890ab');
    expect(renderCellDisplay(undefined, 'plain', toText)).toBe('plain');
    expect(renderCellDisplay(undefined, '.github/workflows/daily.md', toText, null, 'nominal', 'workflow-relative-path')).toBe('daily.md');
    expect(renderCellDisplay(undefined, 'nested/daily.md', toText, null, 'nominal', 'workflow-relative-path')).toBe('nested/daily.md');
    const workflowRun = /** @type {HTMLAnchorElement} */ (renderCellDisplay(
      undefined,
      'https://github.com/githubnext/gh-aw-cao/actions/runs/12345',
      toText,
      null,
      'nominal',
      'workflow-run-url'
    ));
    expect(workflowRun.tagName).toBe('A');
    expect(workflowRun.href).toBe('https://github.com/githubnext/gh-aw-cao/actions/runs/12345');
    expect(workflowRun.textContent).toContain('12345');
    expect(workflowRun.target).toBe('_blank');
    expect(workflowRun.rel).toBe('noopener noreferrer');
    expect(renderCellDisplay(undefined, 'https://example.com/actions/runs/12345', toText, null, 'nominal', 'workflow-run-url'))
      .toBe('https://example.com/actions/runs/12345');
    expect(renderCellDisplay('unsupported', null, toText)).toBe('unknown');
    const temporal = /** @type {HTMLElement} */ (renderCellDisplay(undefined, '2026-08-30T07:00:00Z', toText, null, 'temporal'));
    expect(temporal.tagName).toBe('TIME');
    expect(temporal.getAttribute('datetime')).toBe('2026-08-30T07:00:00Z');
    expect(temporal.textContent).toBe('Aug 30, 2026, 7:00 AM');
    const recent = /** @type {HTMLElement} */ (renderCellDisplay(
      undefined,
      new Date(Date.now() - 5 * 60_000).toISOString(),
      toText,
      null,
      'temporal',
      'human-friendly-timestamp'
    ));
    expect(recent.tagName).toBe('TIME');
    expect(recent.textContent).toBe('5 minutes ago');
    expect(recent.title).toMatch(/ UTC$/);
    expect(recent.getAttribute('aria-label')).toBe(`5 minutes ago (${recent.title})`);
    expect(renderCellDisplay(undefined, 2.5, toText, {
      name: 'AI Credits',
      symbol: 'AIC',
      significant: 1
    })).toBe('3 AIC');
  });
});
