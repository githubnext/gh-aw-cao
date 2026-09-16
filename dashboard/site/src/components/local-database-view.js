import { h } from '../dom.js';
import { renderResetDashboardControl } from './reset-dashboard-control.js';

/** @param {import('./ui-elements.js').ElementRenderContext} context */
export function renderLocalDatabaseView(context) {
  const fields = /** @type {const} */ ([
    ['database-package-count', 'packages', 'Packages'],
    ['database-repository-count', 'repositories', 'Repositories'],
    ['database-workflow-count', 'workflows', 'Workflows'],
    ['database-run-count', 'runs', 'Runs'],
    ['database-event-count', 'events', 'Events']
  ]);
  const available = fields.every(([sourceName, field]) => context.sources[sourceName]?.rows?.[0]?.[field] !== undefined);
  return h('div', { className: 'configuration-view local-database-view' },
    h('section', { className: 'configuration-browser-settings', 'aria-labelledby': 'transactions-database-heading' },
      h('div', { className: 'configuration-browser-settings-heading' },
        h('div', null,
          h('h3', { id: 'transactions-database-heading' }, 'Local database'),
          h('p', null, 'Records currently stored in this browser.')
        )
      ),
      h('div', { className: 'configuration-database-body' },
        available
          ? h('div', { className: 'configuration-database-counts' },
            fields.map(([sourceName, field, label]) => h('span', null,
              h('strong', null, String(context.sources[sourceName]?.rows?.[0]?.[field] ?? 0)),
              h('small', null, label)
            ))
          )
          : h('p', { className: 'configuration-browser-setting-status' }, 'Database counts unavailable.'),
        h('div', { className: 'configuration-local-data-actions' },
          renderResetDashboardControl()
        )
      )
    )
  );
}
