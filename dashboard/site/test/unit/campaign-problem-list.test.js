// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { renderCampaignProblemList } from '../../src/components/campaign-problem-list.js';

/** @param {Record<string, unknown>[]} rows */
function render(rows) {
  return renderCampaignProblemList({
    pageId: 'campaign-problems',
    title: 'Problems',
    description: 'Current runtime problems, grouped by workflow.',
    sourceNames: ['campaign-problem-items'],
    sources: {
      'campaign-problem-items': {
        source: 'campaign-problem-items',
        rows,
        metadata: {
          'source-id': 'campaign-problem-items',
          'source-kind': 'fixture',
          'as-of': '2026-09-22T12:00:00Z',
          'retrieved-at': '2026-09-22T12:00:00Z',
          completeness: 'complete',
          freshness: 'fresh',
          availability: rows.length > 0 ? 'available' : 'empty'
        }
      }
    },
    contextDetails: [],
    headingTag: 'h3'
  });
}

describe('campaign problem list', () => {
  it('groups failed Run evidence by workflow and offers a repair prompt', () => {
    const rendered = render([
      {
        campaign: 'optimization',
        workflow: '.github/workflows/optimization-token-optimizer.lock.yml',
        'workflow-name': 'Token Optimizer',
        'runtime-repository': 'githubnext/gh-aw-cao',
        'target-repository': 'octo-org/service-api',
        'rollout-mode': 'live',
        'problem-kind': 'failure',
        'failure-count': 3,
        status: 'failure',
        'status-detail': 'Process completed with exit code 1.',
        'started-at': '2026-09-22T10:00:00Z',
        run: '123',
        'run-link': {
          href: 'https://github.com/githubnext/gh-aw-cao/actions/runs/123',
          label: 'Run 123'
        }
      },
      {
        campaign: 'optimization',
        workflow: '.github/workflows/optimization-token-optimizer.lock.yml',
        'workflow-name': 'Token Optimizer',
        'runtime-repository': 'githubnext/gh-aw-cao',
        'target-repository': 'octo-org/web-app',
        'rollout-mode': 'review',
        'problem-kind': 'failure',
        'failure-count': 3,
        status: 'failure',
        'status-detail': 'Startup failure',
        run: '122'
      }
    ]);

    expect(rendered.querySelectorAll('.campaign-problem-group')).toHaveLength(1);
    expect(rendered.querySelector('.campaign-problem-group-name')?.textContent).toBe('Token Optimizer');
    expect(rendered.querySelector('.campaign-problem-group-header .count-badge')).toBeNull();
    expect(rendered.querySelectorAll('.campaign-problem-item')).toHaveLength(2);
    expect([...rendered.querySelectorAll('.campaign-problem-target')].map((node) => node.textContent))
      .toEqual([
        'Target repository: octo-org/service-api Live',
        'Target repository: octo-org/web-app Review'
      ]);
    expect([...rendered.querySelectorAll('.campaign-problem-target .mode-badge')].map((badge) => ({
      label: badge.textContent,
      className: badge.className
    }))).toEqual([
      { label: 'Live', className: 'mode-badge mode-live' },
      { label: 'Review', className: 'mode-badge mode-review' }
    ]);
    expect(rendered.textContent).not.toContain('Runtime: githubnext/gh-aw-cao');
    expect(rendered.textContent).toContain('Process completed with exit code 1.');
    expect(rendered.querySelector('.campaign-problem-age')?.textContent).toBeTruthy();
    expect(rendered.querySelector('.campaign-problem-metadata .campaign-problem-age')).toBeNull();
    expect(rendered.querySelector('.campaign-problem-title a')?.getAttribute('href'))
      .toBe('https://github.com/githubnext/gh-aw-cao/actions/runs/123');
    expect(rendered.querySelector('.campaign-problem-title a')?.textContent)
      .toBe('Process completed with exit code 1.');
    expect(rendered.querySelector('.campaign-problem-title a')?.getAttribute('aria-label'))
      .toBe('Process completed with exit code 1.');
    expect(rendered.querySelector('[data-intent-presentation="copy-prompt"]')?.textContent)
      .toContain('Fix It');
    expect(rendered.querySelector('.table-intent-dialog')?.textContent)
      .toContain('Use the debugging skill');
    expect(rendered.querySelector('details.campaign-problem-group')).toBeNull();
  });

  it('shows active orchestrators without retained Run evidence as problems', () => {
    const rendered = render([
      {
        campaign: 'dependabot',
        workflow: '.github/workflows/dependabot.md',
        'workflow-name': 'Dependabot',
        'workflow-role': 'orchestrator',
        'runtime-repository': 'githubnext/gh-aw-cao',
        'problem-kind': 'not-observed',
        'failure-count': 0
      }
    ]);

    expect(rendered.textContent).toContain('No retained orchestrator Run was observed');
    expect(rendered.querySelector('.campaign-problem-target')?.textContent)
      .toBe('Target repository: Unavailable for this observation');
    expect(rendered.querySelector('.campaign-problem-group-header .count-badge')).toBeNull();
    expect(rendered.querySelector('.campaign-problem-severity')?.getAttribute('aria-label')).toBe('Error');
  });

  it('renders a clustered error signature with an occurrence badge and representative evidence', () => {
    const rendered = render([
      {
        campaign: 'dependabot',
        workflow: '.github/workflows/dependabot-update-planner.md',
        'workflow-name': 'Dependabot / Update Planner',
        'runtime-repository': 'githubnext/gh-aw-cao',
        'problem-kind': 'failure',
        'failure-count': 10,
        'error-signature': 'driver_exit',
        'error-signature-label': 'Driver Exit',
        'occurrence-count': 52,
        status: 'failure',
        'status-detail': null,
        'started-at': '2026-09-22T10:00:00Z',
        run: '35754799033',
        'run-link': 'https://github.com/githubnext/gh-aw-cao/actions/runs/35754799033'
      },
      {
        campaign: 'dependabot',
        workflow: '.github/workflows/dependabot-update-planner.md',
        'workflow-name': 'Dependabot / Update Planner',
        'runtime-repository': 'githubnext/gh-aw-cao',
        'problem-kind': 'failure',
        'failure-count': 10,
        'error-signature': 'agent_logic',
        'error-signature-label': 'Agent Logic',
        'occurrence-count': 3,
        status: 'failure',
        run: '35362423230'
      }
    ]);

    expect(rendered.querySelectorAll('.campaign-problem-item')).toHaveLength(2);
    expect(rendered.textContent).toContain('Driver Exit');
    expect(rendered.textContent).toContain('Agent Logic');
    const badges = [...rendered.querySelectorAll('.count-badge')].map((badge) => badge.textContent);
    expect(badges).toContain('52×');
    expect(badges).toContain('3×');
    expect(rendered.querySelectorAll('.campaign-problem-occurrences')).toHaveLength(0);
    expect(rendered.querySelectorAll('.campaign-problem-message .count-badge')).toHaveLength(2);
    expect(rendered.querySelector('.campaign-problem-message .campaign-problem-age')?.textContent).toBeTruthy();
    expect(rendered.querySelector('.campaign-problem-title a')?.textContent).toBe('Driver Exit');
  });

  it('renders an honest empty state', () => {
    const rendered = render([]);
    expect(rendered.querySelector('.campaign-problem-list-empty')?.textContent)
      .toContain('No current runtime problems were observed');
  });
});
