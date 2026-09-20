import { h } from '../dom.js';

const RIDERS = [
  { name: 'duck', label: 'Duck' },
  { name: 'octocat', label: 'Octocat' },
  { name: 'copilot', label: 'Copilot' }
];

/**
 * @param {'duck'|'octocat'|'copilot'} name
 * @returns {Element}
 */
function renderRiderIcon(name) {
  return h('img', {
    className: `agentic-loader-rider-icon agentic-loader-rider-icon-${name}`,
    src: `./src/assets/loaders/${name}.svg?v=filled-1`,
    alt: '',
    draggable: false
  });
}

/**
 * Renders shared loading chrome for dashboard bootstrap and page transitions.
 * @param {{ label?: string, className?: string, compact?: boolean }} [options]
 * @returns {HTMLElement}
 */
export function renderAgenticLoader({
  label = 'Loading dashboard',
  className = '',
  compact = false
} = {}) {
  const classes = ['agentic-loader', compact ? 'agentic-loader-compact' : '', className]
    .filter(Boolean)
    .join(' ');

  return h(
    'div',
    {
      className: classes,
      role: 'status',
      'aria-label': label
    },
    h('span', { className: 'sr-only' }, label),
    h(
      'div',
      { className: 'agentic-loader-scene', 'aria-hidden': 'true' },
      h(
        'div',
        { className: 'agentic-loader-rhythm' },
        h(
          'div',
          { className: 'agentic-loader-riders' },
          ...RIDERS.map(({ name, label }) => h(
            'span',
            {
              className: `agentic-loader-rider agentic-loader-rider-${name}`,
              title: label
            },
            renderRiderIcon(/** @type {'duck'|'octocat'|'copilot'} */ (name))
          ))
        ),
        ...Array.from({ length: 13 }, () => h('i', {}))
      ),
      h(
        'span',
        { className: 'agentic-loader-caption' },
        h('span', { className: 'agentic-loader-caption-eyebrow' }, 'Agentic campaigns'),
        h(
          'span',
          { className: 'agentic-loader-caption-status' },
          h('span', { className: 'agentic-loader-caption-text' }, 'Loading activity'),
          h(
            'span',
            { className: 'agentic-loader-caption-dots' },
            ...Array.from({ length: 3 }, () => h('span', { className: 'agentic-loader-caption-dot' }))
          )
        )
      )
    )
  );
}
