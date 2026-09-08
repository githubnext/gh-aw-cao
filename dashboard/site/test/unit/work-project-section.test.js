// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { createWorkSectionCompositionRenderer, workSectionId } from '../../src/components/work-project-section.js';

describe('work project section composition', () => {
  it('derives stable section ids from the hosting page id', () => {
    expect(workSectionId('work-roadmap', 'roadmap')).toBe('work-roadmap-roadmap');
  });

  it('renders declarative section composition with shared section metadata', () => {
    const renderSections = createWorkSectionCompositionRenderer({
      board: (items, section) => {
        const element = document.createElement('section');
        element.className = section.className;
        element.id = section.id;
        element.setAttribute('aria-label', section.landmarkLabel);
        element.textContent = `${section.title}:${items.length}`;
        return element;
      },
      tasks: (items, section) => {
        const element = document.createElement('section');
        element.className = section.className;
        element.id = section.id;
        element.setAttribute('aria-label', section.landmarkLabel);
        element.textContent = `${section.title}:${items.length}`;
        return element;
      },
      roadmap: (items, section) => {
        const element = document.createElement('section');
        element.className = section.className;
        element.id = section.id;
        element.setAttribute('aria-label', section.landmarkLabel);
        element.textContent = `${section.title}:${items.length}`;
        return element;
      }
    });

    const rendered = renderSections(
      [{ id: 'one' }, { id: 'two' }],
      [
        { key: 'tasks', className: 'work-tasks', landmarkLabel: 'Tasks', title: 'Tasks' },
        { key: 'roadmap', className: 'work-roadmap', landmarkLabel: 'Roadmap', title: 'Roadmap' }
      ],
      'work-custom',
      () => {}
    );

    expect(rendered.map((element) => ({
      id: element.id,
      className: element.className,
      label: element.getAttribute('aria-label'),
      text: element.textContent
    }))).toEqual([
      {
        id: 'work-custom-tasks',
        className: 'work-tasks',
        label: 'Tasks',
        text: 'Tasks:2'
      },
      {
        id: 'work-custom-roadmap',
        className: 'work-roadmap',
        label: 'Roadmap',
        text: 'Roadmap:2'
      }
    ]);
  });
});
