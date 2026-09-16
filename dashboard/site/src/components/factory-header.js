import { h } from '../dom.js';
import { formatCount } from './count-formatters.js';
import { renderFactoryRhythm } from './factory-rhythm.js';

/** @typedef {{ operations: number, live: number, review: number }} Motion */
/** @typedef {{ rows: () => Record<string, unknown>[], pending: () => boolean, unavailable: () => boolean }} SourceBinding */
/** @typedef {Record<string, SourceBinding>} SourceBindings */
/** @typedef {{ usefulOutputs: () => number, deliveredRepositories: () => number, motion: () => Motion }} HeaderMetrics */
/** @typedef {{ bind: (render: () => void) => void, memo: <T>(compute: () => T) => () => T, motion: import('../reactive.js').State<Motion> }} HeaderScope */

/**
 * @param {SourceBindings} sources
 * @param {HeaderMetrics} metrics
 * @param {HeaderScope} scope
 */
export function renderFactoryHeader(sources, metrics, scope) {
  const running = h('p', { className: 'factory-running' });
  const heading = h('h2', { id: 'agent-factory-heading' });
  const summary = h('p', {});

  scope.bind(() => {
    const motion = metrics.motion();
    scope.motion.set((current) => (sameMotion(current, motion) ? current : motion));
  });

  scope.bind(() => {
    const motion = scope.motion.get();
    running.className = `factory-running${motion.operations > 0 ? ' factory-running-active' : ''}`;
    running.replaceChildren(
      motion.operations > 0 ? h('span', {}, 'Work in motion') : 'Actions activity observed'
    );
  });

  scope.bind(() => {
    const status = sources['overview-factory-status'];
    const candidate = status.rows()[0]?.['factory-heading'];
    heading.textContent = !status.unavailable() && typeof candidate === 'string' && candidate
      ? candidate
      : 'Your factory status is unavailable.';
  });

  scope.bind(() => {
    const usefulOutputs = metrics.usefulOutputs();
    const deliveredRepositories = metrics.deliveredRepositories();
    summary.hidden = usefulOutputs === 0;
    summary.textContent = usefulOutputs > 0
      ? `${formatCount(usefulOutputs)} retained issue and pull request ${usefulOutputs === 1 ? 'output is' : 'outputs are'} backed by Actions evidence${deliveredRepositories > 0 ? ` across ${formatCount(deliveredRepositories)} ${deliveredRepositories === 1 ? 'repository' : 'repositories'}` : ''}.`
      : '';
  });

  return h(
    'header',
    { className: 'factory-intro' },
    h('div', { className: 'factory-intro-copy' }, running, heading, summary),
    renderFactoryRhythm(sources['overview-rhythm'], scope)
  );
}

/** @param {Motion} current @param {Motion} next */
function sameMotion(current, next) {
  return current.operations === next.operations
    && current.live === next.live
    && current.review === next.review;
}
