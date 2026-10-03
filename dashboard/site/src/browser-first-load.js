import { state } from './reactive.js';
import { createDebug } from './debug.js';

const debugBrowserFirstLoad = createDebug('browser-first-load');

/** Browser import lifecycle, not campaign activity or canonical query data. */
export const browserFirstLoad = state(
  /** @type {{ status: 'inactive' | 'loading' | 'failed', dismissed: boolean, completed?: number, total?: number, stage?: 'files' | 'maintenance' | 'inventory' | 'queries' }} */ ({
    status: 'inactive',
    dismissed: false
  })
);

export function showBrowserFirstLoad() {
  const previousStatus = browserFirstLoad.get().status;
  browserFirstLoad.set((current) => ({ ...current, dismissed: false }));
  debugBrowserFirstLoad({ event: 'reopen-requested', previousStatus });
}
