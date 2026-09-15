/**
 * Declarative work view composition primitives.
 */

import { defaultWorkViewComposition, workViewCompositionForBody } from './work-view-primitives.js';
import { isWorkViewSection } from './work-view-sections.js';

/**
 * @param {{ body?: unknown, sections?: unknown } | undefined} config
 * @returns {Array<ReturnType<typeof workViewCompositionForBody>>}
 */
export function workViewComposition(config) {
  if (Array.isArray(config?.sections)) {
    const sections = config.sections
      .filter(isWorkViewSection)
      .map((section) => workViewCompositionForBody(section));
    return sections.length > 0 ? sections : defaultWorkViewComposition();
  }
  return [workViewCompositionForBody(config?.body)];
}
