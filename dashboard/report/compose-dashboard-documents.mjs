/**
 * @typedef {{
 *   "language-version": string,
 *   dashboard: {
 *     pages: Array<Record<string, unknown>>,
 *     navigation?: Array<{ label?: string, pages: string[], experimental?: boolean }>,
 *     [key: string]: unknown
 *   },
 *   [key: string]: unknown
 * }} DashboardDocument
 */

/**
 * @template T
 * @param {T} primary
 * @param {T[]} additions
 * @returns {T}
 */
export function composeDashboardDocuments(primary, additions) {
  const result = /** @type {DashboardDocument} */ (structuredClone(primary));
  const additionalDocuments = /** @type {DashboardDocument[]} */ (additions);
  const pageIds = new Set(result.dashboard.pages.map((page) => page.id));
  const sections = new Map((result.dashboard.navigation || []).map((section) => [section.label, section]));

  for (const addition of additionalDocuments) {
    if (addition["language-version"] !== result["language-version"]) {
      throw new Error(`dashboard language version mismatch: expected ${result["language-version"]}, got ${addition["language-version"]}`);
    }
    for (const page of addition.dashboard.pages) {
      if (pageIds.has(page.id)) throw new Error(`duplicate dashboard page id: ${page.id}`);
      pageIds.add(page.id);
      result.dashboard.pages.push(page);
    }
    for (const incoming of addition.dashboard.navigation || []) {
      const section = sections.get(incoming.label);
      if (section) {
        section.pages.push(...incoming.pages);
      } else {
        const appended = structuredClone(incoming);
        result.dashboard.navigation ??= [];
        result.dashboard.navigation.push(appended);
        sections.set(appended.label, appended);
      }
    }
  }
  return /** @type {T} */ (/** @type {unknown} */ (result));
}
