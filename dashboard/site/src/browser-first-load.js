import { state } from './reactive.js';

/** Browser import lifecycle, not campaign activity or canonical query data. */
export const browserFirstLoad = state(
  /** @type {{ status: 'inactive' | 'loading' | 'failed', dismissed: boolean, completed?: number, total?: number }} */ ({
    status: 'inactive',
    dismissed: false
  })
);

export function showBrowserFirstLoad() {
  browserFirstLoad.set((current) => ({ ...current, dismissed: false }));
}
