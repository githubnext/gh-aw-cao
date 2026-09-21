import { h, keyed } from '../dom.js';
import { effect } from '../reactive.js';
import { bindFactorySources, createFactoryMetrics, createFactoryScope } from './factory-elements.js';
import { text } from './count-formatters.js';
import { findLink, renderSafeLink } from './link-content.js';
import { renderIconSpan } from './ui-primitives.js';

/**
 * Renders one declared source as a compact list of navigation buttons.
 * @param {import('./ui-elements.js').ElementRenderContext} context
 * @returns {HTMLElement}
 */
export function renderLinkButtonList(context) {
  const sourceName = context.sourceNames[0] ?? '';
  const bindings = bindFactorySources(context.sources, [sourceName], context);
  const scope = createFactoryScope(createFactoryMetrics(bindings));
  const source = bindings[sourceName];
  const labelField = text(context.elementConfig?.['label-field']);
  const linkField = text(context.elementConfig?.['link-field']);
  const iconField = text(context.elementConfig?.['icon-field']);
  const fallbackIcon = text(context.elementConfig?.['fallback-icon']) || 'link';
  const items = keyed(
    source.rows(),
    (row) => {
      const label = text(row[labelField]) || 'Link';
      return h(
        'li',
        { className: 'link-button-list-item' },
        renderSafeLink(
          h('span', { className: 'link-button-list-content' },
            renderIconSpan('link-button-list-icon', text(row[iconField]) || fallbackIcon, { ariaHidden: true }),
            h('span', null, label),
            renderIconSpan('link-button-list-chevron', 'chevron-right', { ariaHidden: true })
          ),
          findLink(row, linkField)
        )
      );
    },
    (row, index) => findLink(row, linkField)?.href || text(row[labelField]) || String(index)
  );
  const list = h('ul', { className: 'link-button-list' }, items);
  const empty = h(
    'p',
    { className: 'link-button-list-empty' },
    text(context.elementConfig?.['empty-message']) || 'No links are available.'
  );
  const root = h(
    'section',
    { className: 'link-button-list-view', 'aria-labelledby': `${context.viewId || context.pageId}-heading` },
    h('header', null,
      h('h2', { id: `${context.viewId || context.pageId}-heading` }, context.title),
      context.description ? h('p', null, context.description) : null),
    list,
    empty
  );
  effect(() => {
    items.items = source.rows();
    items.render();
    const pending = source.pending();
    const hasRows = items.items.length > 0;
    list.hidden = !hasRows;
    empty.hidden = hasRows || pending;
    root.toggleAttribute('aria-busy', pending);
  }, { signal: scope.signal });
  scope.bind(root);
  return root;
}
