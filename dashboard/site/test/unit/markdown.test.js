// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderMarkdownElement } from '../../src/components/markdown.js';

/** @type {import('../../src/presenter.js').SourceMetadata} */
const metadata = {
  'source-id': 'records',
  'source-kind': 'query',
  availability: 'available',
  completeness: 'complete',
  freshness: 'fresh',
  provenance: [],
  'as-of': '2026-09-25T00:00:00Z',
  'retrieved-at': '2026-09-25T00:00:00Z'
};

/**
 * @param {Array<Record<string, unknown>>} rows
 * @param {Record<string, string>} [config]
 * @returns {import('../../src/components/ui-elements.js').ElementRenderContext}
 */
function context(rows, config = {}) {
  return {
    pageId: 'detail',
    title: 'README',
    sourceNames: ['records'],
    sources: { records: { source: 'records', metadata, rows } },
    contextDetails: [],
    elementConfig: { 'content-field': 'readme', ...config },
    headingTag: 'h3'
  };
}

describe('generic markdown element', () => {
  it('renders headings, lists, tables, and safe repository-relative links', () => {
    const rendered = renderMarkdownElement(context([{
      readme: '# Example\n\nSee the [guide](docs/guide.md).\n\n- One\n- Two\n\n| Item | State |\n| --- | --- |\n| Check | Ready |',
      path: 'campaign/README.md',
      'repository-link': { href: 'https://ghe.example/owner/repository', label: 'Repository' }
    }], {
      'path-field': 'path',
      'base-link-field': 'repository-link'
    }));

    expect(rendered.classList.contains('dashboard-markdown')).toBe(true);
    expect(rendered.querySelector('h1')?.textContent).toBe('Example');
    expect(rendered.querySelectorAll('li')).toHaveLength(2);
    expect(rendered.querySelector('tbody td')?.textContent).toBe('Check');
    expect(rendered.querySelector('a')?.href).toBe('https://ghe.example/owner/repository/blob/HEAD/campaign/docs/guide.md');
  });

  it('drops unsafe links and renders an explicit empty state', () => {
    const rendered = renderMarkdownElement(context([{
      readme: '[unsafe](javascript:alert(1)) [escape](../../../../outside)',
      path: 'campaign/README.md',
      'repository-link': { href: 'https://github.com/owner/repository', label: 'Repository' }
    }], {
      'path-field': 'path',
      'base-link-field': 'repository-link'
    }));
    expect(rendered.querySelector('a')).toBeNull();
    expect(rendered.textContent).toContain('unsafe');

    const empty = renderMarkdownElement(context([], { 'empty-message': 'README unavailable.' }));
    expect(empty.textContent).toBe('README unavailable.');
  });

  it('renders every GFM alert type with its title, icon, and block content', () => {
    const rendered = renderMarkdownElement(context([{
      readme: [
        '> [!NOTE]',
        '> A **note**.',
        '',
        '> [!TIP]',
        '> A tip.',
        '',
        '> [!IMPORTANT]',
        '> Important context.',
        '',
        '> [!WARNING]',
        '> First paragraph.',
        '>',
        '> Second paragraph.',
        '',
        '> [!CAUTION]',
        '> Take care.'
      ].join('\n')
    }]));

    const alerts = [...rendered.querySelectorAll('.markdown-alert')];
    expect(alerts.map((alert) => alert.className)).toEqual([
      'markdown-alert markdown-alert-note',
      'markdown-alert markdown-alert-tip',
      'markdown-alert markdown-alert-important',
      'markdown-alert markdown-alert-warning',
      'markdown-alert markdown-alert-caution'
    ]);
    expect(alerts.map((alert) => alert.querySelector('.markdown-alert-title')?.textContent)).toEqual([
      'Note',
      'Tip',
      'Important',
      'Warning',
      'Caution'
    ]);
    expect(alerts.map((alert) => alert.querySelector('.markdown-alert-title .octicon')?.getAttribute('aria-hidden')))
      .toEqual(['true', 'true', 'true', 'true', 'true']);
    expect(alerts[0].querySelector('strong')?.textContent).toBe('note');
    expect(alerts[3].querySelectorAll(':scope > p')).toHaveLength(3);
  });
});
