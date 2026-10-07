// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderWorkflowBadges, workflowCampaignMembership, workflowRole } from '../../src/components/workflow-badges.js';

describe('workflow-badges', () => {
  it('renders the workflow role and its single campaign membership', () => {
    const element = renderWorkflowBadges({
      campaign: 'ambient-context',
      'campaign-name': 'Ambient Context',
      'workflow-role': 'orchestrator'
    });

    expect(element.className).toBe('workflow-badges');
    expect([...element.querySelectorAll('.workflow-badge')].map((badge) => badge.textContent)).toEqual([
      'Orchestrator',
      'Campaign · Ambient Context'
    ]);
    expect([...element.querySelectorAll('a')].map((badge) => badge.getAttribute('href'))).toEqual([
      '#page-campaign-insights?campaign=ambient-context'
    ]);
  });

  it('omits the campaign badge when there is no membership', () => {
    const element = renderWorkflowBadges({ 'workflow-role': 'worker' });

    expect([...element.querySelectorAll('.workflow-badge')].map((badge) => badge.textContent)).toEqual(['Worker']);
    expect(element.querySelectorAll('a')).toHaveLength(0);
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

  it('projects the canonical singular campaign/campaign-name pair', () => {
    expect(workflowCampaignMembership({ campaign: 'fallback', 'campaign-name': 'Fallback' })).toEqual({
      id: 'fallback',
      name: 'Fallback'
    });
    expect(workflowCampaignMembership({ campaign: 'fallback' })).toEqual({ id: 'fallback', name: 'fallback' });
    expect(workflowCampaignMembership({})).toBeNull();
  });
});
