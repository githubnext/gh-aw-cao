// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { externalAnchorAttrs, findFirstLink, findLink, renderExternalLink, renderExternalLinkOrFallback, renderLinkedValue, renderOutcomeLink, renderSafeLink, renderWorkflowRunLink, resolveTitleLink } from '../../src/components/link-content.js';

describe('link content helpers', () => {
  it('renderSafeLink renders a plain-text fallback and an internal or external anchor', () => {
    expect(renderSafeLink('Summary', null)).toBe('Summary');

    const internal = /** @type {HTMLElement} */ (renderSafeLink('Detail', {
      href: '#page-workflow-detail?workflow=demo',
      label: 'Open workflow detail'
    }));
    expect(internal.getAttribute('target')).toBeNull();
    expect(internal.getAttribute('rel')).toBeNull();
    expect(internal.getAttribute('aria-label')).toBe('Open workflow detail');

    const external = /** @type {HTMLElement} */ (renderSafeLink('Run 4', {
      href: 'https://example.com/run/4',
      label: 'Run 4'
    }));
    expect(external.getAttribute('target')).toBe('_blank');
    expect(external.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('DLS-SAFE-004 finds only safe https links with non-empty labels', () => {
    expect(findLink({ link: { href: 'https://example.com/run/4', label: 'Run 4' } }, 'link')).toEqual({
      href: 'https://example.com/run/4',
      label: 'Run 4'
    });
    expect(findLink({ link: { href: 'https://user:secret@example.com/run/1', label: 'Credentialed Run' } }, 'link')).toBeNull();
    expect(findLink({ link: { href: 'ftp://example.com/run/2', label: 'FTP Run' } }, 'link')).toBeNull();
    expect(findLink({ link: { href: 'https://example.com/run/3', label: '   ' } }, 'link')).toBeNull();
    expect(findLink({ link: 'https://example.com/run/4' }, 'link')).toBeNull();
  });

  it('DLS-SAFE-004 returns the first available safe link from a row collection', () => {
    const link = findFirstLink([
      { link: { href: 'ftp://example.com/run/2', label: 'FTP Run' } },
      { link: { href: 'https://example.com/run/4', label: 'Run 4' } },
      { link: { href: 'https://example.com/run/5', label: 'Run 5' } }
    ], 'link');

    expect(link).toEqual({ href: 'https://example.com/run/4', label: 'Run 4' });
  });

  it('uses a presentation-only dashboard route while retaining the external repository href', () => {
    const link = findLink({
      'repository-link': {
        href: 'https://github.com/octo-org/platform',
        label: 'View octo-org/platform on GitHub',
        'dashboard-href': '#page-repository-detail?repository=octo-org%2Fplatform',
        'dashboard-label': 'View octo-org/platform repository dashboard'
      }
    }, 'repository-link');

    expect(link).toEqual({
      href: '#page-repository-detail?repository=octo-org%2Fplatform',
      label: 'View octo-org/platform repository dashboard',
      externalHref: 'https://github.com/octo-org/platform'
    });
    const anchor = renderExternalLink(/** @type {NonNullable<typeof link>} */ (link));
    expect(anchor.getAttribute('target')).toBeNull();
    expect(anchor.getAttribute('rel')).toBeNull();
    expect(anchor.querySelector('.octicon-external-link')).toBeNull();
  });

  it('uses a presentation-only dashboard route when no external target is available', () => {
    expect(findLink({
      'package-link': {
        'dashboard-href': '#page-package-insights?package=aw-doctor',
        'dashboard-label': 'View AW Doctor package dashboard'
      }
    }, 'package-link')).toEqual({
      href: '#page-package-insights?package=aw-doctor',
      label: 'View AW Doctor package dashboard'
    });
  });

  it('DLS-SAFE-010 renders labeled external links and optional linked value content', () => {
    const link = { href: 'https://example.com/run/4', label: 'Run 4' };
    const anchor = renderExternalLink(link);
    const linkedValue = /** @type {HTMLElement} */ (renderLinkedValue('Summary', link));
    const plainValue = renderLinkedValue('Summary', null);

    expect(anchor.getAttribute('href')).toBe('https://example.com/run/4');
    expect(anchor.getAttribute('target')).toBe('_blank');
    expect(anchor.getAttribute('rel')).toBe('noopener noreferrer');
    expect(anchor.getAttribute('aria-label')).toBe('Run 4');
    expect(anchor.textContent).toContain('Run 4');
    expect(linkedValue).toBeInstanceOf(HTMLElement);
    expect(linkedValue.textContent).toBe('Summary');
    expect(linkedValue.getAttribute('href')).toBe('https://example.com/run/4');
    expect(linkedValue.getAttribute('aria-label')).toBe('Run 4');
    expect(plainValue).toBe('Summary');
  });

  it('builds shared external anchor attributes for raw href/label pairs', () => {
    const attrs = externalAnchorAttrs('https://github.com/octo-org/platform', 'View source');

    expect(attrs).toEqual({
      href: 'https://github.com/octo-org/platform',
      target: '_blank',
      rel: 'noopener noreferrer',
      'aria-label': 'View source'
    });
  });

  it('renders workflow run labels as safe external links with a plain-text fallback', () => {    const linked = /** @type {HTMLElement} */ (renderWorkflowRunLink({
      'run-link': {
        href: 'https://github.com/githubnext/gh-aw-cao/actions/runs/42',
        label: 'Run 42'
      }
    }, '42'));

    expect(linked.getAttribute('href')).toBe('https://github.com/githubnext/gh-aw-cao/actions/runs/42');
    expect(linked.getAttribute('target')).toBe('_blank');
    expect(linked.getAttribute('rel')).toBe('noopener noreferrer');
    expect(linked.getAttribute('aria-label')).toBe('Run 42');
    expect(linked.textContent).toBe('42');
    expect(renderWorkflowRunLink({}, 'Unavailable')).toBe('Unavailable');
  });

  it('resolves a JSON-configured compact title link for issue and run identifiers', () => {
    const row = {
      run: '42',
      'run-link': {
        href: 'https://github.com/githubnext/gh-aw-cao/actions/runs/42',
        label: 'Run 42'
      }
    };
    expect(resolveTitleLink(row, {
      'href-field': 'run-link',
      'identifier-field': 'run'
    })).toEqual({
      href: 'https://github.com/githubnext/gh-aw-cao/actions/runs/42',
      label: '#42'
    });
    expect(resolveTitleLink(row, {
      'href-field': 'run-link',
      'identifier-field': 'missing'
    })).toBeNull();
  });

  it('renders durable-output titles as encoded dashboard links with a plain-text fallback', () => {
    const linked = /** @type {HTMLElement} */ (renderOutcomeLink({ 'safe-output': 'issue/42' }, 'Issue 42'));

    expect(linked.getAttribute('href')).toBe('#page-outcome-detail?outcome=issue%2F42');
    expect(linked.textContent).toBe('Issue 42');
    expect(renderOutcomeLink({}, 'Unavailable')).toBe('Unavailable');
  });

  it('renderExternalLinkOrFallback renders a labeled external link or falls back when no link exists', () => {
    const link = { href: 'https://example.com/run/4', label: 'Run 4' };

    const withOverride = /** @type {HTMLElement} */ (renderExternalLinkOrFallback(link, 'View run'));
    expect(withOverride.getAttribute('aria-label')).toBe('View run');
    expect(withOverride.textContent).toContain('View run');

    const withoutOverride = /** @type {HTMLElement} */ (renderExternalLinkOrFallback(link));
    expect(withoutOverride.getAttribute('aria-label')).toBe('Run 4');

    expect(renderExternalLinkOrFallback(null, 'View run', 'Unavailable')).toBe('Unavailable');
    expect(renderExternalLinkOrFallback(null)).toBeNull();
  });
});
