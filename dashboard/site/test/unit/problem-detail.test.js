import { describe, expect, it, vi } from 'vitest';
import { renderProblemDetail } from '../../src/components/problem-detail.js';

const metadata = {
  'source-id': 'campaign-problem-items-fixture',
  'source-kind': 'fixture',
  'as-of': '2026-09-24T18:00:00Z',
  'retrieved-at': '2026-09-24T18:00:00Z',
  completeness: /** @type {'complete'} */ ('complete'),
  freshness: /** @type {'fresh'} */ ('fresh'),
  availability: /** @type {'available'} */ ('available')
};

function context(rows = [problem()]) {
  return {
    pageId: 'campaign-problem-detail',
    title: 'Problem',
    sourceNames: ['campaign-problem-items'],
    contextDetails: [],
    routeParameter: 'target-repository',
    headingTag: /** @type {'h3'} */ ('h3'),
    sources: {
      'campaign-problem-items': {
        source: 'campaign-problem-items',
        metadata,
        rows
      }
    }
  };
}

function problem() {
  return {
    campaign: 'dependabot',
    'campaign-name': 'Dependabot',
    workflow: '.github/workflows/dependabot.md',
    'workflow-name': 'Dependabot / Update Planner',
    'workflow-role': 'orchestrator',
    'runtime-repository': 'github/gh-aw',
    'target-repository': 'github/gh-aw',
    'rollout-mode': 'live',
    'problem-kind': 'failure',
    'problem-title': 'Dependency update failed',
    'failure-count': 4,
    'occurrence-count': 65,
    status: 'failed',
    'status-detail': 'Workflow failed',
    'failure-message': 'The dependency update command exited with status 1.',
    'error-signature': 'dependency-update-failed',
    'failure-job': 'update',
    'failure-step': 'Apply update',
    'failure-log': '2026-09-24T10:01:00Z ##[error]dependency update failed',
    'gh-aw-version': '0.89.20',
    engine: 'copilot',
    'engine-version': '1.2.3',
    'requested-model': 'model-a',
    'resolved-model': 'model-b',
    'started-at': '2026-09-24T10:00:00Z',
    'run-link': {
      relation: 'run',
      href: 'https://github.com/github/gh-aw/actions/runs/1',
      label: 'View run'
    },
    'repository-link': {
      relation: 'repository',
      href: 'https://github.com/github/gh-aw',
      label: 'github/gh-aw'
    },
    'workflow-link': {
      relation: 'workflow',
      href: 'https://github.com/github/gh-aw/actions/workflows/dependabot.lock.yml',
      label: 'Dependabot / Update Planner'
    },
    'target-repository-link': {
      'dashboard-href': '#page-repository-detail?repository=github%2Fgh-aw',
      'dashboard-label': 'github/gh-aw'
    }
  };
}

describe('problem detail', () => {
  it('renders the complete problem as a full detail view rather than a table', () => {
    const allocation = vi.fn();
    const rendered = renderProblemDetail(context());
    rendered.addEventListener('dashboard-route-allocation', allocation);
    rendered.dispatchEvent(new CustomEvent('dashboard-route-change', {
      detail: { parameter: 'target-repository', value: 'github/gh-aw' }
    }));

    expect(rendered.querySelector('table')).toBeNull();
    expect(rendered.querySelector('.problem-view-summary')?.textContent).toContain('exited with status 1');
    expect(rendered.querySelector('.status')?.textContent).toBe('Failure');
    expect(rendered.querySelector('.mode-badge')?.textContent).toBe('Live');
    expect(rendered.querySelector('.problem-view-highlights')?.textContent).toContain('Occurrences65');
    expect(rendered.querySelector('.problem-view-sections')?.textContent).toContain('Error signaturedependency-update-failed');
    expect(rendered.querySelector('.problem-view-sections')?.textContent).toContain('Resolved modelmodel-b');
    expect(rendered.querySelector('a[href*="/actions/runs/1"]')?.textContent).toBe('View run');
    expect(rendered.querySelector('a[href="https://github.com/github/gh-aw"]')?.textContent).toBe('github/gh-aw');
    expect(rendered.querySelector('a[href*="/actions/workflows/dependabot.lock.yml"]')?.textContent).toBe('Dependabot / Update Planner');
    expect(rendered.querySelector('a[href="#page-repository-detail?repository=github%2Fgh-aw"]')?.textContent).toBe('github/gh-aw');
    expect(rendered.querySelector('.problem-view-log')?.textContent).toContain('##[error]dependency update failed');
    expect(rendered.getElementsByTagName('button')[0]?.textContent).toBe('Fix It');
    expect(allocation).toHaveBeenCalledWith(expect.objectContaining({
      detail: {
        title: 'Dependency update failed',
        description: 'Dependabot / Update Planner · github/gh-aw · Live'
      }
    }));
  });

  it('renders an explicit empty state when the routed problem is unavailable', () => {
    const rendered = renderProblemDetail(context([]));
    rendered.dispatchEvent(new CustomEvent('dashboard-route-change', {
      detail: { parameter: 'target-repository', value: 'github/gh-aw' }
    }));

    expect(rendered.textContent).toBe('This runtime problem is no longer present in the selected horizon.');
  });
});
