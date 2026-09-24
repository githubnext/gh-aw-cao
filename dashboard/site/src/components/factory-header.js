import { h } from '../dom.js';
import { render } from '../reactive.js';
import { bindFactorySources, createFactoryScope, resolveFactorySourceNames } from './factory-elements.js';
import { renderFactoryRhythm } from './factory-rhythm.js';

/** @typedef {{ rows: () => Record<string, unknown>[], pending: () => boolean, unavailable: () => boolean }} SourceBinding */
/** @typedef {Record<string, SourceBinding>} SourceBindings */
/** @typedef {{ signal: AbortSignal }} HeaderScope */

/**
 * @param {SourceBindings} sources
 * @param {HeaderScope} scope
 * @param {Record<string, string>} roleNames
 */
export function renderFactoryHeader(sources, scope, roleNames) {
  const heading = h('h2', { id: 'agent-factory-heading' });
  const summary = h('p');

  render(heading, () => {
    const presentation = sources[roleNames.presentation];
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
    const presentation = sources[roleNames.presentation];
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
    renderFactoryRhythm(sources[roleNames.rhythm], scope)
  );
}

/**
 * Default role-to-source-name bindings for the overview page. A view may
 * override any entry through `config.sources` to bind the same element to
 * differently named sources.
 * @type {Record<string, string>}
 */
export const HEADER_DEFAULT_SOURCES = {
  presentation: 'overview-header-presentation',
  rhythm: 'overview-rhythm'
};

/**
 * Renders the JSON-selected factory header from its declared query payloads.
 * @param {import('./ui-elements.js').ElementRenderContext} context
 */
export function renderFactoryHeaderElement(context) {
  const roleNames = resolveFactorySourceNames(HEADER_DEFAULT_SOURCES, context.elementConfig);
  const sources = bindFactorySources(context.sources, Object.values(roleNames), {
    pageId: context.pageId,
    viewId: context.viewId,
    viewIndex: context.viewIndex,
    sourceNames: context.sourceNames,
    queryContext: context.queryContext
  });
  const scope = createFactoryScope();
  const rendered = renderFactoryHeader(sources, scope, roleNames);
  scope.bind(rendered);
  return rendered;
}
