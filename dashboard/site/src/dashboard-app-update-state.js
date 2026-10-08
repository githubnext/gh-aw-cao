import { state } from './reactive.js';

// App installation is browser-local lifecycle state, not dashboard query data.
export const dashboardAppUpdateDownloading = state(false);
