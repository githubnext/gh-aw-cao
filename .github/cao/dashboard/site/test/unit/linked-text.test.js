// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderLinkedText, createEntityAwareCellRenderer } from '../../src/components/linked-text.js';

describe('linked text helpers', () => {
  it('renders plain text when no safe link is available and an anchor when a safe link exists', () => {
    expect(renderLinkedText('gh-aw-cao', null)).toBe('gh-aw-cao');

    const linked = /** @type {HTMLElement} */ (renderLinkedText('gh-aw-cao', {
      href: 'https://github.com/githubnext/gh-aw-cao',
      label: 'View githubnext/gh-aw-cao on GitHub'
    }));

    expect(linked).toBeInstanceOf(HTMLElement);
    expect(linked.getAttribute('href')).toBe('https://github.com/githubnext/gh-aw-cao');
    expect(linked.getAttribute('target')).toBe('_blank');
    expect(linked.getAttribute('rel')).toBe('noopener noreferrer');
    expect(linked.getAttribute('aria-label')).toBe('View githubnext/gh-aw-cao on GitHub');
    expect(linked.textContent).toBe('gh-aw-cao');
  });

  it('renders entity-aware linked table values only for mapped entity fields with safe links', () => {
    const renderEntityAwareCellValue = createEntityAwareCellRenderer(
      { organization: 'organization-link', repository: 'repository-link' },
      (row, field) => /** @type {{ href: string, label: string } | null} */ (row[field] ?? null),
      (display, value) => `${String(display ?? 'text')}:${String(value)}`,
      (value) => value == null ? 'unknown' : String(value)
    );

    const linkedRepository = /** @type {HTMLElement} */ (renderEntityAwareCellValue('repository', 'gh-aw-cao', {
      'repository-link': {
        href: 'https://github.com/githubnext/gh-aw-cao',
        label: 'View githubnext/gh-aw-cao on GitHub'
      }
    }));
    const plainStatus = renderEntityAwareCellValue('run-status', 'completed', {
      'repository-link': {
        href: 'https://github.com/githubnext/gh-aw-cao',
        label: 'View githubnext/gh-aw-cao on GitHub'
      }
    });
    const plainRepository = renderEntityAwareCellValue('repository', 'gh-aw-cao', {});

    expect(linkedRepository).toBeInstanceOf(HTMLElement);
    expect(linkedRepository.textContent).toBe('gh-aw-cao');
    expect(linkedRepository.getAttribute('href')).toBe('https://github.com/githubnext/gh-aw-cao');
    expect(plainStatus).toBe('text:completed');
    expect(plainRepository).toBe('text:gh-aw-cao');
  });
});
