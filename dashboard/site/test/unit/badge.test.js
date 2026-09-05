// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  modeBadgeClassName,
  renderActiveStateBadge,
  renderExperimentBadge,
  renderGraderStatusBadge,
  renderModeBadge,
  renderStatusBadge,
} from '../../src/components/badge.js';

describe('badge', () => {
  it('renders the shared experiment-badge markup used by the experiment decision surface', () => {
    const danger = renderExperimentBadge('Regression', 'danger');
    expect(danger.tagName).toBe('SPAN');
    expect(danger.className).toBe('experiment-badge experiment-badge-danger');
    expect(danger.textContent).toContain('Regression');

    const success = renderExperimentBadge('Passing', 'success');
    expect(success.className).toBe('experiment-badge experiment-badge-success');

    const neutral = renderExperimentBadge('Not configured', 'neutral');
    expect(neutral.className).toBe('experiment-badge experiment-badge-neutral');
    expect(neutral.textContent).toBe('Not configured');
  });

  it('maps normalized mode labels to the shared mode-badge class suffix', () => {
    expect(modeBadgeClassName('live')).toBe('mode-live');
    expect(modeBadgeClassName('review')).toBe('mode-review');
    expect(modeBadgeClassName('unknown')).toBe('');
  });

  it('renders a mode badge using the shared class name mapping', () => {
    const live = renderModeBadge('Live');
    expect(live.className).toBe('mode-badge mode-live');
    expect(live.textContent).toBe('Live');

    const review = renderModeBadge('review');
    expect(review.className).toBe('mode-badge mode-review');

    const fallback = renderModeBadge(null);
    expect(fallback.className).toBe('mode-badge');
    expect(fallback.textContent).toBe('unknown');
  });

  it('shares the same "status <class>" span markup across status-flavored badges', () => {
    const status = renderStatusBadge('success');
    expect(status.tagName).toBe('SPAN');
    expect(status.className).toBe('status status-success');
    expect(status.textContent).toBe('success');

    const grader = renderGraderStatusBadge('fail');
    expect(grader.tagName).toBe('SPAN');
    expect(grader.className).toBe('status status-danger');
    expect(grader.textContent).toBe('fail');

    const active = renderActiveStateBadge(true);
    expect(active.tagName).toBe('SPAN');
    expect(active.className).toBe('status status-success');
    expect(active.textContent).toBe('true');

    const inactive = renderActiveStateBadge(false);
    expect(inactive.className).toBe('status status-muted');
  });
});
