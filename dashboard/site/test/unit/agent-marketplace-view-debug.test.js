// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

const CATEGORY = 'agent-marketplace-view';
const metadata = {
  'source-id': 'workflows', 'source-kind': 'fixture', 'as-of': '2026-08-30T12:00:00Z',
  'retrieved-at': '2026-08-30T12:01:00Z',
  completeness: /** @type {'complete'} */ ('complete'),
  freshness: /** @type {'fresh'} */ ('fresh'),
  availability: /** @type {'available'} */ ('available')
};

/** @param {string} search */
async function importWithDebug(search) {
  const output = { debug: vi.fn() };
  vi.doMock('../../src/debug.js', async () => {
    const actual = /** @type {typeof import('../../src/debug.js')} */ (
      await vi.importActual('../../src/debug.js')
    );
    return {
      ...actual,
      createDebug: (/** @type {string} */ category) => actual.createDebug(category, { search: () => search, output })
    };
  });
  vi.resetModules();
  const { agentSmellNotifications } = await import('../../src/components/agent-marketplace-view.js');
  const { renderUiElement } = await import('../../src/components/ui-elements.js');
  return { agentSmellNotifications, renderUiElement, output };
}

describe('agent marketplace view debug logging', () => {
  it('is disabled by default (no debug output) when the debug query is absent', async () => {
    const { agentSmellNotifications, output } = await importWithDebug('');

    agentSmellNotifications([{
      organization: 'github', repository: 'mona-tools',
      workflow: '.github/workflows/upgrade.md', 'workflow-name': 'Upgrade agent'
    }], [], [], [{
      organization: 'github', repository: 'mona-tools',
      workflow: '.github/workflows/upgrade.lock.yml',
      'smell-id': 'partially-reducible', 'smell-name': 'Partially reducible',
      'smell-severity': 'high'
    }]);

    expect(output.debug).not.toHaveBeenCalled();

    vi.doUnmock('../../src/debug.js');
    vi.resetModules();
  });

  it('logs only scalar metadata under its predictable category when enabled', async () => {
    const { agentSmellNotifications, output } = await importWithDebug(`?debug=${CATEGORY}`);

    const notifications = agentSmellNotifications([{
      organization: 'github', repository: 'mona-tools',
      workflow: '.github/workflows/upgrade.md', 'workflow-name': 'Upgrade agent'
    }], [], [], [{
      organization: 'github', repository: 'mona-tools',
      workflow: '.github/workflows/upgrade.lock.yml',
      'smell-id': 'partially-reducible', 'smell-name': 'Partially reducible',
      'smell-severity': 'high'
    }]);

    expect(notifications).toHaveLength(1);
    expect(output.debug).toHaveBeenCalledWith(`[cao:${CATEGORY}]`, {
      event: 'smell-notifications-built', notificationCount: 1
    });

    for (const call of output.debug.mock.calls) {
      const logged = call[1];
      expect(Object.values(logged).every((value) => typeof value !== 'object')).toBe(true);
    }

    vi.doUnmock('../../src/debug.js');
    vi.resetModules();
  });

  it('logs applied filter counts once a rendered view re-applies its filters', async () => {
    const { renderUiElement, output } = await importWithDebug(`?debug=${CATEGORY}`);

    renderUiElement('agent-marketplace-view', {
      pageId: 'agents',
      title: 'Agents',
      description: 'Marketplace-style agent catalog.',
      sourceNames: ['workflows'],
      sources: {
        workflows: {
          source: 'workflows',
          metadata,
          rows: [{
            organization: 'github', repository: 'mona-tools', package: 'standalone',
            workflow: '.github/workflows/upgrade.md', 'workflow-name': 'Upgrade agent',
            'workflow-role': 'standalone', 'workflow-active': 'true'
          }]
        }
      },
      contextDetails: [],
      headingTag: 'h3'
    });

    expect(output.debug).toHaveBeenCalledWith(`[cao:${CATEGORY}]`, {
      event: 'filters-applied', visibleCount: 1, totalCount: 1, activeKind: 'all', statusFilter: 'all'
    });

    vi.doUnmock('../../src/debug.js');
    vi.resetModules();
  });
});
