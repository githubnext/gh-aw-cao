// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { processDataRequest } from '../../src/data-worker.js';

const fixtureDirectory = dirname(fileURLToPath(import.meta.url));
const authoritativeDashboard = JSON.parse(
  readFileSync(resolve(fixtureDirectory, '../../dashboard.json'), 'utf8')
);

const metadata = {
  'source-id': 'runtime-fixture',
  'source-kind': 'fixture',
  'as-of': '2026-08-30T12:00:00Z',
  'retrieved-at': '2026-08-30T12:01:00Z',
  completeness: /** @type {'complete'} */ ('complete'),
  freshness: /** @type {'fresh'} */ ('fresh'),
  availability: /** @type {'available'} */ ('available')
};

describe('Runtime dashboard view', () => {
  it('keeps Runtime as one full-view lazy execution table', () => {
    const runtimePage = authoritativeDashboard.dashboard.pages.find(
      (/** @type {{ id: string }} */ page) => page.id === 'runtime'
    );

    expect(runtimePage).toMatchObject({
      id: 'runtime',
      kind: 'custom',
      title: 'Runtime & episodes'
    });
    expect(runtimePage.sections).toBeUndefined();
    expect(runtimePage.views).toEqual([
      expect.objectContaining({
        id: 'runtime-execution-episodes',
        mark: 'table',
        controls: 'interactive',
        'lazy-list': true,
        layout: 'full-view'
      })
    ]);
  });

  it('materializes root runtime episodes through the declarative worker query', () => {
    const result = /** @type {Record<string, import('../../src/presenter.js').LogicalSourceInput>} */ (processDataRequest({
      operation: 'execute-dashboard-queries',
      queries: authoritativeDashboard.dashboard.queries,
      sourceNames: ['runtime-episodes'],
      sources: {
        workflows: {
          source: 'workflows',
          rows: [
            { organization: 'githubnext', repository: 'gh-aw-cao', campaign: 'dependabot', 'campaign-name': 'Dependabot', workflow: '.github/workflows/dependabot.md', 'workflow-name': 'Dependabot', 'workflow-role': 'orchestrator' },
            { organization: 'githubnext', repository: 'gh-aw-cao', campaign: 'dependabot', 'campaign-name': 'Dependabot', workflow: '.github/workflows/dependabot-worker.md', 'workflow-name': 'Dependabot worker', 'workflow-role': 'worker' }
          ],
          metadata
        },
        runs: {
          source: 'runs',
          rows: [
            { organization: 'githubnext', repository: 'gh-aw-cao', workflow: '.github/workflows/dependabot.md', run: '10', 'run-title': 'Dependabot review', 'started-at': '2026-08-30T10:00:00Z', duration: 300, 'run-status': 'completed', 'run-conclusion': 'action-required' },
            { organization: 'githubnext', repository: 'gh-aw-cao', workflow: '.github/workflows/dependabot-worker.md', run: '11', 'run-title': 'Update train', 'started-at': '2026-08-30T10:01:00Z', duration: 180, 'run-status': 'completed', 'run-conclusion': 'failure' }
          ],
          metadata
        }
      }
    }));

    expect(result['runtime-episodes'].rows).toEqual([
      expect.objectContaining({
        run: '10',
        campaign: 'Dependabot',
        workflow: 'Dependabot',
        status: 'action-required',
        attribution: 'Root only'
      })
    ]);
  });
});
