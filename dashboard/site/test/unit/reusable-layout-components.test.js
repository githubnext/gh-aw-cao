// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { h } from '../../src/dom.js';
import { state } from '../../src/reactive.js';
import { renderReactiveGraphWidget } from '../../src/components/graph-widget.js';
import { renderPanel } from '../../src/components/panel.js';
import { renderReactiveGrid } from '../../src/components/reactive-grid.js';

describe('reusable layout components', () => {
  it('renders a labelled panel around owned content', () => {
    const panel = renderPanel({
      className: 'example-panel',
      labelledBy: 'example-heading',
      children: [h('h2', { id: 'example-heading' }, 'Example'), h('p', null, 'Panel content')]
    });

    expect(panel.className).toBe('ui-panel example-panel');
    expect(panel.getAttribute('aria-labelledby')).toBe('example-heading');
    expect(panel.textContent).toBe('ExamplePanel content');
  });

  it('retains keyed grid items across reactive order and summary updates', () => {
    const controller = new AbortController();
    const gridState = state({
      active: false,
      label: 'Two items',
      items: [{ id: 'one' }, { id: 'two' }]
    });
    const grid = renderReactiveGrid({
      className: 'example-grid',
      activeClassName: 'example-grid-active',
      listClassName: 'example-grid-items',
      items: () => gridState.get().items,
      key: (item) => item.id,
      renderItem: (item) => h('li', { dataset: { id: item.id } }, item.id),
      active: () => gridState.get().active,
      ariaLabel: () => gridState.get().label,
      signal: controller.signal
    });
    const first = grid.querySelector('[data-id="one"]');

    gridState.set({
      active: true,
      label: 'Three reordered items',
      items: [{ id: 'two' }, { id: 'one' }, { id: 'three' }]
    });

    expect(grid.classList.contains('example-grid-active')).toBe(true);
    expect(grid.getAttribute('aria-label')).toBe('Three reordered items');
    expect([...grid.querySelectorAll('li')].map((item) => item.textContent)).toEqual(['two', 'one', 'three']);
    expect(grid.querySelector('[data-id="one"]')).toBe(first);

    controller.abort();
    gridState.set({ active: false, label: 'Stopped', items: [] });
    expect(grid.classList.contains('example-grid-active')).toBe(true);
    expect(grid.querySelectorAll('li')).toHaveLength(3);
  });

  it('updates keyed graph marks and stops when its owner aborts', () => {
    const controller = new AbortController();
    const graphState = state([
      { id: 'mon', label: 'Monday', value: 2 },
      { id: 'tue', label: 'Tuesday', value: 4 }
    ]);
    const graph = renderReactiveGraphWidget({
      className: 'example-graph',
      title: 'Weekly activity',
      ariaLabel: 'Weekly activity graph',
      legendLabel: 'Activity legend',
      legend: [{ label: 'Runs', className: 'runs-key' }],
      items: graphState.get,
      key: (item) => item.id,
      renderItem: () => h('span', { role: 'img' }),
      updateItem: (element, item) => {
        element.dataset.id = item.id;
        element.setAttribute('aria-label', `${item.label}: ${item.value}`);
      },
      signal: controller.signal
    });
    const monday = graph.querySelector('[data-id="mon"]');

    expect(graph.getAttribute('aria-label')).toBe('Weekly activity graph');
    expect(graph.querySelector('.graph-widget-legend')?.getAttribute('aria-label')).toBe('Activity legend');
    expect(graph.querySelector('.runs-key')?.getAttribute('aria-hidden')).toBe('true');

    graphState.set([
      { id: 'tue', label: 'Tuesday', value: 5 },
      { id: 'mon', label: 'Monday', value: 3 }
    ]);
    expect([...graph.querySelectorAll('[role="img"]')].map((item) => item.getAttribute('aria-label'))).toEqual([
      'Tuesday: 5',
      'Monday: 3'
    ]);
    expect(graph.querySelector('[data-id="mon"]')).toBe(monday);

    controller.abort();
    graphState.set([]);
    expect(graph.querySelectorAll('[role="img"]')).toHaveLength(2);
  });
});
