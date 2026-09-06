/**
 * Shared Dashboard Language view factories for experiments-evaluation pages.
 */

/**
 * @typedef {'overview'|'table'|'detail'} ExperimentsEvaluationBody
 */

/**
 * @param {{
 *   id: string,
 *   title: string,
 *   body?: ExperimentsEvaluationBody,
 *   sections?: ExperimentsEvaluationBody[],
 *   sources: string[],
 *   layout?: 'full'|'wide'|'compact'
 * }} options
 */
export function createExperimentsEvaluationView(options) {
  const config = options.sections
    ? { sections: options.sections }
    : { body: options.body ?? 'detail' };
  return {
    id: options.id,
    title: options.title,
    data: {
      sources: options.sources
    },
    mark: 'element',
    element: 'experiments-evaluation',
    config,
    ...(options.layout ? { layout: options.layout } : {})
  };
}
