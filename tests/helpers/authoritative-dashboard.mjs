import { loadDashboardSourceSync } from '../../dashboard/report/bundle-dashboards.mjs';

export const authoritativeDashboard = loadDashboardSourceSync(
  new URL('../../dashboard/site/dashboard.json', import.meta.url),
).document;
