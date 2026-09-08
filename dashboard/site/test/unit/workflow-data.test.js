import { describe, expect, it } from 'vitest';
import { deriveWorkflowSources } from '../../src/workflow-data.js';

const metadata = {
  'source-id': 'workflow-fixture',
  'source-kind': 'fixture',
  'as-of': '2026-09-01T00:00:00Z',
  'retrieved-at': '2026-09-01T00:01:00Z',
  completeness: /** @type {'complete'} */ ('complete'),
  freshness: /** @type {'fresh'} */ ('fresh'),
  availability: /** @type {'available'} */ ('available')
};

describe('deriveWorkflowSources', () => {
  it('emits summary, packaged, and standalone rows for declarative topology views', () => {
    const sources = deriveWorkflowSources({
      workflows: {
        source: 'workflows',
        metadata,
        rows: [
          workflow({ workflow: 'worker.md', 'workflow-name': 'Worker', 'workflow-role': 'worker' }),
          workflow({ workflow: 'root.md', 'workflow-name': 'Root', 'workflow-role': 'orchestrator' }),
          workflow({
            package: undefined,
            'package-name': undefined,
            repository: 'target',
            workflow: 'local.md',
            'workflow-name': 'Local',
            'workflow-role': 'standalone'
          })
        ]
      }
    });

    expect(sources['workflow-topology-summary'].rows).toEqual([
      { label: 'Packages', value: '1' },
      { label: 'Package workflows', value: '2' },
      { label: 'Standalone workflows', value: '1' }
    ]);
    expect(sources['packaged-workflows'].rows.map((row) => row['workflow-role'])).toEqual(['orchestrator', 'worker']);
    expect(sources['packaged-workflows'].rows[0]).toEqual(expect.objectContaining({
      'package-name': 'Dependabot',
      repository: 'githubnext/control',
      workflow: 'root.md'
    }));
    expect(sources['packaged-workflows'].rows[0]['package-link']).toEqual(expect.objectContaining({
      'dashboard-href': '#page-package-insights?package=dependabot'
    }));
    expect(sources['standalone-workflows'].rows).toEqual([
      expect.objectContaining({ repository: 'githubnext/target', workflow: 'local.md' })
    ]);
    expect(sources['packaged-workflows'].metadata).toBe(metadata);
    expect(sources['workflow-inventory'].rows).toHaveLength(3);
    expect(sources['package-inventory'].rows).toEqual([
      expect.objectContaining({
        'package-name': 'Dependabot',
        workflows: 2,
        repositories: 1,
        roles: 'orchestrator, worker'
      })
    ]);
  });

  it('still surfaces repository-owned rows whose workflow-role is missing or unrecognized', () => {
    const sources = deriveWorkflowSources({
      workflows: {
        source: 'workflows',
        metadata,
        rows: [
          workflow({
            package: undefined,
            'package-name': undefined,
            repository: 'target',
            workflow: 'unknown-role.md',
            'workflow-name': 'Unknown Role',
            'workflow-role': 'unknown'
          }),
          workflow({
            package: undefined,
            'package-name': undefined,
            repository: 'target',
            workflow: 'no-role.md',
            'workflow-name': 'No Role'
          })
        ]
      }
    });

    expect(sources['standalone-workflows'].rows.map((row) => row.workflow)).toEqual(
      expect.arrayContaining(['unknown-role.md', 'no-role.md'])
    );
    expect(sources['packaged-workflows'].rows).toEqual([]);
  });

  it('attributes measured AIC to exactly matched packaged and standalone workflows', () => {
    const packaged = workflow({ workflow: 'root.md', 'workflow-role': 'orchestrator' });
    const standalone = workflow({
      package: undefined,
      'package-name': undefined,
      repository: 'target',
      workflow: 'local.md',
      'workflow-role': 'standalone'
    });
    const sources = deriveWorkflowSources({
      workflows: {
        source: 'workflows',
        metadata,
        rows: [packaged, standalone]
      },
      usage: {
        source: 'usage',
        metadata,
        rows: [
          { organization: 'githubnext', repository: 'control', workflow: 'root.md', aic: 4.5 },
          { organization: 'githubnext', repository: 'control', workflow: 'root.md', aic: 5.5 },
          { organization: 'githubnext', repository: 'target', workflow: 'local.md', aic: 3 }
        ]
      },
      runs: {
        source: 'runs',
        metadata,
        rows: [
          { organization: 'githubnext', repository: 'control', workflow: 'root.md', run: '1' },
          { organization: 'githubnext', repository: 'control', workflow: 'root.md', run: '2' },
          { organization: 'githubnext', repository: 'target', workflow: 'local.md', run: '3' }
        ]
      }
    });

    expect(sources['packaged-workflows'].rows[0].runs).toBe(2);
    expect(sources['packaged-workflows'].rows[0].aic).toBe(10);
    expect(sources['standalone-workflows'].rows[0].runs).toBe(1);
    expect(sources['standalone-workflows'].rows[0].aic).toBe(3);
  });

  it('summarizes run metadata with a dashboard link to the Runs table', () => {
    const runLink = {
      relation: 'run',
      href: 'https://github.com/githubnext/control/actions/runs/1',
      label: 'View run 1'
    };
    const sources = deriveWorkflowSources({
      runs: {
        source: 'runs',
        metadata,
        rows: [
          { run: '1', engine: 'copilot', 'engine-version': '0.87.6', 'requested-model': 'gpt-5', 'resolved-model': 'gpt-5', 'run-conclusion': 'success', 'run-link': runLink },
          { run: '2', engine: 'copilot', 'engine-version': '0.87.6', 'requested-model': 'gpt-5', 'resolved-model': 'gpt-5', 'run-conclusion': 'success' },
          { run: '3', engine: 'pi', 'engine-version': '1.2.0', 'requested-model': 'claude', 'resolved-model': 'claude', 'run-conclusion': 'failure' }
        ]
      }
    });

    expect(sources['run-aggregate-summary'].rows).toEqual([
      expect.objectContaining({
        engine: 'copilot',
        'run-conclusion': 'success',
        runs: 2,
        'run-link': expect.objectContaining({
          'dashboard-href': '#page-runs',
          'dashboard-label': 'View runs table'
        })
      }),
      expect.objectContaining({ engine: 'pi', 'run-conclusion': 'failure', runs: 1 })
    ]);
    expect(sources['run-aggregate-summary'].metadata).toBe(metadata);
  });

  it('does not attribute unscoped usage when a workflow identity is ambiguous', () => {
    const sources = deriveWorkflowSources({
      workflows: {
        source: 'workflows',
        metadata,
        rows: [
          workflow({ repository: 'control', workflow: 'shared.md' }),
          workflow({ repository: 'target', workflow: 'shared.md' })
        ]
      },
      usage: {
        source: 'usage',
        metadata,
        rows: [{ workflow: 'shared.md', aic: 10 }]
      }
    });

    expect(sources['packaged-workflows'].rows.every((row) => row.aic === undefined)).toBe(true);
  });

  it('does not present a bare organization as a qualified repository', () => {
    const sources = deriveWorkflowSources({
      workflows: {
        source: 'workflows',
        metadata,
        rows: [workflow({
          package: undefined,
          'package-name': undefined,
          repository: '',
          workflow: 'local.md',
          'workflow-name': 'Local',
          'workflow-role': 'standalone'
        })]
      }
    });

    expect(sources['standalone-workflows'].rows[0].repository).toBe('unknown');
  });

  it('omits report rows without a known runtime repository', () => {
    const sources = deriveWorkflowSources({
      outcomes: {
        source: 'outcomes',
        metadata,
        rows: [{ 'runtime-repository': 'unknown', workflow: '.github/workflows/dependabot.md' }]
      }
    });

    expect(sources['workflow-reports'].rows).toEqual([]);
  });

  it('emits route-keyed report rows with dashboard detail links', () => {
    const sources = deriveWorkflowSources({
      outcomes: {
        source: 'outcomes',
        metadata,
        rows: [
          {
            organization: 'githubnext',
            repository: 'control',
            workflow: '.github/workflows/dependabot.md',
            'safe-output': 'issue-2',
            'outcome-title': 'Newer report',
            'outcome-status': 'open',
            'rollout-mode': 'review',
            'outcome-category': 'issue',
            'observed-at': '2026-09-01T00:00:00Z',
            'issue-link': {
              relation: 'issue',
              href: 'https://github.com/githubnext/control/issues/2',
              label: 'View issue 2'
            },
            'external-link': {
              relation: 'external',
              href: 'https://example.com/report',
              label: 'View external report'
            }
          },
          {
            repository: 'target',
            'runtime-repository': 'githubnext/control',
            workflow: '.github/workflows/dependabot.md',
            'safe-output': 'issue-1',
            'outcome-title': 'Older report',
            'outcome-state': 'accepted',
            'published-at': '2026-08-31T00:00:00Z',
            'run-link': {
              relation: 'run',
              href: 'https://github.com/githubnext/control/actions/runs/1',
              label: 'View run 1'
            }
          }
        ]
      }
    });

    expect(sources['workflow-reports'].rows.map((row) => row['outcome-title'])).toEqual([
      'Newer report',
      'Older report'
    ]);
    expect(sources['workflow-reports'].rows[0]).toEqual(expect.objectContaining({
      'workflow-route': 'githubnext/control:.github/workflows/dependabot.md',
      'outcome-status': 'open',
      'rollout-mode': 'review'
    }));
    expect(sources['workflow-reports'].rows[0]['external-link']).toEqual(expect.objectContaining({
      href: 'https://github.com/githubnext/control/issues/2',
      relation: 'external',
      'dashboard-href': '#page-outcome-detail?outcome=issue-2'
    }));
    expect(sources['workflow-reports'].metadata).toBe(metadata);
  });

  it('emits route-keyed workflow runs ordered newest first', () => {
    const sources = deriveWorkflowSources({
      runs: {
        source: 'runs',
        metadata,
        rows: [
          {
            organization: 'githubnext',
            repository: 'control',
            workflow: '.github/workflows/dependabot.md',
            run: '41',
            'run-title': 'Older run',
            'started-at': '2026-08-31T00:00:00Z',
            'run-link': {
              relation: 'run',
              href: 'https://github.com/githubnext/control/actions/runs/41',
              label: 'View run 41'
            }
          },
          {
            organization: 'githubnext',
            repository: 'control',
            workflow: '.github/workflows/dependabot.md',
            run: '42',
            'run-title': 'Newer run',
            'started-at': '2026-09-01T00:00:00Z'
          },
          {
            repository: '',
            workflow: '.github/workflows/dependabot.md',
            run: '43'
          }
        ]
      }
    });

    expect(sources['workflow-runs'].rows.map((row) => row.run)).toEqual(['42', '41']);
    expect(sources['workflow-runs'].rows[0]['workflow-route']).toBe(
      'githubnext/control:.github/workflows/dependabot.md'
    );
    expect(sources['workflow-runs'].rows[1]['run-link']).toEqual(expect.objectContaining({
      href: 'https://github.com/githubnext/control/actions/runs/41'
    }));
    expect(sources['workflow-runs'].metadata).toBe(metadata);
  });

  it('emits package-keyed report rows using explicit and workflow-derived attribution', () => {
    const sources = deriveWorkflowSources({
      workflows: {
        source: 'workflows',
        metadata,
        rows: [workflow({
          workflow: '.github/workflows/dependabot.md',
          'workflow-name': 'Dependabot'
        })]
      },
      outcomes: {
        source: 'outcomes',
        metadata,
        rows: [
          {
            package: 'ambient-context',
            'safe-output': 'issue-2',
            'outcome-title': 'Explicit package report',
            'observed-at': '2026-09-01T00:00:00Z'
          },
          {
            organization: 'githubnext',
            repository: 'control',
            workflow: '.github/workflows/dependabot.lock.yml',
            'safe-output': 'issue-1',
            'outcome-title': 'Derived package report',
            'observed-at': '2026-08-31T00:00:00Z'
          },
          {
            workflow: '.github/workflows/unknown.md',
            'outcome-title': 'Unattributed report'
          }
        ]
      }
    });

    expect(sources['package-reports'].rows).toEqual([
      expect.objectContaining({ package: 'ambient-context', 'outcome-title': 'Explicit package report' }),
      expect.objectContaining({ package: 'dependabot', 'outcome-title': 'Derived package report' })
    ]);
    expect(sources['package-reports'].metadata).toBe(metadata);
  });
});

/** @param {Record<string, unknown>} overrides */
function workflow(overrides) {
  return {
    organization: 'githubnext',
    repository: 'control',
    package: 'dependabot',
    'package-name': 'Dependabot',
    'workflow-active': 'true',
    'rollout-mode': 'review',
    'repository-link': {
      relation: 'repository',
      href: 'https://github.com/githubnext/control',
      label: 'View control'
    },
    'workflow-link': {
      relation: 'workflow',
      href: `https://github.com/githubnext/control/blob/HEAD/${String(overrides.workflow)}`,
      label: `View ${String(overrides['workflow-name'])}`
    },
    ...overrides
  };
}
