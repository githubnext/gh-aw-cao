// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderWorkProjectView } from '../../src/components/work-project-view.js';
import { renderWorkItemCard } from '../../src/components/work-item-card.js';
import { renderWorkItemRow } from '../../src/components/work-item-row.js';
import { renderWorkItemTimelineLane } from '../../src/components/work-item-timeline-lane.js';
import { renderWorkViewNavigation } from '../../src/components/work-view-navigation.js';
import { workRoutePageConfigForBody, workRoutePageConfigs } from '../../src/components/work-view-route-config.js';
import { applyDashboardQueries } from '../workflow-inventory-query.js';

const metadata = {
  'source-id': 'work-fixture',
  'source-kind': 'fixture',
  'as-of': '2026-09-14T00:00:00Z',
  'retrieved-at': '2026-09-14T00:00:00Z',
  completeness: /** @type {'complete'} */ ('complete'),
  freshness: /** @type {'fresh'} */ ('fresh'),
  availability: /** @type {'available'} */ ('available')
};

/** @param {Array<Record<string, unknown>>} rows */
function workSources(rows) {
  return applyDashboardQueries({
    'work-items': { source: 'work-items', rows, metadata }
  }, ['work-project-items', 'work-board-todo', 'work-board-in-progress', 'work-board-needs-review', 'work-board-done', 'work-roadmap-items']);
}

const item = {
  name: 'Dependabot release train',
  icon: 'dependabot',
  repository: 'github/gh-aw',
  owner: 'dependency-automation',
  packageName: 'dependabot',
  workType: 'worker',
  started: '2026-08-30T09:00:00Z',
  timeLabel: 'Started',
  startedLabel: 'Aug 30, 2026, 9:00 AM',
  stoppedLabel: 'Aug 30, 2026, 9:30 AM',
  durationLabel: '30m',
  state: 'in-progress',
  stateLabel: 'In Progress',
  startTime: Date.parse('2026-08-30T09:00:00Z'),
  stopTime: Date.parse('2026-08-30T09:30:00Z'),
  safeOutputKind: 'pull-request',
  actor: 'reviewer',
  evidenceLink: {
    relation: 'evidence',
    href: 'https://example.com/evidence/dependabot',
    label: 'Dependabot evidence'
  },
  repositoryLink: {
    href: 'https://ghe.example/github/gh-aw',
    label: 'Open github/gh-aw'
  }
};

describe('work project view primitives', () => {
  it('renders reusable work cards independently of the work page', () => {
    const rendered = renderWorkItemCard(item);
    expect(rendered.className).toBe('work-card');
    expect(rendered.getAttribute('data-work-state')).toBe('in-progress');
    expect(rendered.textContent).toContain('Dependabot release train');
    expect(rendered.textContent).toContain('dependency-automation');
    expect(rendered.querySelector('.work-owner-avatar')?.textContent).toBe('DA');
    expect(rendered.querySelector('.work-owner-avatar')?.getAttribute('aria-label')).toBe('Owner: dependency-automation');
    expect(rendered.querySelector('.work-card-label-package')?.textContent).toBe('dependabot');
    expect(rendered.querySelector('.work-card-label-role')?.textContent).toBe('worker');
  });

  it('renders reusable work rows independently of the work page', () => {
    const rendered = renderWorkItemRow(item);
    expect(rendered.className).toBe('work-task-row');
    expect(rendered.getAttribute('role')).toBe('listitem');
    expect(rendered.textContent).toContain('github/gh-aw');
    expect(rendered.querySelector('time')?.getAttribute('dateTime')).toBe('2026-08-30T09:00:00Z');
    expect(rendered.querySelector('.work-task-owner')?.textContent).toContain('github/gh-aw');
    expect(rendered.querySelector('.work-task-owner .octicon-repo')).not.toBeNull();
    expect(rendered.querySelector('.work-task-owner a')?.getAttribute('href')).toBe('https://ghe.example/github/gh-aw');
    expect(rendered.querySelector('.work-task-owner a')?.getAttribute('target')).toBe('_blank');
  });

  it('renders reusable work timeline lanes independently of the work page', () => {
    const rendered = renderWorkItemTimelineLane(item, {
      start: item.startTime,
      duration: 30 * 60 * 1000
    }, 3, 6);
    expect(rendered.className).toBe('work-roadmap-lane');
    expect(rendered.querySelector('.work-roadmap-bar')?.getAttribute('style')).toContain('--work-start: 0.00%');
    expect(rendered.querySelector('.work-roadmap-index')?.textContent).toBe('4');
    expect(rendered.querySelector('.work-roadmap-label-copy')?.textContent).toContain('github/gh-aw · dependency-automation');
    expect(rendered.querySelector('.work-roadmap-track')?.getAttribute('style')).toContain('--roadmap-divisions: 6');
    expect(rendered.querySelector('.work-roadmap-primitive .octicon-git-pull-request')).not.toBeNull();
    expect(rendered.querySelector('.work-roadmap-primitive')?.getAttribute('aria-label')).toBe('Safe output: Pull request');
    expect(rendered.querySelector('.work-roadmap-avatar')?.textContent).toBe('R');
    expect(rendered.querySelector('.work-roadmap-owner')?.textContent).toBe('reviewer');
    expect(rendered.querySelector('.work-roadmap-end')?.getAttribute('style')).toContain('--work-stop: 100.00%');
  });

  it('derives reusable work route navigation from declarative body selection', () => {
    expect(workRoutePageConfigForBody('board')).toMatchObject({
      key: 'board',
      pageId: 'work',
      href: '#page-work',
      title: 'Board'
    });
    expect(workRoutePageConfigForBody('tasks')).toMatchObject({
      key: 'tasks',
      pageId: 'work-tasks',
      href: '#page-work-tasks',
      title: 'Tasks'
    });
    expect(workRoutePageConfigForBody('roadmap')).toMatchObject({
      key: 'roadmap',
      pageId: 'work-roadmap',
      href: '#page-work-roadmap',
      title: 'Roadmap'
    });
    const rendered = renderWorkViewNavigation(workRoutePageConfigs(), 'tasks');
    expect([...rendered.querySelectorAll('a')].map((link) => ({
      href: link.getAttribute('href'),
      current: link.getAttribute('aria-current'),
      text: link.textContent
    }))).toEqual([
      { href: '#page-work', current: null, text: 'Board' },
      { href: '#page-work-tasks', current: 'page', text: 'Tasks' },
      { href: '#page-work-roadmap', current: null, text: 'Roadmap' }
    ]);
  });

  it('renders a compact custom Table with configurable sorting and mobile field selection', () => {
    const rows = [
      { 'work-item-id': 'alpha', name: 'Alpha task', owner: 'Zed', scope: 'github/alpha', 'lifecycle-state': 'waiting', 'started-at': '2026-08-29T09:00:00Z' },
      { 'work-item-id': 'beta', name: 'Beta task', owner: 'Ada', scope: 'github/zeta', 'lifecycle-state': 'active', 'started-at': '2026-08-30T09:00:00Z' }
    ];
    const rendered = renderWorkProjectView(/** @type {any} */ ({
      pageId: 'work-tasks',
      title: 'Tasks',
      sources: workSources(rows),
      elementConfig: { body: 'tasks' }
    }));

    expect(rendered.querySelector('.work-task-view-name')?.textContent).toContain('Operations tasks');
    expect(rendered.querySelector('.work-mobile-field-settings')).not.toBeNull();
    expect([...rendered.querySelectorAll('[name="mobile-work-field"]')].map((field) => /** @type {HTMLInputElement} */ (field).value)).toEqual([
      'repository', 'status', 'owner', 'label', 'dates'
    ]);
    expect([...rendered.querySelectorAll('.work-task-table-header > *')].map((header) => header.textContent)).toEqual([
      '', 'Title', 'Status', 'Type', 'Labels', 'Start', 'End', 'Owned by'
    ]);
    expect([...rendered.querySelectorAll('.work-task-row .work-task-title strong')].map((title) => title.textContent)).toEqual(['Beta task', 'Alpha task']);

    /** @type {unknown[]} */
    const changes = [];
    rendered.addEventListener('dashboard-query-context-change', (event) => {
      if (event instanceof CustomEvent) changes.push(event.detail);
    });
    const sort = /** @type {HTMLSelectElement} */ (rendered.querySelector('[aria-label="Sort tasks by"]'));
    sort.value = 'name';
    sort.dispatchEvent(new Event('change'));
    expect(changes.at(-1)).toEqual({
      pageId: 'work-tasks',
      queryContext: { orderBy: [{ field: 'work-name', direction: 'asc' }] }
    });
    expect([...rendered.querySelectorAll('.work-task-row .work-task-title strong')].map((title) => title.textContent)).toEqual(['Beta task', 'Alpha task']);

    /** @type {HTMLButtonElement} */ (rendered.querySelector('[aria-label="Sort descending"]')).click();
    expect(changes.at(-1)).toEqual({
      pageId: 'work-tasks',
      queryContext: { orderBy: [{ field: 'work-name', direction: 'desc' }] }
    });

    /** @type {HTMLButtonElement} */ (rendered.querySelector('[aria-label="Sort by owned by"]')).click();
    expect(changes.at(-1)).toEqual({
      pageId: 'work-tasks',
      queryContext: { orderBy: [{ field: 'work-owner', direction: 'asc' }] }
    });
  });

  it('highlights the first rendered section when declarative sections override body', () => {
    const rendered = renderWorkProjectView(/** @type {any} */ ({
      pageId: 'work-custom',
      title: 'Custom work',
      sources: workSources([
        { 'work-item-id': 'task', name: 'Section-driven task', 'lifecycle-state': 'active' }
      ]),
      elementConfig: {
        body: 'roadmap',
        sections: ['tasks']
      }
    }));

    expect(rendered.querySelector('[href="#page-work-tasks"]')?.getAttribute('aria-current')).toBe('page');
    expect(rendered.querySelector('[href="#page-work-roadmap"]')?.getAttribute('aria-current')).toBeNull();
    expect(rendered.querySelector('.work-tasks')).not.toBeNull();
    expect(rendered.querySelector('.work-roadmap')).toBeNull();
  });

  it('presents telemetry states as todo, in progress, needs review, and done', () => {
    const rows = [
      { 'work-item-id': 'todo', name: 'Queued item', 'lifecycle-state': 'waiting' },
      { 'work-item-id': 'progress', name: 'Running item', 'lifecycle-state': 'active' },
      { 'work-item-id': 'review', name: 'Blocked item', 'lifecycle-state': 'blocked' },
      { 'work-item-id': 'done', name: 'Completed item', 'lifecycle-state': 'completed' }
    ];
    const rendered = renderWorkProjectView(/** @type {any} */ ({
      pageId: 'work',
      title: 'Work',
      sources: workSources(rows)
    }));
    const columns = [...rendered.querySelectorAll('.work-board-column')];

    expect(columns.map((column) => column.querySelector('h4')?.textContent)).toEqual([
      'Todo', 'In progress', 'Needs review', 'Done'
    ]);
    expect(columns.map((column) => column.querySelector('.work-card')?.getAttribute('data-work-state'))).toEqual([
      'todo', 'in-progress', 'needs-review', 'done'
    ]);
    expect(rendered.textContent).not.toContain('Waiting');
    expect(rendered.textContent).not.toContain('Active');
  });

  it('provides a one-group mobile Board with canonical state and full-screen details', () => {
    const rows = [
      { 'work-item-id': 'todo', name: 'Queued item', owner: 'operations', package: 'core', 'lifecycle-state': 'waiting' },
      { 'work-item-id': 'review', name: 'Blocked item', owner: 'security', package: 'review', 'lifecycle-state': 'blocked', reason: 'Approval required', 'waiting-on': 'reviewer decision' }
    ];
    const rendered = renderWorkProjectView(/** @type {any} */ ({
      pageId: 'work',
      title: 'Work',
      sources: workSources(rows)
    }));
    const tabs = [...rendered.querySelectorAll('.work-board-group-tab')];

    expect(rendered.querySelector('.work-project-tabs')?.textContent).toBe('BoardTasksRoadmap');
    expect(tabs.map((tab) => tab.textContent)).toEqual(['Todo1', 'In progress0', 'Needs review1', 'Done0']);
    expect(tabs.map((tab) => tab.getAttribute('aria-selected'))).toEqual(['false', 'false', 'true', 'false']);
    expect(rendered.querySelector('.work-board-column[data-mobile-active="true"] h4')?.textContent).toBe('Needs review');

    /** @type {HTMLButtonElement} */ (tabs[0]).click();
    expect(rendered.querySelector('.work-board-column[data-mobile-active="true"] h4')?.textContent).toBe('Todo');

    expect(rendered.querySelector('[aria-label="Move Queued item to"]')).toBeNull();

    const blockedCard = [...rendered.querySelectorAll('.work-card')].find((card) => card.textContent?.includes('Blocked item'));
    if (!(blockedCard instanceof HTMLElement)) throw new Error('blocked card did not render');
    /** @type {HTMLButtonElement} */ (blockedCard.querySelector('[aria-label="Open Blocked item details"]')).click();
    const detail = rendered.querySelector('[aria-label="Blocked item details"]');
    expect(detail?.hasAttribute('open')).toBe(true);
    expect(detail?.textContent).toContain('Approval required');
    expect(detail?.textContent).toContain('reviewer decision');
    expect(detail?.textContent).not.toContain('Quick update');
  });

  it('requests worker filtering when a facet changes', () => {
    const rows = [
      { 'work-item-id': 'todo', name: 'Queued item', 'lifecycle-state': 'waiting' },
      { 'work-item-id': 'review', name: 'Blocked item', 'lifecycle-state': 'blocked' }
    ];
    const rendered = renderWorkProjectView(/** @type {any} */ ({
      pageId: 'work',
      title: 'Work',
      sources: workSources(rows)
    }));
    /** @type {unknown[]} */
    const changes = [];
    rendered.addEventListener('dashboard-query-context-change', (event) => {
      if (event instanceof CustomEvent) changes.push(event.detail);
    });
    const stateFilter = /** @type {HTMLSelectElement} */ (rendered.querySelector('[aria-label="Filter by state"]'));
    stateFilter.value = 'Needs Review';
    stateFilter.dispatchEvent(new Event('change'));

    expect(changes).toEqual([{
      pageId: 'work',
      queryContext: { filters: { 'work-state-label': ['Needs Review'] } }
    }]);
  });

  it('defaults Roadmap to a period-grouped mobile timeline with an explicit visual mode', () => {
    const rows = [
      { 'work-item-id': 'august', name: 'August item', 'lifecycle-state': 'active', 'started-at': '2026-08-30T09:00:00Z' },
      { 'work-item-id': 'september', name: 'September item', 'lifecycle-state': 'completed', 'started-at': '2026-09-02T09:00:00Z', 'ended-at': '2026-09-03T09:00:00Z' }
    ];
    const rendered = renderWorkProjectView(/** @type {any} */ ({
      pageId: 'work-roadmap',
      title: 'Roadmap',
      sources: workSources(rows),
      elementConfig: { body: 'roadmap' }
    }));

    expect([...rendered.querySelectorAll('.work-roadmap-period-heading')].map((heading) => heading.textContent)).toEqual([
      'August 2026', 'September 2026'
    ]);
    expect(rendered.querySelectorAll('.work-roadmap-mobile-meta')).toHaveLength(2);
    const visualToggle = /** @type {HTMLButtonElement} */ (rendered.querySelector('[aria-label="Show visual timeline"]'));
    visualToggle.click();
    expect(rendered.querySelector('.work-roadmap')?.classList.contains('work-roadmap-visual')).toBe(true);
    expect(visualToggle.getAttribute('aria-label')).toBe('Show list timeline');
    const period = rendered.querySelector('.work-roadmap-mobile-period');
    const initialPeriod = period?.textContent;
    /** @type {HTMLButtonElement} */ (rendered.querySelector('[aria-label="Next month"]')).click();
    expect(period?.textContent).not.toBe(initialPeriod);
  });
});
