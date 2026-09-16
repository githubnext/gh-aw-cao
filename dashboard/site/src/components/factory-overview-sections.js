/**
 * Canonical Dashboard Language composition values for the factory overview.
 */
export const FACTORY_OVERVIEW_SECTION_VALUES = ['header', 'floor'];

/**
 * @param {{ sections?: unknown } | undefined} config
 * @returns {string[]}
 */
export function factoryOverviewSections(config) {
  if (!Array.isArray(config?.sections)) return [...FACTORY_OVERVIEW_SECTION_VALUES];
  const sections = config.sections.filter((section, index, values) => (
    typeof section === 'string'
    && FACTORY_OVERVIEW_SECTION_VALUES.includes(section)
    && values.indexOf(section) === index
  ));
  return sections.length > 0 ? sections : [...FACTORY_OVERVIEW_SECTION_VALUES];
}
