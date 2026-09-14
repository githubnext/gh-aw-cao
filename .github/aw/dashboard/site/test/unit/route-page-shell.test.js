// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { createRoutePageShell } from '../../src/components/route-page-shell.js';

describe('createRoutePageShell', () => {
  it('renders shared tabs, allocation, and matched content declaratively', () => {
    const allocation = vi.fn();
    const host = document.createElement('div');
    host.addEventListener('dashboard-route-allocation', allocation);
    const rendered = createRoutePageShell({
      pageId: 'custom-page',
      title: 'Custom page',
      sourceNames: [],
      sources: {},
      contextDetails: [],
      headingTag: /** @type {'h3'} */ ('h3'),
      routeParameter: 'workflow'
    }, {
      rootClassName: 'shared-route-shell',
      datasetKey: 'workflow',
      selectMessage: 'Select one.',
      notFoundMessage: 'Not found.',
      currentTab: 'reports',
      tabListClassName: 'shared-tabs',
      tabListAriaLabel: (title) => `${title} views`,
      hasSelection: (value) => value.length > 0,
      tabs: ({ routeValue }) => [
        { id: 'reports', label: 'Reports', icon: 'issue', href: `#reports-${routeValue}` },
        { id: 'runs', label: 'Runs', icon: 'play', href: `#runs-${routeValue}` }
      ],
      renderMatched: (routeValue) => ({
        allocation: { title: 'Demo Workflow', description: `Selected ${routeValue}` },
        content: Object.assign(document.createElement('div'), { className: 'matched-content', textContent: routeValue })
      })
    });
    host.append(rendered);

    rendered.dispatchEvent(new CustomEvent('dashboard-route-change', {
      detail: { parameter: 'workflow', value: 'demo' }
    }));

    expect(rendered.dataset.workflow).toBe('demo');
    expect(rendered.querySelector('.shared-tabs [aria-current="page"]')?.textContent).toBe('Reports');
    expect(rendered.querySelector('.matched-content')?.textContent).toBe('demo');
    expect(allocation).toHaveBeenCalledOnce();
    expect(allocation.mock.calls[0][0].detail).toEqual({
      title: 'Demo Workflow',
      description: 'Selected demo'
    });
  });
});
