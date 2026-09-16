import { h, keyed } from '../dom.js';
import { effect } from '../reactive.js';

/**
 * Renders a labelled graph shell with a keyed, reactively updated plot.
 * @template T
 * @param {{
 *   className?: string,
 *   headingClassName?: string,
 *   legendClassName?: string,
 *   plotClassName?: string,
 *   title: string,
 *   ariaLabel: string,
 *   legendLabel: string,
 *   legend: Array<{ label: string, className: string }>,
 *   items: () => T[],
 *   key: (item: T, index: number) => string,
 *   renderItem: (item: T, index: number) => HTMLElement,
 *   updateItem: (element: HTMLElement, item: T, index: number, items: T[]) => void,
 *   signal: AbortSignal
 * }} options
 * @returns {HTMLElement}
 */
export function renderReactiveGraphWidget(options) {
  /** @type {Map<string, HTMLElement>} */
  const elements = new Map();
  const itemList = keyed(
    [],
    (item, index) => {
      const element = options.renderItem(item, index);
      elements.set(options.key(item, index), element);
      return element;
    },
    options.key
  );
  const plot = h(
    'div',
    { className: ['graph-widget-plot', options.plotClassName].filter(Boolean).join(' ') },
    itemList
  );
  const widget = h(
    'section',
    {
      className: ['graph-widget', options.className].filter(Boolean).join(' '),
      'aria-label': options.ariaLabel
    },
    h(
      'div',
      { className: ['graph-widget-heading', options.headingClassName].filter(Boolean).join(' ') },
      h('span', null, options.title),
      h(
        'ul',
        {
          className: ['graph-widget-legend', options.legendClassName].filter(Boolean).join(' '),
          'aria-label': options.legendLabel
        },
        ...options.legend.map((entry) => h(
          'li',
          null,
          h('i', { className: entry.className, 'aria-hidden': 'true' }),
          entry.label
        ))
      )
    ),
    plot
  );

  effect(() => {
    const nextItems = options.items();
    const nextKeys = new Set(nextItems.map(options.key));
    for (const key of elements.keys()) {
      if (!nextKeys.has(key)) elements.delete(key);
    }
    itemList.items = nextItems;
    itemList.render();
    nextItems.forEach((item, index) => {
      const element = elements.get(options.key(item, index));
      if (element) options.updateItem(element, item, index, nextItems);
    });
  }, { signal: options.signal });

  return widget;
}
