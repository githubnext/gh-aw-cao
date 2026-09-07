import { h } from '../dom.js';
import { renderSectionHeading } from './ui-primitives.js';
import { rowsFor } from './source-rows.js';
import { agentMarketplaceComposition } from './agent-marketplace-composition.js';
import { agentComparator, buildAgentMarketplaceModel, renderAgentTile } from './agent-marketplace-primitives.js';

/**
 * @param {import('./ui-elements.js').ElementRenderContext} context
 * @returns {HTMLElement}
 */
export function renderAgentMarketplaceView(context) {
  const agents = buildAgentMarketplaceModel(rowsFor(context.sources, 'agent-assignments'));
  const composition = agentMarketplaceComposition(context.elementConfig?.body);
  const headingId = `${context.pageId}-agents-heading`;
  const grid = h('div', { className: 'agent-marketplace-grid', role: 'list' });
  const render = (sort = 'runtime') => {
    const sorted = [...agents].sort(agentComparator(sort));
    grid.replaceChildren(...sorted.map((agent) => renderAgentTile(agent)));
  };
  const count = h('span', { className: 'agent-marketplace-count' }, `${agents.length} agents`);
  const sort = renderSortControl(render);
  render();

  return h(
    'section',
    { className: `agent-marketplace-view ${composition.rootClassName}`, 'aria-labelledby': headingId },
    renderSectionHeading({
      kicker: 'Dashboard Next',
      id: headingId,
      title: context.title,
      description: context.description,
      headingTag: context.headingTag
    }),
    composition.body === 'toolbar'
      ? h('div', { className: 'agent-marketplace-toolbar' }, sort, count)
      : null,
    agents.length > 0
      ? (composition.body === 'grid'
        ? h('div', null, h('div', { className: 'agent-marketplace-toolbar' }, sort, count), grid)
        : null)
      : h('p', { role: 'status' }, 'No agent telemetry is available in the selected scope.')
  );
}

/** @param {(sort?: string) => void} onChange */
function renderSortControl(onChange) {
  return h(
    'label',
    { className: 'agent-marketplace-sort' },
    'Sort by ',
    h(
      'select',
      {
        'aria-label': 'Sort agents',
        onChange: (/** @type {Event} */ event) => onChange(/** @type {HTMLSelectElement} */ (event.currentTarget).value)
      },
      h('option', { value: 'runtime' }, 'Total time run'),
      h('option', { value: 'name' }, 'Name'),
      h('option', { value: 'status' }, 'Status')
    )
  );
}
