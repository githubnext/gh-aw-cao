// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { indexedDB } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';
import { renderConfigurationView } from '../../src/components/configuration-view.js';
import { setDeclaredCliActions } from '../../src/components/cli-actions.js';
import { renderUiElement } from '../../src/components/ui-elements.js';
import { setAutomaticDashboardDataUpdatesEnabled } from '../../src/dashboard-data-updates.js';

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
  it('disables hourly data downloads when Periodic Background Sync is unsupported', () => {
    localStorage.clear();
    const rendered = renderConfigurationView(context({
      document: { version: 1 },
      raw: '',
      diagnostics: []
    }));
    if (!rendered) throw new Error('configuration view did not render');

    const checkbox = rendered.querySelector('#configuration-automatic-dashboard-data-updates');
    if (!(checkbox instanceof HTMLInputElement)) throw new Error('automatic update checkbox did not render');
    document.body.append(rendered);
    expect(checkbox.disabled).toBe(true);
    expect(rendered.querySelector('.configuration-browser-setting-status')?.textContent)
      .toContain('Periodic Background Sync is not supported');
  });

  it('renders browser settings and local database totals on the full settings page', () => {
    localStorage.clear();
    const rendered = renderConfigurationView({
      ...context({ document: { version: 1 }, raw: '', diagnostics: [] }),
      sourceNames: [
        'configuration-policy',
        'database-package-count',
        'database-repository-count',
        'database-workflow-count',
        'database-run-count',
        'database-event-count'
      ],
      sources: {
        ...context({ document: { version: 1 }, raw: '', diagnostics: [] }).sources,
        'database-package-count': { source: 'database-package-count', rows: [{ packages: 2 }], metadata },
        'database-repository-count': { source: 'database-repository-count', rows: [{ repositories: 3 }], metadata },
        'database-workflow-count': { source: 'database-workflow-count', rows: [{ workflows: 5 }], metadata },
        'database-run-count': { source: 'database-run-count', rows: [{ runs: 8 }], metadata },
        'database-event-count': { source: 'database-event-count', rows: [{ events: 13 }], metadata }
      }
    });

    if (!rendered) throw new Error('configuration view did not render');
    const root = document.createElement('div');
    root.className = 'dashboard-root';
    root.append(rendered);

    expect(rendered.querySelector('#configuration-appearance-heading')?.textContent).toBe('Appearance');
    expect([...rendered.querySelectorAll('[data-theme-value]')].map((node) => node.textContent)).toEqual(['System', 'Light', 'Dark']);
    /** @type {HTMLButtonElement} */ (rendered.querySelector('[data-theme-value="dark"]')).click();
    expect(root.dataset.theme).toBe('dark');
    expect(localStorage.getItem('central-agentic-ops.dashboard.theme')).toBe('dark');
    expect(rendered.querySelector('.configuration-database-counts')?.textContent).toContain('13Events');
    expect(rendered.querySelector('.reset-dashboard-trigger')).not.toBeNull();
  });

  it('renders repository actions when the settings view is activated lazily', () => {
    setDeclaredCliActions([{
      id: 'update-repository',
      label: 'Update',
      icon: 'sync',
      command: 'gh aw update --repo {{repository}}',
      placement: 'settings'
    }], {
      canExecute: false,
      templateValues: { repository: 'octo/example' }
    });

    const rendered = renderConfigurationView(context({
      document: { version: 1 },
      raw: '',
      diagnostics: []
    }));

    expect(rendered?.querySelector('.cli-actions-settings')).not.toBeNull();
    expect(rendered?.querySelector('.cli-action-trigger')?.textContent).toContain('Update');
    rendered?.querySelector('.cli-action-trigger')?.dispatchEvent(new MouseEvent('click'));
    expect(rendered?.querySelector('.cli-action-command')?.textContent)
      .toBe('gh aw update --repo octo/example');
    setDeclaredCliActions([]);
  });

  it('keeps repository actions available when policy data is unavailable', () => {
    setDeclaredCliActions([{
      id: 'upgrade-repository',
      label: 'Upgrade',
      icon: 'download',
      command: 'gh aw upgrade --repo {{repository}}',
      placement: 'settings'
    }], {
      templateValues: { repository: 'octo/example' }
    });
    const rendered = renderConfigurationView({
      ...context({}),
      sources: {}
    });

    expect(rendered?.querySelector('.cli-action-trigger')?.textContent).toContain('Upgrade');
    expect(rendered?.textContent).toContain('The policy cannot be edited');
    setDeclaredCliActions([]);
  });

  it('reflects background registration failures while the setting is mounted', () => {
    localStorage.setItem('central-agentic-ops.dashboard.automatic-data-updates', 'true');
    localStorage.setItem('central-agentic-ops.dashboard.background-data-updates-active', 'true');
    const rendered = renderConfigurationView(context({
      document: { version: 1 },
      raw: '',
      diagnostics: []
    }));
    if (!rendered) throw new Error('configuration view did not render');
    document.body.append(rendered);
    const checkbox = /** @type {HTMLInputElement | null} */ (
      rendered.querySelector('#configuration-automatic-dashboard-data-updates')
    );

    setAutomaticDashboardDataUpdatesEnabled(false);

    expect(checkbox?.checked).toBe(false);
    expect(rendered.querySelector('.configuration-browser-setting-status')?.textContent)
      .toContain('Periodic Background Sync is not supported');
    rendered.remove();
  });

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
    expect(dashboard['cli-actions']
      .filter((/** @type {{ id: string }} */ action) => ['update-repository', 'upgrade-repository'].includes(action.id))
      .every((/** @type {{ placement: string }} */ action) => action.placement === 'view')).toBe(true);
  });

  it('wires the Settings view to a supported UI element', () => {
    const dashboard = JSON.parse(readFileSync(resolve('dashboard.json'), 'utf8')).dashboard;
    const page = dashboard.pages.find((/** @type {{ id: string }} */ candidate) => candidate.id === 'configuration');
    const [view] = page.views;
    const rendered = renderUiElement(view.element, {
      ...context({ document: { version: 1 }, raw: '', diagnostics: [] }),
      title: view.title,
      description: view.description,
      sourceNames: view.data.sources,
      sources: {
        ...context({ document: { version: 1 }, raw: '', diagnostics: [] }).sources,
        'database-package-count': { source: 'database-package-count', rows: [{ packages: 0 }], metadata },
        'database-repository-count': { source: 'database-repository-count', rows: [{ repositories: 0 }], metadata },
        'database-workflow-count': { source: 'database-workflow-count', rows: [{ workflows: 0 }], metadata },
        'database-run-count': { source: 'database-run-count', rows: [{ runs: 0 }], metadata },
        'database-event-count': { source: 'database-event-count', rows: [{ events: 0 }], metadata }
      }
    });

    expect(rendered?.classList.contains('configuration-view')).toBe(true);
    expect(rendered?.textContent).toContain('Policy');
    expect(rendered?.textContent).not.toContain('Unsupported UI element');
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
    expect(rendered.querySelector('.configuration-diagnostics-button')).not.toBeNull();
  });

  it('collects and copies full diagnostics', async () => {
    vi.stubGlobal('indexedDB', indexedDB);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText }
    });
    const rendered = renderConfigurationView(context({
      document: { version: 1 },
      raw: '',
      diagnostics: []
    }));
    if (!rendered) throw new Error('configuration view did not render');
    document.body.append(rendered);

    const button = rendered.querySelector('.configuration-diagnostics-button');
    if (!(button instanceof HTMLButtonElement)) throw new Error('diagnostics button did not render');
    button.click();

    await vi.waitFor(() => expect(writeText).toHaveBeenCalledOnce());
    expect(JSON.parse(writeText.mock.calls[0][0])).toEqual(expect.objectContaining({
      passed: false,
      database: expect.any(Object),
      ui: expect.any(Object)
    }));
    expect(rendered.querySelector('.configuration-copy-status')?.textContent).toBe('Diagnostics copied.');
  });

  it('defers settings inside collapsed groups until they are expanded', () => {
    const targets = Object.fromEntries(Array.from({ length: 100 }, (_, index) => [
      `githubnext/repository-${index}`,
      { mode: 'review' }
    ]));
    const rendered = renderConfigurationView(context({
      document: { 'control-plane': { packages: { maintenance: { targets } } } },
      raw: '',
      diagnostics: []
    }));
    if (!rendered) throw new Error('configuration view did not render');

    const maintenanceGroup = [...rendered.querySelectorAll('details')]
      .find((group) => group.querySelector(':scope > summary span')?.textContent === 'Maintenance');
    if (!(maintenanceGroup instanceof HTMLDetailsElement)) throw new Error('maintenance group did not render');
    expect(maintenanceGroup.open).toBe(false);
    expect(rendered.textContent).not.toContain('Targets');
    expect(rendered.querySelectorAll('.configuration-editor .configuration-setting-row')).toHaveLength(0);

    maintenanceGroup.open = true;
    maintenanceGroup.dispatchEvent(new Event('toggle'));
    const targetsGroup = [...maintenanceGroup.querySelectorAll('details')]
      .find((group) => group.querySelector(':scope > summary span')?.textContent === 'Targets');
    if (!(targetsGroup instanceof HTMLDetailsElement)) throw new Error('targets group did not render');
    expect(targetsGroup.open).toBe(false);
    expect(rendered.querySelectorAll('.configuration-editor .configuration-setting-row')).toHaveLength(0);

    targetsGroup.open = true;
    targetsGroup.dispatchEvent(new Event('toggle'));
    expect(targetsGroup.querySelectorAll(':scope > .configuration-setting-children > details')).toHaveLength(100);
    expect(rendered.querySelectorAll('.configuration-editor .configuration-setting-row')).toHaveLength(0);
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

  it('preserves typed values when editing non-string arrays', () => {
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
    expect(rendered.querySelector('.configuration-edit-status')?.textContent).toBe('Modified locally');
    expect(values.value).toBe('[2, false, {"mode":"live"}]');
  });

  it('can discard local changes without offering JSON copy', () => {
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
    expect(rendered.querySelector('.configuration-copy-button')).toBeNull();

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
