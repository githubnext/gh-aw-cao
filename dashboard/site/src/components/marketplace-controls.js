import { h } from '../dom.js';
import { rowsFor } from './source-rows.js';
import { createDebug } from '../debug.js';

const debugMarketplaceControls = createDebug('marketplace-controls');

/** @type {Record<string, Array<{field: string, direction: 'asc'|'desc'}>>} */
const SORTS = {
  relevance: [
    { field: 'verification-rank', direction: 'desc' },
    { field: 'maintenance-rank', direction: 'desc' },
    { field: 'adoption-evidence-rank', direction: 'desc' },
    { field: 'adoption-count', direction: 'desc' },
    { field: 'stars-evidence-rank', direction: 'desc' },
    { field: 'stars', direction: 'desc' }
  ],
  adoption: [{ field: 'adoption-evidence-rank', direction: 'desc' }, { field: 'adoption-count', direction: 'desc' }],
  maintenance: [{ field: 'maintenance-unknown-rank', direction: 'asc' }, { field: 'last-maintained-at', direction: 'desc' }],
  stars: [{ field: 'stars-evidence-rank', direction: 'desc' }, { field: 'stars', direction: 'desc' }],
  name: [{ field: 'package-name', direction: 'asc' }]
};
/** @type {Array<{field: string, direction: 'asc'|'desc'}>} */
const TIE_BREAK = [{ field: 'package-name', direction: 'asc' }, { field: 'id', direction: 'asc' }];
/** @type {Array<[string, string, Array<[string, string]> | null]>} */
const FILTERS = [
  ['registry-id', 'Registry', null],
  ['publisher', 'Publisher', null],
  ['verification-status', 'Verification', [['verified', 'Verified by control policy'], ['unverified', 'Not verified'], ['unknown', 'Unknown']]],
  ['maintenance-status', 'Maintenance', [['active', 'Recently maintained'], ['stale', 'No recent activity'], ['unknown', 'Unknown']]],
  ['installation-status', 'Installation', [['installed', 'Installed here'], ['not-installed', 'Not installed here'], ['unknown', 'Unknown']]]
];

/** UI interaction only: all filtering, search and ordering execute in the data worker. */
/** @param {import('./ui-elements.js').ElementRenderContext} context */
export function renderMarketplaceControls(context) {
  const queryContext = context.queryContext ?? {};
  const currentFilters = queryContext.filters ?? {};
  const sources = context.sources;
  /** @type {Record<string, Array<[string, string]>>} */
  const options = {
    'registry-id': rowsFor(sources, context.sourceNames[0] ?? '').map((row) => [
      String(row['registry-id'] ?? ''), String(row['registry-name'] ?? row['registry-id'] ?? '')
    ]),
    publisher: rowsFor(sources, context.sourceNames[1] ?? '').map((row) => [
      String(row.publisher ?? ''), String(row.publisher ?? '')
    ])
  };
  const selectedSort = Object.entries(SORTS).find(([, fields]) =>
    JSON.stringify([...fields, ...TIE_BREAK]) === JSON.stringify(queryContext.orderBy)
  )?.[0] ?? 'relevance';
  const search = /** @type {HTMLInputElement} */ (h('input', {
    type: 'search', name: 'package-search', 'aria-label': 'Search packages by keyword',
    placeholder: 'Search packages', value: queryContext.search?.query ?? ''
  }));
  const selects = FILTERS.map(([field, label, fixed]) => {
    const choices = fixed ?? options[field] ?? [];
    const select = h('select', { name: field, 'aria-label': label },
      h('option', { value: '' }, `All ${label.toLowerCase()}s`),
      ...choices.filter(([value]) => value).map(([value, text]) =>
        h('option', { value, selected: currentFilters[field]?.[0] === value }, text)
      ));
    return h('label', null, h('span', null, label), select);
  });
  const sort = /** @type {HTMLSelectElement} */ (h('select', { name: 'sort', 'aria-label': 'Sort packages' },
    ...[['relevance', 'Relevance'], ['adoption', 'Control-plane adoption'], ['maintenance', 'Recent maintenance'],
      ['stars', 'Public stars'], ['name', 'Name']].map(([value, label]) =>
      h('option', { value, selected: selectedSort === value }, label))));
  const root = h('form', { className: 'marketplace-controls', role: 'search' },
    h('label', null, h('span', null, 'Keyword search'), search),
    h('button', { type: 'submit' }, 'Search'),
    ...selects,
    h('label', null, h('span', null, 'Sort by'), sort),
    h('p', { className: 'marketplace-controls-note' },
      'Search matches package names and descriptions. Missing signals are unknown, not zero. Semantic matching is not enabled.')
  );
  debugMarketplaceControls({
    event: 'rendered',
    registryOptionCount: options['registry-id'].length,
    publisherOptionCount: options.publisher.length,
    initialSort: selectedSort
  });
  /** @param {'submit'|'change'} trigger */
  function update(trigger) {
    const nextFilters = { ...currentFilters };
    for (const label of selects) {
      const select = label.querySelector('select');
      if (!select) continue;
      if (select.value) nextFilters[select.name] = [select.value];
      else delete nextFilters[select.name];
    }
    const query = search.value.trim().slice(0, 160);
    debugMarketplaceControls({
      event: 'query-context-changed',
      trigger,
      filterCount: Object.keys(nextFilters).length,
      hasSearch: query.length > 0,
      sort: sort.value
    });
    root.dispatchEvent(new CustomEvent('dashboard-query-context-change', {
      bubbles: true,
      detail: { pageId: context.pageId, queryContext: {
        ...queryContext,
        filters: nextFilters,
        search: query ? { fields: ['package-name', 'package-description'], query } : undefined,
        orderBy: [...(SORTS[sort.value] ?? SORTS.relevance), ...TIE_BREAK]
      } }
    }));
  }
  root.addEventListener('submit', (event) => { event.preventDefault(); update('submit'); });
  root.addEventListener('change', (event) => {
    if (event.target !== search) update('change');
  });
  return root;
}
