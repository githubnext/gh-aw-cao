import { h } from '../dom.js';

/**
 * Renders a reusable, labelled panel around presentation components.
 * @param {{
 *   className?: string,
 *   labelledBy?: string,
 *   label?: string,
 *   children: Array<Node | string | null>
 * }} options
 * @returns {HTMLElement}
 */
export function renderPanel({ className, labelledBy, label, children }) {
  return h(
    'section',
    {
      className: ['ui-panel', className].filter(Boolean).join(' '),
      ...(labelledBy ? { 'aria-labelledby': labelledBy } : {}),
      ...(!labelledBy && label ? { 'aria-label': label } : {})
    },
    ...children
  );
}
