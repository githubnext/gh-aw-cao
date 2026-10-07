import { h } from '../dom.js';
import { processRepositoryMemoryFile } from '../data-processor.js';
import { effect, state } from '../reactive.js';
import { createFactoryScope } from './factory-elements.js';
import { renderFileContent } from './file-content.js';
import { renderInteractiveTabs, updateInteractiveTabSelection } from './tab-nav.js';
import { renderTableRegion } from './table-region.js';
import { renderEmptyMessage } from './ui-primitives.js';

let nextViewerId = 0;

/**
 * @param {string} path
 * @param {string} content
 * @param {AbortSignal} signal
 */
export async function renderMemoryFileContent(path, content, signal) {
  if (!/\.(?:json|jsonl)$/i.test(path)) return renderFileContent(content);
  const prepared = await processRepositoryMemoryFile(path, content, signal);
  signal.throwIfAborted();
  const result = prepared.table;
  if (!result) return renderFileContent(prepared.content);
  const scope = createFactoryScope({ signal });
  const selectedTab = state('raw');
  const id = `memory-file-${++nextViewerId}`;
  const raw = h('div', { id: `${id}-raw`, role: 'tabpanel', 'aria-label': 'Raw', tabindex: 0 },
    renderFileContent(prepared.content));
  const table = h('div', { id: `${id}-table`, role: 'tabpanel', 'aria-label': 'Table', tabindex: 0, hidden: true });
  let tableRequested = false;
  const tabs = renderInteractiveTabs({
    className: 'memory-file-tabs',
    ariaLabel: 'JSONL file view',
    panelId: raw.id,
    tabs: [{ label: 'Raw', value: 'raw', selected: true }, { label: 'Table', value: 'table' }],
    onSelect: (value) => {
      selectedTab.set(value);
      if (value !== 'table' || tableRequested || scope.signal.aborted) return;
      tableRequested = true;
      table.replaceChildren(result.error
        ? renderEmptyMessage(`Unable to display this JSONL table. ${result.error}`, { role: 'alert' })
        : renderTableRegion({
          tableClassName: 'custom-table memory-jsonl-table',
          emptyMessage: 'This JSONL file contains no records.',
          colSpan: result.columns.length + 1,
          headCells: ['Line', ...result.columns],
          compactColumns: [0],
          bodyRows: result.rows.map((row) => h('tr', null,
            h('td', { dataset: { sortValue: String(row.line) } }, String(row.line)),
            ...row.cells.map((cell) => h('td', null, cell)))),
          filterLabel: 'Filter JSONL records',
          filterPlaceholder: 'Filter records',
          resultNoun: 'record',
          resultNounPlural: 'records',
          lazyList: true,
        }));
    },
  });
  for (const button of tabs.querySelectorAll('[role="tab"]')) {
    button.setAttribute('aria-controls', button.getAttribute('data-tab-value') === 'raw' ? raw.id : table.id);
  }
  const root = h('div', { className: 'memory-file-viewer', 'data-key': id }, tabs, raw, table);
  effect(() => {
    const value = selectedTab.get();
    updateInteractiveTabSelection(tabs, value);
    raw.hidden = value !== 'raw';
    table.hidden = value !== 'table';
  }, { signal: scope.signal });
  scope.bind(root);
  return root;
}
