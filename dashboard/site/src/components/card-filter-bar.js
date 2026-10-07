import { h } from '../dom.js';
import { octicon } from '../octicons.js';
import { effect, state } from '../reactive.js';
import { createFactoryScope } from './factory-elements.js';

/** @typedef {{ selected: Record<string, string[]>, open: boolean[], scroll: number[] }} CardFilterState */
/** @type {WeakMap<HTMLElement, { read: () => CardFilterState, restore: (value: CardFilterState) => void }>} */
const controlsByRoot = new WeakMap();

/**
 * @param {{
 *   pageId: string,
 *   viewId: string,
 *   controls: import('../view-filter-contract.js').ViewFilterControl[],
 *   sources: Record<string, import('../presenter.js').LogicalSourceInput>,
 *   selected?: Record<string, string[]>,
 *   pending?: boolean,
 *   onChange: (filters: Record<string, string[]>) => void
 * }} options
 */
export function renderCardFilterBar(options) {
  const scope = createFactoryScope();
  const selected = state({ ...options.selected });
  const prefix = `card-filter-${options.pageId}-${options.viewId}`;
  const root = h('div', { id: prefix, className: 'card-filter-bar', role: 'group', 'aria-label': 'List filters' });
  const menus = options.controls.map((control) => {
    const count = h('span', { className: 'count-badge', hidden: true });
    const summary = h('summary', { id: `${prefix}-${control.id}` },
      control.label, count, octicon('triangle-down'));
    const details = /** @type {HTMLDetailsElement} */ (h('details', { className: 'card-filter-menu' }, summary));
    const groups = control.groups.map((group) => {
      const source = options.sources[group.source];
      const rows = source?.rows ?? [];
      const unavailable = source?.metadata.availability === 'unavailable';
      const partial = source?.metadata.completeness !== 'complete';
      const valid = rows.every((row) => typeof row[group['value-field']] === 'string'
        && (!group['label-field'] || typeof row[group['label-field']] === 'string'));
      const message = !source
        ? options.pending ? 'Loading filter options...' : 'Filter options unavailable.'
        : unavailable ? 'Filter options unavailable.'
          : !valid ? 'Invalid filter options.'
            : rows.length === 0 ? 'No options available.' : null;
      return h('fieldset', { className: 'card-filter-group' },
        h('legend', null, group.label),
        message ? h('p', { role: 'status' }, message) : null,
        !message && partial ? h('p', { role: 'status' }, 'Only retained options are available; evidence is incomplete.') : null,
        ...(!message ? rows.map((row) => {
          const value = String(row[group['value-field']]);
          const label = String(row[group['label-field'] ?? group['value-field']]);
          const input = /** @type {HTMLInputElement} */ (h('input', {
            id: `${prefix}-${control.id}-${encodeURIComponent(group.field)}-${encodeURIComponent(value)}`,
            type: 'checkbox',
            value
          }));
          input.addEventListener('change', () => {
            selected.set((current) => {
              const values = new Set(current[group.field] ?? []);
              if (input.checked) values.add(value);
              else values.delete(value);
              return { ...current, [group.field]: [...values] };
            });
          }, { signal: scope.signal });
          effect(() => {
            input.checked = selected.get()[group.field]?.includes(value) ?? false;
          }, { signal: scope.signal });
          return h('label', null, input, h('span', null, label));
        }) : [])
      );
    });
    const apply = h('button', { type: 'button' }, 'Apply filters');
    apply.addEventListener('click', () => {
      details.open = false;
      summary.focus();
      options.onChange(selected.get());
    }, { signal: scope.signal });
    details.append(h('div', { className: 'card-filter-popover' }, groups, apply));
    details.addEventListener('toggle', () => {
      summary.setAttribute('aria-expanded', String(details.open));
      if (details.open) {
        for (const other of menus) if (other !== details) other.open = false;
      }
    }, { signal: scope.signal });
    summary.setAttribute('aria-expanded', 'false');
    effect(() => {
      const current = selected.get();
      const total = control.groups.reduce((sum, group) => sum + (current[group.field]?.length ?? 0), 0);
      count.textContent = String(total);
      count.hidden = total === 0;
      summary.setAttribute('aria-label', total ? `${control.label}, ${total} selected` : control.label);
    }, { signal: scope.signal });
    return details;
  });
  const clear = h('button', { id: `${prefix}-clear`, type: 'button', className: 'card-filter-clear' },
    octicon('x'), 'Clear filters');
  clear.addEventListener('click', () => {
    for (const menu of menus) menu.open = false;
    selected.set({});
    menus[0]?.querySelector('summary')?.focus();
    options.onChange({});
  }, { signal: scope.signal });
  effect(() => {
    clear.hidden = !Object.values(selected.get()).some((values) => values.length > 0);
  }, { signal: scope.signal });
  root.append(...menus, clear);
  root.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    const open = menus.find((menu) => menu.open);
    if (!open) return;
    event.preventDefault();
    event.stopPropagation();
    open.open = false;
    open.querySelector('summary')?.focus();
  }, { signal: scope.signal });
  root.ownerDocument.addEventListener('click', (event) => {
    if (event.target instanceof Node && !root.contains(event.target)) {
      for (const menu of menus) menu.open = false;
    }
  }, { signal: scope.signal });
  controlsByRoot.set(root, {
    read: () => ({
      selected: selected.get(),
      open: menus.map((menu) => menu.open),
      scroll: menus.map((menu) => menu.querySelector('.card-filter-popover')?.scrollTop ?? 0)
    }),
    restore: (value) => {
      selected.set(value.selected);
      menus.forEach((menu, index) => {
        menu.open = value.open[index] ?? false;
        menu.querySelector('summary')?.setAttribute('aria-expanded', String(menu.open));
        const popover = menu.querySelector('.card-filter-popover');
        if (popover) popover.scrollTop = value.scroll[index] ?? 0;
      });
    }
  });
  scope.bind(root);
  return root;
}

/** @param {HTMLElement} container */
export function captureCardFilterState(container) {
  return new Map([...container.querySelectorAll('.card-filter-bar')].flatMap((root) => {
    const controls = root instanceof HTMLElement ? controlsByRoot.get(root) : undefined;
    return controls ? [[root.id, controls.read()]] : [];
  }));
}

/** @param {HTMLElement} container @param {Map<string, CardFilterState>} snapshots */
export function restoreCardFilterState(container, snapshots) {
  for (const root of container.querySelectorAll('.card-filter-bar')) {
    const snapshot = snapshots.get(root.id);
    if (root instanceof HTMLElement && snapshot) controlsByRoot.get(root)?.restore(snapshot);
  }
}
