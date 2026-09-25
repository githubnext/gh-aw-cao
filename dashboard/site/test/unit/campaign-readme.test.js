// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { renderCampaignReadme } from '../../src/components/campaign-readme.js';
import { setDeclaredCliActions } from '../../src/components/cli-actions.js';

const CAMPAIGN_CLI_ACTIONS = [
  { id: 'set-campaign-live', label: 'Switch to live', icon: 'play', command: './cao.sh mode live {{campaign}}' },
  { id: 'set-campaign-preview', label: 'Switch to preview', icon: 'eye', command: './cao.sh mode preview {{campaign}}' },
  { id: 'enable-campaign', label: 'Enable campaign', icon: 'play', command: './cao.sh enable {{campaign}}' },
  { id: 'disable-campaign', label: 'Pause campaign', icon: 'pause', command: './cao.sh disable {{campaign}}' }
];

afterEach(() => {
  setDeclaredCliActions([]);
});

describe('campaign readme status pane', () => {
  it('shows the campaign as enabled and offers pause and preview actions when live and active', () => {
    setDeclaredCliActions(CAMPAIGN_CLI_ACTIONS);
    const rendered = renderCampaignReadme({
      campaignId: 'ambient-context',
      campaignName: 'Ambient Context',
      workflows: [
        { 'workflow-role': 'orchestrator', 'rollout-mode': 'live', 'workflow-active': 'true' },
        { 'workflow-role': 'worker', 'rollout-mode': 'live', 'workflow-active': 'true' }
      ]
    });
    const status = rendered.querySelector('.campaign-status');
    expect(status?.querySelector('.campaign-status-state')?.textContent).toBe('Enabled');
    expect(status?.querySelector('.campaign-status-state')?.className).toContain('campaign-status-state-enabled');
    const actionLabels = [...status?.querySelectorAll('.campaign-status-actions .cli-action-trigger strong') ?? []]
      .map((node) => node.textContent);
    expect(actionLabels).toEqual(['Switch to preview', 'Pause campaign']);
  });

  it('shows the campaign as paused and offers enable and live actions when any workflow is inactive', () => {
    setDeclaredCliActions(CAMPAIGN_CLI_ACTIONS);
    const rendered = renderCampaignReadme({
      campaignId: 'ambient-context',
      campaignName: 'Ambient Context',
      workflows: [
        { 'workflow-role': 'orchestrator', 'rollout-mode': 'review', 'workflow-active': 'true' },
        { 'workflow-role': 'worker', 'rollout-mode': 'review', 'workflow-active': 'false' }
      ]
    });
    const status = rendered.querySelector('.campaign-status');
    expect(status?.querySelector('.campaign-status-state')?.textContent).toBe('Paused');
    expect(status?.querySelector('.campaign-status-state')?.className).toContain('campaign-status-state-disabled');
    const actionLabels = [...status?.querySelectorAll('.campaign-status-actions .cli-action-trigger strong') ?? []]
      .map((node) => node.textContent);
    expect(actionLabels).toEqual(['Switch to live', 'Enable campaign']);
  });

  it('treats a boolean false workflow-active value and case-insensitive "False" as inactive', () => {
    setDeclaredCliActions(CAMPAIGN_CLI_ACTIONS);
    const rendered = renderCampaignReadme({
      campaignId: 'ambient-context',
      campaignName: 'Ambient Context',
      workflows: [
        { 'workflow-role': 'orchestrator', 'rollout-mode': 'review', 'workflow-active': false },
        { 'workflow-role': 'worker', 'rollout-mode': 'review', 'workflow-active': 'False' }
      ]
    });
    expect(rendered.querySelector('.campaign-status-state')?.textContent).toBe('Paused');
  });

  it('defaults to enabled when workflow-active is missing or an unrecognized value', () => {
    setDeclaredCliActions(CAMPAIGN_CLI_ACTIONS);
    const rendered = renderCampaignReadme({
      campaignId: 'ambient-context',
      campaignName: 'Ambient Context',
      workflows: [
        { 'workflow-role': 'orchestrator', 'rollout-mode': 'review' },
        { 'workflow-role': 'worker', 'rollout-mode': 'review', 'workflow-active': 'unexpected' }
      ]
    });
    expect(rendered.querySelector('.campaign-status-state')?.textContent).toBe('Enabled');
  });

  it('omits status actions when no cli-actions are declared', () => {
    const rendered = renderCampaignReadme({
      campaignId: 'ambient-context',
      campaignName: 'Ambient Context',
      workflows: [{ 'workflow-role': 'orchestrator', 'rollout-mode': 'live', 'workflow-active': 'true' }]
    });
    expect(rendered.querySelector('.campaign-status-actions')).toBeNull();
  });
});
