import { h } from '../dom.js';
import { octicon } from '../octicons.js';
import { isSafeHttpsUrl } from './ui-primitives.js';

/**
 * @param {{ title: string, description?: string, overviewPageHref: string, dashboardHorizon: HTMLElement, githubUrlBase: string, dashboardRepository: string | null, viewer?: { login: string, name: string, avatarUrl: string } | null }} options
 */
export function renderDashboardHeader(options) {
  const viewerLabel = options.viewer?.name || options.viewer?.login;
  const avatar = options.viewer && isSafeHttpsUrl(options.viewer.avatarUrl)
    ? h(
        'span',
        { className: 'viewer-avatar', title: viewerLabel ? `Signed in as ${viewerLabel}` : 'Signed in viewer' },
        h('img', {
          className: 'viewer-avatar-image',
          src: options.viewer.avatarUrl,
          alt: viewerLabel ? `${viewerLabel} avatar` : 'Viewer avatar',
          width: 28,
          height: 28,
          referrerPolicy: 'no-referrer'
        })
      )
    : null;

  return h(
    'header',
    { className: 'top-nav' },
    h(
      'div',
      { className: 'shell' },
      h(
        'div',
        { className: 'overview-header', 'aria-labelledby': 'page-title' },
        h(
          'nav',
          { className: 'breadcrumb-context', 'aria-label': 'Breadcrumb' },
          h('a', { hidden: true, 'data-breadcrumb-root': '' }),
          h('a', { href: options.overviewPageHref, hidden: true, 'data-breadcrumb-dashboard': '' }, 'Overview')
        ),
        h(
          'div',
          { className: 'title-area' },
          h('h1', { id: 'page-title', tabIndex: -1, 'data-breadcrumb-page': '' }, options.title),
          h('a', { className: 'title-link', 'data-page-title-link': '', hidden: true }),
          h('span', { className: 'mode-indicator', 'data-page-mode': '', hidden: true })
        ),
        h('p', { className: 'lede', 'data-page-description': '', hidden: !options.description }, options.description ?? '')
      ),
      h(
        'div',
        { className: 'report-actions' },
        options.dashboardHorizon,
        options.dashboardRepository
          ? h(
              'a',
              {
                className: 'repository-link',
                href: `${options.githubUrlBase}/${options.dashboardRepository}`,
                'aria-label': `View ${options.dashboardRepository} on GitHub`,
                title: `View ${options.dashboardRepository} on GitHub`
              },
              octicon('mark-github'),
              h('span', { className: 'sr-only action-label' }, options.dashboardRepository)
            )
          : null,
        avatar
      )
    )
  );
}