/**
 * Shared declarative work-project shell primitives.
 */

import { h } from '../dom.js';
import { renderEmptyMessage, renderSectionHeading } from './ui-primitives.js';

/**
 * @typedef {{
 *   key: string,
 *   className: string,
 *   title: string,
 *   landmarkLabel: string
 * }} WorkProjectSection
 */

/**
 * @param {import('./ui-elements.js').ElementRenderContext} context
 * @param {WorkProjectSection[]} sections
 * @param {number} itemCount
 * @param {(section: WorkProjectSection) => HTMLElement | null} renderSection
 * @returns {HTMLElement}
 */
export function renderWorkProjectShell(context, sections, itemCount, renderSection) {
  const headingId = `${context.pageId}-projects-heading`;
  return h(
    'section',
    { className: 'work-project-view', 'aria-labelledby': headingId },
    renderSectionHeading({
      kicker: 'Dashboard Next',
      id: headingId,
      title: context.title,
      description: context.description,
      headingTag: context.headingTag
    }),
    sections.length > 1
      ? h(
        'nav',
        { className: 'work-project-tabs', 'aria-label': 'Work layouts' },
        ...sections.map((section) => h('a', { href: `#${workSectionId(context.pageId, section.key)}` }, section.title))
      )
      : null,
    itemCount === 0
      ? renderEmptyMessage('No work-item telemetry is available in the selected scope.', { role: 'status' })
      : sections.map(renderSection).filter(Boolean)
  );
}

/** @param {string} pageId @param {string} key */
export function workSectionId(pageId, key) {
  return `${pageId}-${key}`;
}
