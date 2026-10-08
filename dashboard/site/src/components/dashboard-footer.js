import { h } from '../dom.js';
import { formatMediumUtcDateTimeWithSuffix } from './ui-primitives.js';
import { createDebug } from '../debug.js';
import { dashboardAppUpdateDownloading } from '../dashboard-app-update-state.js';
import { octicon } from '../octicons.js';
import { render } from '../reactive.js';
import { createFactoryScope } from './factory-elements.js';

const debugDashboardFooter = createDebug('dashboard-footer');

function renderAppUpdateIndicator() {
  const scope = createFactoryScope();
  const root = h('span', { className: 'report-footer-app-update', role: 'status' });
  render(root, () => dashboardAppUpdateDownloading.get()
    ? h('span', { title: 'Downloading app update' },
        octicon('download'),
        h('span', { className: 'sr-only' }, 'Downloading app update'))
    : null, { signal: scope.signal });
  scope.bind(root);
  return root;
}

/** @param {{ evaluatedAt: string, commitSha?: string | null, caoVersion?: string | null, ghAwVersion?: string | null, githubUrlBase: string, dashboardRepository: string | null }} options */
export function renderDashboardFooter({ evaluatedAt, commitSha, caoVersion, ghAwVersion, githubUrlBase, dashboardRepository }) {
  const hasVersion = Boolean(commitSha) && commitSha !== 'development';
  const validShaFormat = hasVersion && /^[0-9a-f]{40}$/.test(/** @type {string} */ (commitSha));
  const linked = hasVersion && validShaFormat && Boolean(dashboardRepository);
  debugDashboardFooter({
    event: 'rendered',
    hasVersion,
    validShaFormat,
    hasRepository: Boolean(dashboardRepository),
    linked
  });
  return h(
    'footer',
    { className: 'report-footer' },
    h(
      'div',
      { className: 'report-footer-status' },
      h('span', null, 'Last updated'),
      h('time', { dateTime: evaluatedAt }, formatMediumUtcDateTimeWithSuffix(new Date(evaluatedAt))),
      h('span', { className: 'report-footer-provenance' }, '· Generated deterministically from dashboard data.')
    ),
    h(
      'span',
      { className: 'report-footer-versions' },
      caoVersion ? h('span', { className: 'report-footer-cao-version' }, 'CAO ', caoVersion) : null,
      ghAwVersion ? h('span', { className: 'report-footer-gh-aw-version' }, 'gh-aw ', ghAwVersion) : null,
      hasVersion
        ? h(
            'span',
            { className: 'report-footer-version', title: /** @type {string} */ (commitSha) },
            'Dashboard ',
            linked
              ? h('a', { href: `${githubUrlBase}/${dashboardRepository}/commit/${commitSha}`, 'aria-label': `View commit ${commitSha} on GitHub` }, h('code', null, /** @type {string} */ (commitSha).slice(0, 7)))
              : h('code', null, /** @type {string} */ (commitSha).slice(0, 7)),
            renderAppUpdateIndicator()
          )
        : null
    )
  );
}