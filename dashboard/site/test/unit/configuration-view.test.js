// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { renderConfigurationView } from '../../src/components/configuration-view.js';

const metadata = /** @type {import('../../src/presenter.js').SourceMetadata} */ ({
  'source-id': 'configuration-fixture',
  'source-kind': 'fixture',
  'as-of': '2026-09-05T09:00:00Z',
  'retrieved-at': '2026-09-05T09:01:00Z',
  completeness: 'complete',
  freshness: 'fresh',
  availability: 'available'
});

/** @param {Record<string, unknown>} row */
function context(row) {
  return /** @type {import('../../src/components/ui-elements.js').ElementRenderContext} */ ({
    pageId: 'configuration',
    title: 'Control policy',
    description: 'Explained configuration.',
    sourceNames: ['configuration-policy'],
    sources: {
      'configuration-policy': {
        source: 'configuration-policy',
        rows: [row],
        metadata
      }
    },
    contextDetails: [],
    headingTag: 'h3'
  });
}

describe('Configuration dashboard view', () => {
  it('exposes Control in the clean navigation without a chart', () => {
    const dashboard = JSON.parse(readFileSync(resolve('dashboard.json'), 'utf8')).dashboard;
    const page = dashboard.pages.find((/** @type {{ id: string }} */ candidate) => candidate.id === 'configuration');
    const cleanNavigation = dashboard.navigation.find((/** @type {{ label?: string }} */ candidate) => !candidate.label);

    expect(page.title).toBe('Settings');
    expect(page.icon).toBe('gear');
    expect(cleanNavigation.pages.at(-1)).toBe('configuration');
    expect(page.views.every((/** @type {{ mark: string }} */ view) => view.mark !== 'chart')).toBe(true);
    expect(page.views).toHaveLength(1);
    expect(page.views[0].id).toBe('configuration-policy');
  });

  it('renders cao.json entries as editable settings', () => {
    const rendered = renderConfigurationView(context({
      document: { version: 1, 'control-plane': { defaults: { mode: 'review' } } },
      raw: '',
      diagnostics: []
    }));
    if (!rendered) throw new Error('configuration view did not render');

    expect(rendered.querySelector('.configuration-editor')).not.toBeNull();
    expect(/** @type {HTMLInputElement | null} */ (rendered.querySelector('input[type="number"]'))?.value).toBe('1');
    expect(rendered.querySelector('select')?.value).toBe('review');
    expect(rendered.textContent).toContain('Sets the inherited execution mode.');
    expect(rendered.textContent).not.toContain('Suggested changes');
    expect(rendered.textContent).not.toContain('Raw JSON');
  });

  it('edits lists without losing the nested policy path', () => {
    const rendered = renderConfigurationView(context({
      document: {
        'control-plane': {
          scope: { 'allowed-owners': ['githubnext', 'octodemo'] }
        }
      },
      raw: '',
      diagnostics: []
    }));
    if (!rendered) throw new Error('configuration view did not render');

    const owners = rendered.querySelector('textarea');
    if (!(owners instanceof HTMLTextAreaElement)) throw new Error('owner list did not render');
    expect(owners.value).toBe('githubnext\noctodemo');
    expect(owners.id).toContain('control-plane-scope-allowed-owners');
    owners.value = 'githubnext\ngithub';
    owners.dispatchEvent(new Event('input'));
    expect(rendered.querySelector('.configuration-edit-status')?.textContent).toBe('Modified locally');
  });

  it('preserves typed values when editing non-string arrays', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const rendered = renderConfigurationView(context({
      document: { values: [1, true, { mode: 'review' }] },
      raw: '',
      diagnostics: []
    }));
    if (!rendered) throw new Error('configuration view did not render');

    const values = rendered.querySelector('.configuration-setting-json');
    if (!(values instanceof HTMLTextAreaElement)) throw new Error('typed array editor did not render');
    values.value = '[2, false, {"mode":"live"}]';
    values.dispatchEvent(new Event('input'));
    const copyButton = rendered.querySelector('.configuration-copy-button');
    if (!(copyButton instanceof HTMLButtonElement)) throw new Error('copy button did not render');
    copyButton.click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledOnce());

    expect(JSON.parse(writeText.mock.calls[0][0]).values).toEqual([2, false, { mode: 'live' }]);
  });

  it('copies edited JSON and can discard local changes', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const rendered = renderConfigurationView(context({
      document: { version: 1, 'control-plane': { defaults: { 'max-repositories': 7 } } },
      raw: '',
      diagnostics: []
    }));
    if (!rendered) throw new Error('configuration view did not render');

    const input = rendered.querySelector('#configuration-control-plane-defaults-max-repositories');
    if (!(input instanceof HTMLInputElement)) throw new Error('number setting did not render');
    input.value = '12';
    input.dispatchEvent(new Event('input'));
    const copyButton = rendered.querySelector('.configuration-copy-button');
    if (!(copyButton instanceof HTMLButtonElement)) throw new Error('copy button did not render');
    copyButton.click();
    await vi.waitFor(() => expect(rendered.querySelector('.configuration-copy-status')?.textContent).toBe('Copied.'));
    expect(JSON.parse(writeText.mock.calls[0][0])['control-plane'].defaults['max-repositories']).toBe(12);

    const resetButton = rendered.querySelector('.configuration-reset-button');
    if (!(resetButton instanceof HTMLButtonElement)) throw new Error('reset button did not render');
    resetButton.click();
    expect(rendered.querySelector('.configuration-edit-status')?.textContent).toBe('No changes');
    expect(/** @type {HTMLInputElement | null} */ (rendered.querySelector('#configuration-control-plane-defaults-max-repositories'))?.value).toBe('7');
  });

  it('does not offer editing controls for invalid structured content', () => {
    const rendered = renderConfigurationView(context({ document: null, raw: '{bad json', diagnostics: [] }));
    if (!rendered) throw new Error('configuration view did not render');

    expect(rendered.textContent).toContain('The policy cannot be edited until it contains valid JSON.');
    expect(rendered.querySelector('.configuration-copy-button')).toBeNull();
  });
});
