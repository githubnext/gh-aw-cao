// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderWorkflowBadges, workflowCampaignMemberships, workflowRole } from '../../src/components/workflow-badges.js';

describe('workflow-badges', () => {
  it('renders the workflow role and sorted campaign memberships', () => {
    const element = renderWorkflowBadges({
      campaign: 'ambient-context',
      'campaign-name': 'Ambient Context',
      'campaign-memberships': [
        { id: 'central-agentic-ops', name: 'Central Agentic Ops' },
        { id: 'ambient-context', name: 'Ambient Context' }
      ],
      'workflow-role': 'orchestrator'
    });

    expect(element.className).toBe('workflow-badges');
    expect([...element.querySelectorAll('.workflow-badge')].map((badge) => badge.textContent)).toEqual([
      'Orchestrator',
      'Campaign · Ambient Context',
      'Campaign · Central Agentic Ops'
    ]);
    expect([...element.querySelectorAll('a')].map((badge) => badge.getAttribute('href'))).toEqual([
      '#page-campaign-insights?campaign=ambient-context',
      '#page-campaign-insights?campaign=central-agentic-ops'
    ]);
  });

  it('supports custom class names and campaign destinations', () => {
    const element = renderWorkflowBadges({
      campaign: 'maintenance',
      'campaign-name': 'Maintenance',
      'workflow-role': 'worker'
    }, {
      containerClassName: 'repository-workflow-badges',
      roleClassName: 'workflow-badge',
      membershipClassName: 'workflow-badge workflow-badge-operation',
      campaignPage: 'campaigns'
    });

    expect(element.className).toBe('repository-workflow-badges');
    expect(element.querySelector('.workflow-badge-worker')?.textContent).toBe('Worker');
    expect(element.querySelector('a')?.getAttribute('href')).toBe('#page-campaigns?campaign=maintenance');
  });

  it('derives operation and unknown roles conservatively', () => {
    expect(workflowRole({ campaign: 'ambient-context', 'campaign-name': 'Ambient Context' })).toBe('operation');
    expect(workflowRole({})).toBe('unknown');
  });

  it('normalizes and deduplicates campaign memberships while skipping invalid items', () => {
    expect(workflowCampaignMemberships({
      campaign: 'fallback',
      'campaign-name': 'Fallback',
      'campaign-memberships': [
        { id: 'beta', name: 'Beta' },
        { id: 'alpha', name: 'Alpha' },
        { id: 'beta', name: 'Beta duplicate' },
        null,
        [],
        { id: '', name: 'Missing id' },
        { id: 'missing-name', name: '' }
      ]
    })).toEqual([
      { id: 'alpha', name: 'Alpha' },
      { id: 'beta', name: 'Beta duplicate' }
    ]);

    expect(workflowCampaignMemberships({ campaign: 'fallback', 'campaign-name': 'Fallback' })).toEqual([
      { id: 'fallback', name: 'Fallback' }
    ]);
    expect(workflowCampaignMemberships({})).toEqual([]);
  });
});
