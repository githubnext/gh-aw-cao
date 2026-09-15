/**
 * Resolves the page whose data must be loaded during dashboard startup.
 *
 * @param {Array<{ id?: unknown }>} pages
 * @param {string} hash
 */
export function initialDashboardPageId(pages, hash) {
  if (hash.startsWith('#page-')) {
    const route = hash.slice('#page-'.length);
    const queryIndex = route.indexOf('?');
    try {
      const pageId = decodeURIComponent(queryIndex === -1 ? route : route.slice(0, queryIndex));
      if (pages.some((page) => page.id === pageId)) return pageId;
    } catch {
      // Fall through to the default page when the route is malformed.
    }
  }
  return pages.find((page) => page.id !== 'configuration')?.id?.toString()
    ?? pages[0]?.id?.toString()
    ?? '';
}
