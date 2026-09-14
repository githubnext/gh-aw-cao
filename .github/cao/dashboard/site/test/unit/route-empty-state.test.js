// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { createRouteView } from '../../src/components/route-empty-state.js';

describe('createRouteView', () => {
  it('renders select, not-found, and matched states while updating route dataset', () => {
    const matched = document.createElement('section');
    matched.textContent = 'Matched content';
    const renderMatched = vi.fn((routeValue) => routeValue === 'known' ? matched : null);

    const view = createRouteView({
      rootClassName: 'example-route-view',
      routeParameter: 'item',
      datasetKey: 'item',
      selectMessage: 'Select an item to view details.',
      notFoundMessage: 'Item not found.',
      renderMatched
    });

    expect(view.textContent).toBe('Select an item to view details.');
    expect(view.dataset.item).toBe('');

    view.dispatchEvent(new CustomEvent('dashboard-route-change', {
      detail: { parameter: 'item', value: '<missing>' }
    }));
    expect(view.textContent).toBe('Item not found.');
    expect(view.dataset.item).toBe('<missing>');

    view.dispatchEvent(new CustomEvent('dashboard-route-change', {
      detail: { parameter: 'item', value: 'known' }
    }));
    expect(view.textContent).toBe('Matched content');
    expect(view.dataset.item).toBe('known');
    expect(renderMatched).toHaveBeenCalledWith('known');
  });

  it('prefers the unavailable message over route matching when data is unavailable', () => {
    const renderMatched = vi.fn(() => document.createElement('div'));
    const view = createRouteView({
      rootClassName: 'example-route-view',
      routeParameter: 'item',
      datasetKey: 'item',
      selectMessage: 'Select an item to view details.',
      notFoundMessage: 'Item not found.',
      unavailableMessage: 'Item data is unavailable.',
      isUnavailable: () => true,
      renderMatched
    });

    expect(view.textContent).toBe('Item data is unavailable.');
    expect(renderMatched).not.toHaveBeenCalled();

    view.dispatchEvent(new CustomEvent('dashboard-route-change', {
      detail: { parameter: 'item', value: 'known' }
    }));
    expect(view.textContent).toBe('Item data is unavailable.');
    expect(renderMatched).not.toHaveBeenCalled();
    expect(view.dataset.item).toBe('known');
  });

  it('ignores route events for other parameters', () => {
    const view = createRouteView({
      rootClassName: 'example-route-view',
      routeParameter: 'item',
      datasetKey: 'item',
      selectMessage: 'Select an item to view details.',
      notFoundMessage: 'Item not found.',
      renderMatched: () => null
    });

    view.dispatchEvent(new CustomEvent('dashboard-route-change', {
      detail: { parameter: 'other', value: 'known' }
    }));

    expect(view.textContent).toBe('Select an item to view details.');
    expect(view.dataset.item).toBe('');
  });
});
