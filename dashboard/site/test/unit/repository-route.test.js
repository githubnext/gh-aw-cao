// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderRepositoryRouteView } from '../../src/components/repository-route-view.js';
import { setDeclaredCliActions } from '../../src/components/cli-actions.js';

const metadata = {
  'source-id': 'fixture',
  'source-kind': 'fixture',
  'as-of': '2026-09-18T18:00:00Z',
  'retrieved-at': '2026-09-18T18:01:00Z',
  completeness: /** @type {'complete'} */ ('complete'),
  freshness: /** @type {'fresh'} */ ('fresh'),
  availability: /** @type {'available'} */ ('available')
};

const repositoryActivity = [
  {
    repository: 'githubnext/gh-aw-cao',
    workflows: 12,
    runs: 966,
    ingestion: '22%',
    'failure-summary': '21.9% · 212 failed',
    aic: 4743,
    status: 'Needs attention',
    'repository-link': {
      relation: 'repository',
      href: 'https://github.com/githubnext/gh-aw-cao',
      label: 'View githubnext/gh-aw-cao on GitHub',
      'dashboard-href': '#page-repository-detail?repository=githubnext%2Fgh-aw-cao',
      'dashboard-label': 'View githubnext/gh-aw-cao repository dashboard'
    }
  },
  {
    repository: 'github/gh-aw',
    workflows: 3,
    runs: 5039,
    status: 'No failures observed'
  }
];

/** @param {string} pageId @param {'overview'|'insights'|'workflows'|'runs'|'settings'} body */
function context(pageId, body) {
  return {
    pageId,
    title: 'Repository',
    sourceNames: ['repository-activity'],
    contextDetails: [],
    routeParameter: 'repository',
    headingTag: /** @type {'h3'} */ ('h3'),
    elementConfig: { body },
    sources: {
      'repository-activity': { source: 'repository-activity', metadata, rows: repositoryActivity }
    }
  };
}

/** @param {HTMLElement} rendered */
function selectRepository(rendered) {
  rendered.dispatchEvent(new CustomEvent('dashboard-route-change', {
    detail: { parameter: 'repository', value: 'githubnext/gh-aw-cao' }
  }));
}

describe('repository route', () => {
  it('renders repository tabs for the selected repository', () => {
    const rendered = renderRepositoryRouteView(context('repository-detail', 'overview'));
    selectRepository(rendered);

    expect(rendered.dataset.repository).toBe('githubnext/gh-aw-cao');
    expect(rendered.querySelector('.repository-tabs')?.textContent).toBe('OverviewInsightsWorkflowsRunsSettings');
    expect([...rendered.querySelectorAll('.repository-tabs a')].map((link) => link.getAttribute('href'))).toEqual([
      '#page-repository-detail?repository=githubnext%2Fgh-aw-cao',
      '#page-repository-insights?repository=githubnext%2Fgh-aw-cao',
      '#page-repository-workflow-inventory?repository=githubnext%2Fgh-aw-cao',
      '#page-repository-runs?repository=githubnext%2Fgh-aw-cao',
      '#page-repository-settings?repository=githubnext%2Fgh-aw-cao'
    ]);
    expect(rendered.querySelector('.repository-tabs [aria-current="page"]')?.textContent).toBe('Overview');
  });

  it('summarizes observed repository activity on the overview tab', () => {
    const rendered = renderRepositoryRouteView(context('repository-detail', 'overview'));
    selectRepository(rendered);

    const overview = rendered.querySelector('.repository-overview');
    expect(overview?.querySelector('h2')?.textContent).toBe('githubnext/gh-aw-cao');
    expect(overview?.textContent).toContain('Needs attention');
    expect(overview?.textContent).toContain('21.9% · 212 failed');
    expect(overview?.querySelector('a')?.getAttribute('href')).toBe('https://github.com/githubnext/gh-aw-cao');
  });

  it('offers update and upgrade actions on the settings tab', () => {
    setDeclaredCliActions([
      {
        id: 'update-repository',
        label: 'Update all',
        icon: 'sync',
        command: './.github/aw/cao.sh update --repo {{repository}}',
        placement: /** @type {'view'} */ ('view')
      },
      {
        id: 'upgrade-repository',
        label: 'Upgrade all',
        icon: 'download',
        command: 'gh aw upgrade --repo {{repository}}',
        placement: /** @type {'view'} */ ('view')
      }
    ]);
    const rendered = renderRepositoryRouteView(context('repository-settings', 'settings'));
    selectRepository(rendered);

    const actions = [...rendered.querySelectorAll('.repository-settings-actions > .declared-cli-action > button')];
    expect(actions.map((action) => action.textContent)).toEqual(['Update all', 'Upgrade all']);
    expect(rendered.querySelector('.repository-tabs [aria-current="page"]')?.textContent).toBe('Settings');
    expect(rendered.textContent).toContain('./.github/aw/cao.sh update --repo githubnext/gh-aw-cao');
    setDeclaredCliActions([]);
  });

  it('asks for a repository selection when the route is empty', () => {
    const rendered = renderRepositoryRouteView(context('repository-detail', 'overview'));

    expect(rendered.textContent).toContain('Select a repository to view its overview.');
  });
});
