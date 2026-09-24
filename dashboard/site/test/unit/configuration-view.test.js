// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const queryCanonicalDatabaseDiagnostics = vi.hoisted(() => vi.fn().mockResolvedValue({
  schemaVersion: 13,
  counts: {
    campaigns: 0,
    repositories: 0,
    workflows: 0,
    runs: 0,
    domains: 0,
    tools: 0,
    audits: 0,
    issues: 0
  },
  relationshipErrors: [],
  duplicateRecordIds: {
    campaigns: [],
    repositories: [],
    workflows: [],
    runs: [],
    domains: [],
    tools: [],
    audits: [],
    issues: []
  }
}));
vi.mock('../../src/data-processor.js', () => ({ queryCanonicalDatabaseDiagnostics }));

import { renderConfigurationView } from '../../src/components/configuration-view.js';
import { setDeclaredCliActions } from '../../src/components/cli-actions.js';
import { renderUiElement } from '../../src/components/ui-elements.js';
import { setAutomaticDashboardDataUpdatesEnabled } from '../../src/dashboard-data-updates.js';
import { fullDebugUrl, isDebugEnabled } from '../../src/debug.js';

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

  it('renders browser settings without local database queries', () => {
    localStorage.clear();
    const rendered = renderConfigurationView(context({ document: { version: 1 }, raw: '', diagnostics: [] }));

    if (!rendered) throw new Error('configuration view did not render');

    expect(rendered.querySelector('[data-theme-value]')).toBeNull();
    expect(rendered.querySelector('.configuration-database-counts')).toBeNull();
    expect(rendered.querySelector('.reset-dashboard-trigger')).not.toBeNull();
    expect(rendered.querySelector('.configuration-transactions-button')?.getAttribute('href')).toBe('#page-transactions');
    const debugSettings = rendered.querySelector('.configuration-debug-settings');
    expect(debugSettings).toBe(rendered.lastElementChild);
    const debugLink = debugSettings?.querySelector('a');
    expect(debugLink?.textContent).toBe('Relaunch with debugging');
    expect(debugLink?.getAttribute('href')).toBe(fullDebugUrl());
  });

  it('copies captured console logs', async () => {
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
    const button = rendered?.querySelector('.configuration-debug-settings button');
    if (!(button instanceof HTMLButtonElement)) throw new Error('copy console logs button did not render');

    button.click();

    await vi.waitFor(() => expect(writeText).toHaveBeenCalledOnce());
    expect(writeText.mock.calls[0][0]).toBe('No console entries captured.');
    await vi.waitFor(() => expect(rendered?.querySelector('.configuration-debug-settings output')?.textContent)
      .toBe('Console logs copied.'));
  });

  it('hides debugging controls in installed app mode', () => {
    Object.defineProperty(navigator, 'standalone', { configurable: true, value: true });
    const rendered = renderConfigurationView(context({
      document: { version: 1 },
      raw: '',
      diagnostics: []
    }));

    expect(rendered?.querySelector('.configuration-debug-settings')).toBeNull();
    delete /** @type {Navigator & { standalone?: boolean }} */ (navigator).standalone;
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

  it('exposes Settings in the bottom management navigation without a chart', () => {
    const dashboard = JSON.parse(readFileSync(resolve('dashboard.json'), 'utf8')).dashboard;
    const page = dashboard.pages.find((/** @type {{ id: string }} */ candidate) => candidate.id === 'configuration');
    const manageNavigation = dashboard.navigation.find((/** @type {{ label?: string }} */ candidate) => candidate.label === 'Manage');

    expect(page.title).toBe('Settings');
    expect(page.icon).toBe('gear');
    expect(manageNavigation.placement).toBe('bottom');
    expect(manageNavigation.pages.at(-1)).toBe('configuration');
    expect(page.views.every((/** @type {{ mark: string }} */ view) => view.mark !== 'chart')).toBe(true);
    expect(page.views).toHaveLength(1);
    expect(page.views[0].id).toBe('configuration-policy');
    expect(page.views[0].data.sources).toEqual(['configuration-policy']);
    expect(dashboard['cli-actions']
      .filter((/** @type {{ id: string }} */ action) => ['update-repository', 'upgrade-repository'].includes(action.id))
      .every((/** @type {{ placement: string }} */ action) => action.placement === 'view')).toBe(true);
  });

  it('separates CAO package and compiler maintenance inventory', () => {
    const dashboard = JSON.parse(readFileSync(resolve('dashboard.json'), 'utf8')).dashboard;
    const page = dashboard.pages.find((/** @type {{ id: string }} */ candidate) => candidate.id === 'maintenance');
    const manageNavigation = dashboard.navigation.find((/** @type {{ label?: string }} */ candidate) => candidate.label === 'Manage');

    expect(page.title).toBe('Maintenance');
    expect(page['filter-bar']).toBeUndefined();
    expect(page.views.map((/** @type {{ data: { source: string } }} */ view) => view.data.source))
      .toEqual(['campaigns', 'maintenance-repositories']);
    expect(page.views.map((/** @type {{ mark: string }} */ view) => view.mark)).toEqual(['list', 'list']);
    expect(page.views.map((/** @type {{ list: { style: string, card: string } }} */ view) => view.list))
      .toEqual([
        { style: 'entity-cards', card: 'maintenance-campaign', icon: 'workflow' },
        { style: 'entity-cards', card: 'maintenance-repository', icon: 'repo' }
      ]);
    expect(page.views[0].encoding.columns.map((/** @type {{ field: string }} */ column) => column.field))
      .toEqual([
        'campaign-name',
        'campaign-version',
        'campaign-current-version',
        'campaign-update-state',
        'campaign-registration'
      ]);
    expect(page.views[1].encoding.columns.map((/** @type {{ field: string }} */ column) => column.field))
      .toEqual([
        'repository',
        'gh-aw-version',
        'gh-aw-current-version',
        'upgrade-state'
      ]);
    const templates = new Map(dashboard['card-templates'].map((/** @type {{ id: string }} */ template) => [template.id, template]));
    expect(templates.get('maintenance-campaign').actions).toEqual([{
      action: 'update-campaign',
      context: ['campaign'],
      when: { field: 'campaign-update-state', equals: 'update-available' }
    }]);
    expect(templates.get('maintenance-repository').actions).toEqual([{
      action: 'upgrade-target-repository',
      context: ['repository']
    }]);
    expect(dashboard['cli-actions']
      .find((/** @type {{ id: string }} */ action) => action.id === 'update-campaign')
      .command).toBe('./cao.sh update {{campaign}}');
    expect(manageNavigation.placement).toBe('bottom');
    expect(manageNavigation.pages).toContain('maintenance');
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
      sources: context({ document: { version: 1 }, raw: '', diagnostics: [] }).sources
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

  it('regenerates editable settings from valid raw JSON when the structured policy is missing', () => {
    const rendered = renderConfigurationView(context({
      document: null,
      raw: '{"version":1,"control-plane":{"defaults":{"mode":"review"}}}',
      diagnostics: []
    }));
    if (!rendered) throw new Error('configuration view did not render');

    expect(rendered.querySelector('.configuration-editor')).not.toBeNull();
    expect(rendered.querySelector('select')?.value).toBe('review');
    expect(rendered.textContent).not.toContain('The policy cannot be edited');
  });

  it('collects and copies full diagnostics', async () => {
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
    await vi.waitFor(() => expect(button.nextElementSibling?.textContent).toBe('Diagnostics copied.'));
  });

  it('defers settings inside collapsed groups until they are expanded', () => {
    const targets = Object.fromEntries(Array.from({ length: 100 }, (_, index) => [
      `githubnext/repository-${index}`,
      { mode: 'review' }
    ]));
    const rendered = renderConfigurationView(context({
      document: { 'control-plane': { campaigns: { maintenance: { targets } } } },
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

  it('copies edited policy JSON', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText }
    });
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

    await vi.waitFor(() => expect(writeText).toHaveBeenCalledOnce());
    expect(JSON.parse(writeText.mock.calls[0][0])).toEqual({
      version: 1,
      'control-plane': { defaults: { 'max-repositories': 12 } }
    });
    await vi.waitFor(() => expect(copyButton.nextElementSibling?.textContent).toBe('Updated JSON copied.'));
  });

  it('can discard local changes', () => {
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
    expect(rendered.querySelector('.configuration-copy-button')).not.toBeNull();

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

  describe('debug logging', () => {
    afterEach(() => {
      window.history.replaceState(null, '', '/');
      vi.restoreAllMocks();
    });

    it('derives the configuration-view debug category predictably from the filename', () => {
      expect(isDebugEnabled('configuration-view', '?debug=configuration-view')).toBe(true);
      expect(isDebugEnabled('configuration-view', '?debug=1')).toBe(true);
      expect(isDebugEnabled('configuration-view', '?debug=render')).toBe(false);
    });

    it('stays silent by default while editing settings and collecting diagnostics', async () => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: vi.fn().mockResolvedValue(undefined) }
      });
      const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
      const rendered = renderConfigurationView(context({
        document: { 'control-plane': { defaults: { 'max-repositories': 7 } } },
        raw: '',
        diagnostics: []
      }));
      if (!rendered) throw new Error('configuration view did not render');
      document.body.append(rendered);

      const input = rendered.querySelector('#configuration-control-plane-defaults-max-repositories');
      if (!(input instanceof HTMLInputElement)) throw new Error('number setting did not render');
      input.value = '12';
      input.dispatchEvent(new Event('input'));

      const diagnosticsButton = rendered.querySelector('.configuration-diagnostics-button');
      if (!(diagnosticsButton instanceof HTMLButtonElement)) throw new Error('diagnostics button did not render');
      diagnosticsButton.click();
      await vi.waitFor(() => expect(diagnosticsButton.nextElementSibling?.textContent).not.toBe('Collecting diagnostics…'));

      expect(debug).not.toHaveBeenCalled();
    });

    it('logs sanitized draft and diagnostics metadata when the category is enabled', async () => {
      window.history.replaceState(null, '', '/?debug=configuration-view');
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: vi.fn().mockResolvedValue(undefined) }
      });
      const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
      vi.resetModules();
      const { renderConfigurationView: renderConfigurationViewWithDebug } = await import('../../src/components/configuration-view.js');
      const rendered = renderConfigurationViewWithDebug(context({
        document: { 'control-plane': { defaults: { 'max-repositories': 7 } } },
        raw: '',
        diagnostics: []
      }));
      if (!rendered) throw new Error('configuration view did not render');
      document.body.append(rendered);

      const input = rendered.querySelector('#configuration-control-plane-defaults-max-repositories');
      if (!(input instanceof HTMLInputElement)) throw new Error('number setting did not render');
      input.value = '12';
      input.dispatchEvent(new Event('input'));
      expect(debug).toHaveBeenCalledWith('[cao:configuration-view]', 'settings draft state changed', { modified: true });

      const diagnosticsButton = rendered.querySelector('.configuration-diagnostics-button');
      if (!(diagnosticsButton instanceof HTMLButtonElement)) throw new Error('diagnostics button did not render');
      diagnosticsButton.click();
      expect(debug).toHaveBeenCalledWith('[cao:configuration-view]', 'diagnostics collection started');

      await vi.waitFor(() => expect(debug).toHaveBeenCalledWith(
        '[cao:configuration-view]',
        'diagnostics collection finished',
        expect.objectContaining({ status: 'success', copied: true, durationMs: expect.any(Number) })
      ));

      for (const call of debug.mock.calls) {
        for (const value of call.slice(1)) {
          if (value && typeof value === 'object') {
            expect(Object.keys(value)).not.toEqual(expect.arrayContaining(['message', 'token', 'secret', 'report']));
          }
        }
      }
    });
  });
});
