import { loadDashboardSourceSync } from '../../report/bundle-dashboards.mjs';
import { resolve } from 'node:path';

export const authoritativeDashboard = /** @type {any} */ (
  loadDashboardSourceSync(resolve('dashboard.json')).document
);
export const authoritativeDashboardSource = JSON.stringify(authoritativeDashboard);
