/**
 * Declarative work view composition primitives.
 */

import { defaultWorkViewComposition, isWorkViewSectionList, workViewCompositionForBody } from './work-view-primitives.js';

/**
 * @param {{ body?: unknown, sections?: unknown } | undefined} config
 * @returns {Array<ReturnType<typeof workViewCompositionForBody>>}
 */
export function workViewComposition(config) {
  if (isWorkViewSectionList(config?.sections)) {
    return config.sections.map((section) => workViewCompositionForBody(section));
  }
  return config?.body === undefined
    ? defaultWorkViewComposition()
    : [workViewCompositionForBody(config.body)];
}
