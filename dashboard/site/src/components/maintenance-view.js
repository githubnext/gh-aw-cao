import { h } from '../dom.js';
import { octicon } from '../octicons.js';
import { renderDeclaredCliAction, renderRowCliAction } from './cli-actions.js';
import { renderListOrEmptyMessage } from './ui-primitives.js';
import { renderPageSection, renderViewSectionChrome } from './view-chrome.js';

/** @param {unknown} value */
function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : 'Unknown';
}

/** @param {unknown} value */
function updateAvailable(value) {
  return String(value ?? '').split(',').map((entry) => entry.trim()).includes('update-available');
}

/** @param {string} label @param {unknown} value */
function detail(label, value) {
  return h('span', { className: 'maintenance-card-detail' },
    h('span', null, label),
    h('strong', null, text(value)));
}

/** @param {Record<string, unknown>} row */
function packageCard(row) {
  const action = updateAvailable(row['package-update-state'])
    ? renderRowCliAction('update-package', { package: text(row.package) }, { showLabel: true })
    : null;
  return h(
    'li',
    { className: 'maintenance-card' },
    h('div', { className: 'maintenance-card-icon', 'aria-hidden': 'true' }, octicon('package')),
    h(
      'div',
      { className: 'maintenance-card-content' },
      h('strong', { className: 'maintenance-card-title' }, text(row['package-name'] ?? row.package)),
      h(
        'div',
        { className: 'maintenance-card-details' },
        detail('Installed', row['package-version']),
        detail('Latest', row['package-current-version'])
      )
    ),
    action
  );
}

/** @param {Record<string, unknown>} row */
function repositoryCard(row) {
  const shouldUpgrade = updateAvailable(row['gh-aw-update-state']);
  const repository = text(row.repository);
  const action = shouldUpgrade
    ? renderRowCliAction('upgrade-target-repository', { repository }, { showLabel: true })
    : null;
  return h(
    'li',
    { className: 'maintenance-card' },
    h('div', { className: 'maintenance-card-icon', 'aria-hidden': 'true' }, octicon('repo')),
    h(
      'div',
      { className: 'maintenance-card-content' },
      h('strong', { className: 'maintenance-card-title' }, repository),
      h(
        'div',
        { className: 'maintenance-card-details' },
        detail('Installed', row['gh-aw-version']),
        detail('Latest', row['gh-aw-current-version']),
        h(
          'span',
          { className: `maintenance-card-state ${shouldUpgrade ? 'maintenance-card-state-attention' : ''}` },
          shouldUpgrade ? 'Upgrade recommended' : text(row['gh-aw-update-state']) === 'up-to-date' ? 'Current' : 'Upgrade status unavailable'
        )
      )
    ),
    action
  );
}

/**
 * @param {string} title
 * @param {string} description
 * @param {HTMLElement | null} action
 * @param {HTMLElement} list
 */
function maintenanceGroup(title, description, action, list) {
  return h(
    'section',
    { className: 'maintenance-group', 'aria-label': title },
    h(
      'header',
      { className: 'maintenance-group-header' },
      h('div', null, h('h3', null, title), h('p', null, description)),
      action
    ),
    list
  );
}

/** @param {import('./ui-elements.js').ElementRenderContext} context */
export function renderMaintenanceView(context) {
  const packageSource = context.sources[context.sourceNames[0]];
  const repositorySource = context.sources[context.sourceNames[1]];
  const packages = [...(packageSource?.rows ?? [])].sort((left, right) =>
    text(left['package-name'] ?? left.package).localeCompare(text(right['package-name'] ?? right.package)));
  const repositories = [...(repositorySource?.rows ?? [])].sort((left, right) =>
    text(left.repository).localeCompare(text(right.repository)));

  const rendered = renderPageSection(
    context.pageId,
    context.title,
    [
      ...renderViewSectionChrome(packageSource?.metadata, context.contextDetails),
      maintenanceGroup(
        'Starter updates',
        'Update installed starter packages when a newer package revision is available.',
        renderDeclaredCliAction('update-repository'),
        renderListOrEmptyMessage(
          'maintenance-card-list',
          packages,
          packageCard,
          'maintenance-empty',
          'No installed packages were discovered.'
        )
      ),
      maintenanceGroup(
        'Compiler upgrades',
        'Upgrade repositories that use an older gh-aw compiler version.',
        renderDeclaredCliAction('upgrade-repository'),
        renderListOrEmptyMessage(
          'maintenance-card-list',
          repositories,
          repositoryCard,
          'maintenance-empty',
          'No repositories with Agentic Workflows were discovered.'
        )
      )
    ],
    context.headingTag,
    context.description
  );
  rendered.classList.add('maintenance-view');
  return rendered;
}
