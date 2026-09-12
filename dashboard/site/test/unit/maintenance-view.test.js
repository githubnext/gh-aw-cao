// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { renderUiElement } from '../../src/components/ui-elements.js';
import { setDeclaredCliActions } from '../../src/components/cli-actions.js';

const metadata = {
  'source-id': 'maintenance-fixture',
  'source-kind': 'fixture',
  'as-of': '2026-09-12T12:00:00Z',
  'retrieved-at': '2026-09-12T12:00:00Z',
  completeness: /** @type {'complete'} */ ('complete'),
  freshness: /** @type {'fresh'} */ ('fresh'),
  availability: /** @type {'available'} */ ('available')
};

afterEach(() => setDeclaredCliActions([]));

describe('maintenance view', () => {
  it('renders card lists and only shows item actions when maintenance is available', () => {
    setDeclaredCliActions([
      { id: 'update-repository', label: 'Update all', icon: 'sync', command: 'gh aw update --repo {{repository}}' },
      { id: 'upgrade-repository', label: 'Upgrade all', icon: 'download', command: 'gh aw upgrade --repo {{repository}}' },
      { id: 'update-package', label: 'Update package', icon: 'sync', command: 'gh aw update {{package}}', placement: 'row' },
      { id: 'upgrade-target-repository', label: 'Upgrade repository', icon: 'download', command: 'gh aw upgrade --repo {{repository}}', placement: 'row' }
    ], { templateValues: { repository: 'acme/control' }, canExecute: false });

    const rendered = renderUiElement('maintenance-view', {
      pageId: 'maintenance',
      title: 'gh-aw maintenance',
      description: 'Keep versions current.',
      sourceNames: ['packages', 'maintenance-repositories'],
      sources: {
        packages: {
          source: 'packages',
          metadata,
          rows: [
            { package: 'alpha', 'package-name': 'Alpha', 'package-version': 'v1', 'package-current-version': 'v2', 'package-update-state': 'update-available' },
            { package: 'beta', 'package-name': 'Beta', 'package-version': 'v2', 'package-current-version': 'v2', 'package-update-state': 'up-to-date' }
          ]
        },
        'maintenance-repositories': {
          source: 'maintenance-repositories',
          metadata,
          rows: [
            { repository: 'acme/old', 'gh-aw-version': 'v0.88.0', 'gh-aw-current-version': 'v0.89.0', 'gh-aw-update-state': 'update-available' },
            { repository: 'acme/current', 'gh-aw-version': 'v0.89.0', 'gh-aw-current-version': 'v0.89.0', 'gh-aw-update-state': 'up-to-date' }
          ]
        }
      },
      contextDetails: [],
      headingTag: 'h2'
    });

    expect(rendered).not.toBeNull();
    expect(rendered?.querySelectorAll('.maintenance-card-list')).toHaveLength(2);
    expect(rendered?.querySelectorAll('.maintenance-card')).toHaveLength(4);
    expect(rendered?.querySelectorAll('button[aria-label="Update package"]')).toHaveLength(1);
    expect(rendered?.querySelectorAll('button[aria-label="Upgrade repository"]')).toHaveLength(1);
    expect(rendered?.textContent).toContain('Update all');
    expect(rendered?.textContent).toContain('Upgrade all');
    expect(rendered?.textContent).toContain('Upgrade recommended');
    expect(rendered?.textContent).not.toContain('update-available');
  });
});
