// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderUiElement } from '../../src/components/ui-elements.js';

const metadata = {
  'source-id': 'oversight-fixture',
  'source-kind': 'fixture',
  'as-of': '2026-09-06T05:00:00Z',
  'retrieved-at': '2026-09-06T05:01:00Z',
  completeness: /** @type {'partial'} */ ('partial'),
  freshness: /** @type {'stale'} */ ('stale'),
  availability: /** @type {'available'} */ ('available')
};

/** @param {string} element @param {Record<string, import('../../src/presenter.js').LogicalSourceInput>} sources @param {string[]} sourceNames */
function render(element, sources, sourceNames = Object.keys(sources)) {
  return renderUiElement(element, {
    pageId: 'oversight',
    title: 'Oversight',
    description: 'Operator-facing delegated work.',
    sourceNames,
    sources,
    contextDetails: [],
    headingTag: 'h3'
  });
}

describe('agentic oversight primitives', () => {
  it('keeps execution, verification, outcome, and maturity independent', () => {
    const rendered = render('work-list', {
      'work-items': {
        source: 'work-items',
        rows: [{
          'work-item-id': 'auth',
          objective: 'Auth migration',
          scope: 'identity-service',
          'lifecycle-state': 'review',
          phase: 'verifying',
          reason: 'Security verification failed.',
          'next-action': 'Review contradictory evidence',
          'execution-state': 'success',
          'verification-state': 'failed',
          'artifact-state': 'produced',
          'outcome-state': 'pending',
          'maturity-status': 'immature',
          'state-history': [
            { phase: 'execute', 'observed-at': '2026-09-06T01:00:00Z', 'transition-kind': 'observed' },
            { phase: 'verify', 'observed-at': '2026-09-06T02:00:00Z', 'transition-kind': 'observed' },
            { phase: 'edit', 'observed-at': '2026-09-06T03:00:00Z', reason: 'Verification regressed the work.', 'transition-kind': 'observed' },
            { phase: 'waiting', 'observed-at': '2026-09-06T04:00:00Z', reason: 'Human-assisted recovery', 'transition-kind': 'observed' }
          ]
        }],
        metadata
      }
    });

    expect(rendered?.querySelector('.truth-rail')?.getAttribute('aria-label')).toContain('Executed: success');
    expect(rendered?.querySelector('.truth-rail')?.getAttribute('aria-label')).toContain('Verified: failed');
    expect(rendered?.querySelector('.truth-rail')?.getAttribute('aria-label')).toContain('Outcome: pending');
    expect(rendered?.querySelector('.truth-rail')?.getAttribute('aria-label')).toContain('Mature: immature');
    expect(rendered?.querySelectorAll('.state-ribbon li')).toHaveLength(4);
    expect(rendered?.textContent).toContain('end unavailable');
    expect(rendered?.textContent).not.toContain('% complete');
  });

  it('renders priority-first attention with actor, waiting age, reason, and action', () => {
    const rendered = render('attention-stack', {
      'attention-signals': {
        source: 'attention-signals',
        rows: [
          { objective: 'Recovered work', reason: 'Autonomous recovery', 'recovery-state': 'autonomous', priority: 9 },
          {
            objective: 'Auth migration',
            reason: 'Two checks conflict.',
            action: 'Review evidence',
            'expected-actor': 'security-reviewer',
            'age-seconds': 7200,
            priority: 0
          }
        ],
        metadata
      }
    });

    expect(rendered?.querySelector('.attention-stack-primary')?.textContent).toContain('Auth migration');
    expect(rendered?.querySelector('.attention-stack-primary')?.textContent).toContain('Two checks conflict.');
    expect(rendered?.querySelector('.attention-stack-primary')?.textContent).toContain('security-reviewer');
    expect(rendered?.querySelector('.attention-stack-primary')?.textContent).toContain('Review evidence');
    expect(rendered?.textContent).not.toContain('Recovered work');
  });

  it('shows contextual coordination handoffs, conflicts, and unavailable boundaries', () => {
    const rows = [
      {
        'assignment-id': 'scout',
        'work-item-id': 'auth',
        'agent-name': 'Scout',
        objective: 'Auth migration',
        'agent-state': 'completed',
        'handoff-state': 'completed',
        'dependency-state': 'resolved',
        'conflict-state': 'none',
        'started-at': '2026-09-06T01:00:00Z',
        'ended-at': '2026-09-06T01:20:00Z',
        'coordination-source': 'declared'
      },
      {
        'assignment-id': 'verifier',
        'work-item-id': 'auth',
        'agent-name': 'Verifier',
        objective: 'Auth migration',
        'agent-state': 'waiting',
        'handoff-state': 'waiting-for-review',
        'dependency-state': 'waiting',
        'conflict-state': 'contended',
        'started-at': '2026-09-06T01:20:00Z',
        'coordination-source': 'observed'
      }
    ];
    const rendered = render('agent-assignment-list', {
      'agent-assignments': { source: 'agent-assignments', rows, metadata }
    });

    expect(rendered?.textContent).toContain('Conflict: contended');
    expect(rendered?.querySelector('.coordination-braid')?.getAttribute('aria-label')).toContain('monotonic time axis');
    expect(rendered?.textContent).toContain('boundary unavailable');
    expect(rendered?.textContent).toContain('Declared');
    expect(rendered?.textContent).toContain('Observed');
  });

  it('preserves contradictory evidence and visibly breaks missing provenance', () => {
    const rows = [
      {
        'evidence-id': 'unit',
        'work-item-id': 'auth',
        objective: 'Auth migration',
        claim: 'Auth bypass is fixed',
        'evidence-kind': 'unit tests',
        'evidence-class': 'observed',
        'evidence-disposition': 'supports',
        'verification-state': 'accepted',
        'provenance-state': 'complete',
        'source-revision': 'tests/auth-unit',
        'authority-state': 'available',
        execution: 'run-1',
        'artifact-state': 'produced',
        'outcome-state': 'pending',
        'maturity-status': 'immature'
      },
      {
        'evidence-id': 'e2e',
        'work-item-id': 'auth',
        objective: 'Auth migration',
        claim: 'Auth bypass is fixed',
        'evidence-kind': 'auth-e2e',
        'evidence-class': 'observed',
        'evidence-disposition': 'contradicts',
        'verification-state': 'failed',
        'provenance-state': 'partial',
        'source-revision': '',
        'authority-state': '',
        execution: '',
        'artifact-state': 'produced',
        'outcome-state': 'pending',
        'maturity-status': 'immature'
      }
    ];
    const rendered = render('evidence-list', {
      'evidence-records': { source: 'evidence-records', rows, metadata }
    });

    expect(rendered?.querySelector('.evidence-split')?.textContent).toContain('Supports');
    expect(rendered?.querySelector('.evidence-split')?.textContent).toContain('Contradicts');
    expect(rendered?.querySelector('.evidence-split')?.textContent).toContain('Unresolved');
    expect(rendered?.querySelectorAll('.provenance-unavailable').length).toBeGreaterThan(0);
    expect(rendered?.textContent).toContain('association unavailable');
  });

  it('distinguishes pending outcomes, immature value, missing capacity, and qualified capacity risk', () => {
    const outcomes = {
      source: 'outcomes',
      rows: [{
        'safe-output': 'pr-442',
        'outcome-title': 'PR #442',
        repository: 'identity-service',
        workflow: 'auth',
        run: '42',
        'run-conclusion': 'success',
        'verification-state': 'verified',
        'outcome-state': 'accepted',
        'observed-at': '2026-09-06T02:00:00Z'
      }],
      metadata
    };
    const values = {
      source: 'operational-values',
      rows: [{
        repository: 'identity-service',
        workflow: 'auth',
        run: '42',
        'operational-value': 0,
        'maturity-status': 'interim'
      }],
      metadata
    };
    const horizon = render('maturity-horizon', { outcomes, 'operational-values': values });
    expect(horizon?.querySelector('.truth-rail')?.getAttribute('aria-label')).toContain('Mature: interim');
    expect(horizon?.textContent).toContain('value 0');

    const capacity = render('capacity-horizon', {
      'github-api-rate-limits': {
        source: 'github-api-rate-limits',
        rows: [{
          credential: 'control-plane',
          resource: 'core',
          'remaining-percent': 18,
          'minutes-to-reset': 24,
          'projected-remaining-at-reset': 0,
          'risk-status': 'critical',
          'observed-at': '2026-09-06T04:00:00Z'
        }, {
          credential: 'control-plane',
          resource: 'graphql',
          'remaining-percent': null,
          'minutes-to-reset': null,
          'risk-status': 'unknown',
          'observed-at': '2026-09-06T04:00:00Z'
        }],
        metadata
      }
    });
    expect(capacity?.textContent).toContain('Observed burn may exhaust before reset');
    expect(capacity?.textContent).toContain('Capacity telemetry unavailable');
    expect(capacity?.textContent).not.toContain('graphql has 0%');
  });

  it('filters card lists from keyboard-operable state summary buttons', () => {
    const source = {
      'work-items': {
        source: 'work-items',
        rows: [
          { 'work-item-id': 'one', objective: 'One', 'lifecycle-state': 'active' },
          { 'work-item-id': 'two', objective: 'Two', 'lifecycle-state': 'blocked' }
        ],
        metadata
      }
    };
    const page = document.createElement('main');
    page.dataset.pageId = 'work';
    page.append(
      /** @type {HTMLElement} */ (render('state-summary', source)),
      /** @type {HTMLElement} */ (render('work-list', source))
    );
    const blocked = /** @type {HTMLButtonElement} */ ([...page.querySelectorAll('button')].find((button) => button.textContent?.includes('Blocked')));
    blocked.focus();
    blocked.click();

    expect(blocked.getAttribute('aria-pressed')).toBe('true');
    expect(page.querySelector('[data-filter-value="active"]')?.hasAttribute('hidden')).toBe(true);
    expect(page.querySelector('[data-filter-value="blocked"]')?.hasAttribute('hidden')).toBe(false);
  });
});
