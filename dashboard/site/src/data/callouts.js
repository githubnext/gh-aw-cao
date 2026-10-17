import { processDashboardCallouts } from '../data-processor.js';
import { createDebug, diagnosticErrorName } from '../debug.js';

const debugCallouts = createDebug('data:callouts');

/**
 * Keeps declarative callout evaluation subscribed to evidence and wall-clock
 * changes. Browser and hosted query results use the same worker-only boundary.
 * @param {import('../components/site-callout.js').SiteCallout[]} callouts
 * @param {Record<string, import('../presenter.js').LogicalSourceInput>} sources
 * @param {import('../presenter.js').PageSourceLoader | undefined} loader
 * @param {AbortSignal} signal
 * @param {(result: import('./queries/callouts.js').CalloutVisibility[]) => void} onUpdate
 * @param {(error: unknown) => void} onError
 */
export function subscribeCalloutVisibility(callouts, sources, loader, signal, onUpdate, onError) {
  if (signal.aborted) return;
  const names = [...new Set(callouts.flatMap((callout) => (
    callout['visible-when'] ? [callout['visible-when'].source] : []
  )))];
  let latest = sources;
  let subscriptionFailed = false;
  let request = new AbortController();
  const evaluate = () => {
    request.abort();
    request = new AbortController();
    const current = request;
    const inputs = Object.fromEntries(names.flatMap((name) => latest[name] ? [[name, latest[name]]] : []));
    void processDashboardCallouts(callouts, inputs, current.signal).then((result) => {
      if (current.signal.aborted || signal.aborted) return;
      debugCallouts({ event: 'evaluated', status: 'ok', calloutCount: result.length });
      onUpdate(result);
    }).catch((error) => {
      if (current.signal.aborted || signal.aborted) return;
      debugCallouts({ event: 'evaluation-failed', errorName: diagnosticErrorName(error) });
      onError(error);
    });
  };
  const update = (/** @type {typeof sources} */ next) => {
    if (signal.aborted) return;
    subscriptionFailed = false;
    latest = next;
    evaluate();
  };
  const timer = callouts.some((callout) => callout['visible-when']?.['older-than-hours'] !== undefined)
    ? setInterval(() => { if (!subscriptionFailed) evaluate(); }, 60_000) : undefined;
  signal.addEventListener('abort', () => {
    request.abort();
    clearInterval(timer);
  }, { once: true });
  evaluate();
  if (loader?.subscribeBackgroundSources && names.length) {
    void loader.subscribeBackgroundSources(names, { signal, onUpdate: update })
      .then(update)
      .catch((error) => {
        if (signal.aborted) return;
        subscriptionFailed = true;
        debugCallouts({ event: 'subscription-failed', errorName: diagnosticErrorName(error) });
        request.abort();
        onError(error);
      });
  }
}
