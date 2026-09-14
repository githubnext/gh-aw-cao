/**
 * GitHub Octicon and brand elements.
 */

import { h } from './dom.js';

const OCTICONS_URL = new URL('./octicons.svg', import.meta.url).href;

/**
 * @param {string} name
 * @param {string} [className]
 * @returns {SVGElement}
 */
export function octicon(name, className = '') {
  const glyph = name === 'issue'
    ? h('path', {
      d: 'M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1Zm0 12.5a5.5 5.5 0 1 1 0-11 5.5 5.5 0 0 1 0 11Zm-.75-9.25a.75.75 0 0 1 1.5 0v3a.75.75 0 0 1-1.5 0ZM8 9.5a1 1 0 1 1 0 2 1 1 0 0 1 0-2Z'
    })
    : h('use', { href: `${OCTICONS_URL}#octicon-${name}` });
  return /** @type {SVGElement} */ (/** @type {unknown} */ (h(
    'svg',
    {
      className: `octicon octicon-${name}${className ? ` ${className}` : ''}`,
      viewBox: '0 0 16 16',
      'aria-hidden': 'true',
      focusable: 'false'
    },
    glyph
  )));
}

/**
 * @returns {SVGElement}
 */
export function agenticWorkflowMark() {
  return /** @type {SVGElement} */ (/** @type {unknown} */ (h(
    'svg',
    {
      className: 'sidebar-brand-mark',
      viewBox: '0 0 24 24',
      'aria-hidden': 'true',
      focusable: 'false'
    },
    h('path', {
      d: 'M1 3a2 2 0 0 1 2-2h6.5a2 2 0 0 1 2 2v6.5a2 2 0 0 1-2 2H7v4.063C7 16.355 7.644 17 8.438 17H12.5v-2.5a2 2 0 0 1 2-2H21a2 2 0 0 1 2 2V21a2 2 0 0 1-2 2h-6.5a2 2 0 0 1-2-2v-2.5H8.437A2.939 2.939 0 0 1 5.5 15.562V11.5H3a2 2 0 0 1-2-2Zm2-.5a.5.5 0 0 0-.5.5v6.5a.5.5 0 0 0 .5.5h6.5a.5.5 0 0 0 .5-.5V3a.5.5 0 0 0-.5-.5Zm11.5 11.5a.5.5 0 0 0-.5.5V21a.5.5 0 0 0 .5.5H21a.5.5 0 0 0 .5-.5v-6.5a.5.5 0 0 0-.5-.5Z',
      fill: 'currentColor'
    }),
    h('path', {
      d: 'm17.143 3.15c.083-.222.406-.222.49 0l.58 1.545c.18.48.565.855 1.049 1.023l1.584.566c.228.081.228.396 0 .477l-1.584.566a1.763 1.719 0 0 0-1.05 1.023l-.58 1.545c-.083.223-.406.223-.489 0l-.58-1.545a1.763 1.719 0 0 0-1.049-1.023l-1.584-.566c-.228-.081-.228-.396 0-.477l1.584-.566a1.763 1.719 0 0 0 1.05-1.023Z',
      fill: 'var(--purple)',
      stroke: 'var(--purple)',
      'stroke-width': '.717'
    })
  )));
}
