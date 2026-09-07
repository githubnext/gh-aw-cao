import { rowsFor } from './source-rows.js';
import { workViewComposition } from './work-view-composition.js';
import { workViewSectionRenderer } from './work-view-sections.js';
import { renderWorkProjectShell, workSectionId } from './work-project-shell.js';
import {
  normalizeWorkItem,
  renderWorkProjectBoard,
  renderWorkProjectRoadmap,
  renderWorkProjectTasks
} from './work-project-sections.js';

/**
 * @param {import('./ui-elements.js').ElementRenderContext} context
 * @returns {HTMLElement}
 */
export function renderWorkProjectView(context) {
  const items = rowsFor(context.sources, 'work-items').map(normalizeWorkItem);
  const sections = workViewComposition(context.elementConfig);
  const renderers = {
    renderBoard: renderWorkProjectBoard,
    renderTasks: renderWorkProjectTasks,
    renderRoadmap: renderWorkProjectRoadmap
  };
  return renderWorkProjectShell(context, sections, items.length, (section) => {
    const rendererName = workViewSectionRenderer(section.key, renderers);
    const renderer = rendererName ? renderers[rendererName] : null;
    return typeof renderer === 'function'
      ? renderer(items, {
        id: workSectionId(context.pageId, section.key),
        className: section.className,
        landmarkLabel: section.landmarkLabel,
        title: section.title
      })
      : null;
  });
}
