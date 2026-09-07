// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { createWorkProjectView, defaultWorkViewComposition, workViewCompositionForBody } from '../../src/components/work-view-primitives.js';
import { renderWorkItemCard } from '../../src/components/work-item-card.js';
import { renderWorkItemRow } from '../../src/components/work-item-row.js';
import { renderWorkItemTimelineLane } from '../../src/components/work-item-timeline-lane.js';
import { renderWorkViewSection } from '../../src/components/work-view-sections.js';

const item = {
  name: 'Dependabot release train',
  icon: 'dependabot',
  repository: 'github/gh-aw',
  owner: 'dependency-automation',
  started: '2026-08-30T09:00:00Z',
  startedLabel: 'Aug 30, 2026, 9:00 AM',
  stoppedLabel: 'Aug 30, 2026, 9:30 AM',
  durationLabel: '30m',
  state: 'active',
  stateLabel: 'Active',
  startTime: Date.parse('2026-08-30T09:00:00Z'),
  stopTime: Date.parse('2026-08-30T09:30:00Z'),
  evidenceLink: {
    relation: 'evidence',
    href: 'https://example.com/evidence/dependabot',
    label: 'Dependabot evidence'
  }
};

describe('work project view primitives', () => {
  it('defines reusable work view compositions and declarative element views', () => {
    expect(workViewCompositionForBody('board')).toEqual({ key: 'board', className: 'work-board', title: 'Board', landmarkLabel: 'Board' });
    expect(workViewCompositionForBody('tasks')).toEqual({ key: 'tasks', className: 'work-tasks', title: 'Tasks', landmarkLabel: 'Tasks' });
    expect(workViewCompositionForBody('roadmap')).toEqual({ key: 'roadmap', className: 'work-roadmap', title: 'Roadmap', landmarkLabel: 'Roadmap' });
    expect(workViewCompositionForBody('unknown')).toEqual({ key: 'board', className: 'work-board', title: 'Board', landmarkLabel: 'Board' });
    expect(defaultWorkViewComposition()).toEqual([
      { key: 'board', className: 'work-board', title: 'Board', landmarkLabel: 'Board' },
      { key: 'tasks', className: 'work-tasks', title: 'Tasks', landmarkLabel: 'Tasks' },
      { key: 'roadmap', className: 'work-roadmap', title: 'Roadmap', landmarkLabel: 'Roadmap' }
    ]);
    expect(createWorkProjectView({
      id: 'work-layouts',
      title: 'Work layouts',
      description: 'Reusable work sections.',
      sources: ['work-items'],
      sections: ['board', 'tasks'],
      layout: 'full'
    })).toEqual({
      id: 'work-layouts',
      title: 'Work layouts',
      description: 'Reusable work sections.',
      data: { sources: ['work-items'] },
      mark: 'element',
      element: 'work-project-view',
      config: { sections: ['board', 'tasks'] },
      layout: 'full'
    });
  });

  it('renders reusable work cards independently of the work page', () => {
    const rendered = renderWorkItemCard(item);
    expect(rendered.className).toBe('work-card');
    expect(rendered.getAttribute('data-work-state')).toBe('active');
    expect(rendered.textContent).toContain('Dependabot release train');
    expect(rendered.textContent).toContain('dependency-automation');
  });

  it('renders reusable work rows independently of the work page', () => {
    const rendered = renderWorkItemRow(item);
    expect(rendered.className).toBe('work-task-row');
    expect(rendered.getAttribute('role')).toBe('listitem');
    expect(rendered.textContent).toContain('github/gh-aw');
    expect(rendered.querySelector('time')?.getAttribute('dateTime')).toBe('2026-08-30T09:00:00Z');
  });

  it('renders reusable work timeline lanes independently of the work page', () => {
    const rendered = renderWorkItemTimelineLane(item, {
      start: item.startTime,
      duration: 30 * 60 * 1000
    });
    expect(rendered.className).toBe('work-roadmap-lane');
    expect(rendered.querySelector('.work-roadmap-bar')?.getAttribute('style')).toContain('--work-start: 0.00%');
    expect(rendered.textContent).toContain('Aug 30, 2026, 9:00 AM');
  });

  it('renders reusable work sections by declarative composition key', () => {
    const board = renderWorkViewSection('board', [item], {
      id: 'work-board',
      className: 'work-board',
      landmarkLabel: 'Board',
      title: 'Board'
    });
    expect(board?.querySelector('.work-board-column')).not.toBeNull();

    const tasks = renderWorkViewSection('tasks', [item], {
      id: 'work-tasks',
      className: 'work-tasks',
      landmarkLabel: 'Tasks',
      title: 'Tasks'
    });
    expect(tasks?.querySelector('.work-task-row')).not.toBeNull();

    const roadmap = renderWorkViewSection('roadmap', [item], {
      id: 'work-roadmap',
      className: 'work-roadmap',
      landmarkLabel: 'Roadmap',
      title: 'Roadmap'
    });
    expect(roadmap?.querySelector('.work-roadmap-lane')).not.toBeNull();
  });
});
