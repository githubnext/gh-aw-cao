/**
 * Declarative work view section validation.
 */

import { WORK_VIEW_SECTION_KEYS } from './route-body-specification.js';

/**
 * @param {string} section
 * @returns {section is typeof WORK_VIEW_SECTION_KEYS[number]}
 */
export function isWorkViewSection(section) {
  return typeof section === 'string'
    && WORK_VIEW_SECTION_KEYS.includes(/** @type {typeof WORK_VIEW_SECTION_KEYS[number]} */ (section));
}
