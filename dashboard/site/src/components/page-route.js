/**
 * @param {HTMLElement} root
 * @param {string} parameter
 * @param {string} value
 */
export function dispatchPageRoute(root, parameter, value) {
  const routeViews = [...root.querySelectorAll('[data-route-view]')];
  if (root.matches('[data-route-view]')) routeViews.unshift(root);
  for (const routeView of routeViews) {
    routeView.dispatchEvent(new CustomEvent('dashboard-route-change', {
      detail: { parameter, value }
    }));
  }
}
