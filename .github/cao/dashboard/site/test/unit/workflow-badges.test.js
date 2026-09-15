// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderWorkflowBadges, workflowPackageMemberships, workflowRole } from '../../src/components/workflow-badges.js';

describe('workflow-badges', () => {
  it('renders the workflow role and sorted package memberships', () => {
    const element = renderWorkflowBadges({
      package: 'ambient-context',
      'package-name': 'Ambient Context',
      'package-memberships': [
        { id: 'central-agentic-ops', name: 'Central Agentic Ops' },
        { id: 'ambient-context', name: 'Ambient Context' }
      ],
      'workflow-role': 'orchestrator'
    });

    expect(element.className).toBe('workflow-badges');
    expect([...element.querySelectorAll('.workflow-badge')].map((badge) => badge.textContent)).toEqual([
      'Orchestrator',
      'Package · Ambient Context',
      'Package · Central Agentic Ops'
    ]);
    expect([...element.querySelectorAll('a')].map((badge) => badge.getAttribute('href'))).toEqual([
      '#page-package-insights?package=ambient-context',
      '#page-package-insights?package=central-agentic-ops'
    ]);
  });

  it('supports custom class names and package destinations', () => {
    const element = renderWorkflowBadges({
      package: 'maintenance',
      'package-name': 'Maintenance',
      'workflow-role': 'worker'
    }, {
      containerClassName: 'repository-workflow-badges',
      roleClassName: 'workflow-badge',
      membershipClassName: 'workflow-badge workflow-badge-operation',
      packagePage: 'packages'
    });

    expect(element.className).toBe('repository-workflow-badges');
    expect(element.querySelector('.workflow-badge-worker')?.textContent).toBe('Worker');
    expect(element.querySelector('a')?.getAttribute('href')).toBe('#page-packages?package=maintenance');
  });

  it('derives operation and unknown roles conservatively', () => {
    expect(workflowRole({ package: 'ambient-context', 'package-name': 'Ambient Context' })).toBe('operation');
    expect(workflowRole({})).toBe('unknown');
  });

  it('normalizes and deduplicates package memberships while skipping invalid items', () => {
    expect(workflowPackageMemberships({
      package: 'fallback',
      'package-name': 'Fallback',
      'package-memberships': [
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

    expect(workflowPackageMemberships({ package: 'fallback', 'package-name': 'Fallback' })).toEqual([
      { id: 'fallback', name: 'Fallback' }
    ]);
    expect(workflowPackageMemberships({})).toEqual([]);
  });
});
