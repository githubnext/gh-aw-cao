import { h } from '../dom.js';
import { renderEmptyMessage } from './ui-primitives.js';
import { workViewComposition } from './work-view-composition.js';
import { renderWorkViewNavigation } from './work-view-navigation.js';
import { workRoutePageConfigs } from './work-view-route-config.js';
import { workViewSectionRenderer } from './work-view-sections.js';

/** @typedef {import('./work-project-view.js').NormalizedWorkItem} NormalizedWorkItem */

/**
 * @typedef {{ id: string, className: string, landmarkLabel: string, title: string, key: 'board'|'tasks'|'roadmap' }} WorkProjectSection
 */

/**
 * @param {{
 *   items: NormalizedWorkItem[],
 *   elementConfig?: { body?: unknown, sections?: unknown },
 *   renderers: Record<'renderBoard'|'renderTasks'|'renderRoadmap', (items: NormalizedWorkItem[], section: WorkProjectSection, onUpdate: () => void) => HTMLElement>,
 *   renderFilterBar: (items: NormalizedWorkItem[], onChange: (items: NormalizedWorkItem[]) => void) => { element: HTMLElement, apply: () => void },
 *   emptyItemsMessage: string,
 *   emptyFilteredMessage: string
 * }} options
 * @returns {HTMLElement}
 */
export function renderWorkProjectShell(options) {
  const sections = workViewComposition(options.elementConfig);
  const activeSection = sections[0].key;
  const viewBody = h('div', { className: 'work-project-body' });
  let reapplyFilters = () => renderItems(options.items);
  /** @param {NormalizedWorkItem[]} filteredItems */
  const renderItems = (filteredItems) => {
    if (options.items.length === 0) {
      viewBody.replaceChildren(renderEmptyMessage(options.emptyItemsMessage, { role: 'status' }));
      return;
    }
    if (filteredItems.length === 0) {
      viewBody.replaceChildren(renderEmptyMessage(options.emptyFilteredMessage, { role: 'status' }));
      return;
    }
    viewBody.replaceChildren(...sections
      .map((section) => {
        const rendererName = workViewSectionRenderer(section.key, options.renderers);
        const renderer = rendererName ? options.renderers[rendererName] : null;
        return typeof renderer === 'function'
          ? renderer(filteredItems, {
            id: workSectionId(section.key),
            key: section.key,
            className: section.className,
            landmarkLabel: section.landmarkLabel,
            title: section.title
          }, () => reapplyFilters())
          : null;
      })
      .filter((element) => element instanceof HTMLElement));
  };
  const filterBar = options.renderFilterBar(options.items, renderItems);
  reapplyFilters = filterBar.apply;
  const boundRenderers = {
    renderBoard: bindReapply(options.renderers.renderBoard, () => reapplyFilters()),
    renderTasks: bindReapply(options.renderers.renderTasks, () => reapplyFilters()),
    renderRoadmap: bindReapply(options.renderers.renderRoadmap, () => reapplyFilters())
  };
  options.renderers = boundRenderers;
  const root = h(
    'section',
    { className: 'work-project-view', 'aria-label': 'Work' },
    renderWorkViewNavigation(workRoutePageConfigs(), activeSection),
    filterBar.element,
    viewBody
  );
  renderItems(options.items);
  return root;
}

/**
 * @param {(items: NormalizedWorkItem[], section: WorkProjectSection, onUpdate: () => void) => HTMLElement} renderer
 * @param {() => void} reapply
 * @returns {(items: NormalizedWorkItem[], section: WorkProjectSection, onUpdate: () => void) => HTMLElement}
 */
function bindReapply(renderer, reapply) {
  return (items, section) => renderer(items, section, reapply);
}

/** @param {'board'|'tasks'|'roadmap'} key */
function workSectionId(key) {
  return `work-project-${key}`;
}
