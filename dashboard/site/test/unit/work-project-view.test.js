// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderWorkItemCard } from '../../src/components/work-item-card.js';
import { renderWorkItemRow } from '../../src/components/work-item-row.js';
import { renderWorkItemTimelineLane } from '../../src/components/work-item-timeline-lane.js';

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
});
