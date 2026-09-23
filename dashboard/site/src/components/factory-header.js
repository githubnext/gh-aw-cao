import { h } from '../dom.js';
import { render } from '../reactive.js';
import { bindFactorySources, createFactoryScope } from './factory-elements.js';
import { renderFactoryRhythm } from './factory-rhythm.js';

/** @typedef {{ rows: () => Record<string, unknown>[], pending: () => boolean, unavailable: () => boolean }} SourceBinding */
/** @typedef {Record<string, SourceBinding>} SourceBindings */
/** @typedef {{ signal: AbortSignal }} HeaderScope */

/**
 * @param {SourceBindings} sources
 * @param {HeaderScope} scope
 */
export function renderFactoryHeader(sources, scope) {
  const heading = h('h2', { id: 'agent-factory-heading' });
  const summary = h('p', {});

  render(heading, () => {
    const presentation = sources['overview-header-presentation'];
    const pending = presentation.pending();
    const candidate = presentation.rows()[0]?.heading;
    heading.classList.toggle('factory-heading-pending', pending);
    heading.toggleAttribute('aria-busy', pending);
    return pending
      ? ''
      : !presentation.unavailable() && typeof candidate === 'string' && candidate
      ? candidate
      : 'Your campaign status is unavailable.';
  }, { signal: scope.signal });

  render(summary, () => {
    const presentation = sources['overview-header-presentation'];
    const pending = presentation.pending();
    const candidate = presentation.rows()[0]?.summary;
    const text = typeof candidate === 'string' ? candidate : '';
    summary.hidden = pending || !text;
    return pending ? '' : text;
  }, { signal: scope.signal });

  return h(
    'header',
    { className: 'factory-intro' },
    h('div', { className: 'factory-intro-copy' }, heading, summary),
    renderFactoryRhythm(sources['overview-rhythm'], scope)
  );
}

const HEADER_SOURCE_NAMES = [
  'overview-header-presentation',
  'overview-rhythm'
];

/**
 * Renders the JSON-selected factory header from its declared query payloads.
 * @param {import('./ui-elements.js').ElementRenderContext} context
 */
export function renderFactoryHeaderElement(context) {
  const sources = bindFactorySources(context.sources, HEADER_SOURCE_NAMES, {
    pageId: context.pageId,
    viewId: context.viewId,
    viewIndex: context.viewIndex,
    sourceNames: context.sourceNames,
    queryContext: context.queryContext
  });
  const scope = createFactoryScope();
  const rendered = renderFactoryHeader(sources, scope);
  scope.bind(rendered);
  return rendered;
}
