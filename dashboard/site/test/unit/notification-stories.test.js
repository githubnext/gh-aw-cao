import { describe, expect, it } from 'vitest';
import { normalizeNotificationStories } from '../../src/notification-stories.js';

const pullRequestLink = {
  relation: 'pull-request',
  href: 'https://github.com/octo/widgets/pull/42',
  label: 'View pull request 42'
};

describe('notification story normalization', () => {
  it('groups events for one object and preserves the latest event details and deep link', () => {
    const events = [{
      'attention-signal-id': 'signal-ci-failed',
      'signal-type': 'runtime-failure',
      objective: 'CI failed',
      reason: 'The test job failed.',
      scope: 'octo/widgets',
      priority: 1,
      'observed-at': '2026-09-08T01:00:00Z',
      'pull-request-link': pullRequestLink
    }, {
      'event-id': 'event-ci-passed',
      classification: 'status-update',
      title: 'CI passed',
      detail: 'All required checks passed.',
      repository: 'octo/widgets',
      priority: 3,
      timestamp: '2026-09-08T02:00:00Z',
      'pull-request-link': pullRequestLink
    }];

    expect(normalizeNotificationStories(events)).toEqual([{
      id: 'notification-story:octo%2Fwidgets:pull-request:42',
      classification: 'status-update',
      title: 'CI passed',
      detail: 'All required checks passed.',
      repository: 'octo/widgets',
      objectType: 'pull-request',
      objectId: '42',
      timestamp: Date.parse('2026-09-08T02:00:00Z'),
      deepLink: pullRequestLink.href,
      priority: 1,
      contributingRawEventIds: ['event-ci-passed', 'signal-ci-failed']
    }]);
  });

  it('keeps story IDs stable across refreshes and does not merge unrelated objects', () => {
    const firstRefresh = [{
      'event-id': 'run-started',
      classification: 'workflow-run',
      title: 'CI started',
      repository: 'octo/widgets',
      timestamp: '2026-09-08T01:00:00Z',
      'run-link': {
        relation: 'run',
        href: 'https://github.com/octo/widgets/actions/runs/9001',
        label: 'View run 9001'
      }
    }];
    const secondRefresh = [{
      ...firstRefresh[0],
      'event-id': 'run-completed',
      title: 'CI completed',
      timestamp: '2026-09-08T02:00:00Z'
    }, firstRefresh[0], {
      'event-id': 'other-run',
      classification: 'workflow-run',
      title: 'Deploy completed',
      repository: 'octo/widgets',
      objectType: 'workflow-run',
      objectId: '9002',
      timestamp: '2026-09-08T03:00:00Z',
      deepLink: 'https://github.com/octo/widgets/actions/runs/9002'
    }];

    const firstStory = normalizeNotificationStories(firstRefresh)[0];
    const refreshedStories = normalizeNotificationStories(secondRefresh);
    const refreshedStory = refreshedStories.find((story) => story.objectId === '9001');

    expect(refreshedStory?.id).toBe(firstStory.id);
    expect(refreshedStory?.contributingRawEventIds).toEqual(['run-completed', 'run-started']);
    expect(refreshedStories).toHaveLength(2);
    expect(new Set(refreshedStories.map((story) => story.id)).size).toBe(2);
  });

  it('does not mutate or remove raw events used as story evidence', () => {
    const events = [{
      'event-id': 'finding-7',
      classification: 'security-finding',
      title: 'Secret detected',
      detail: 'Review the detected credential.',
      repository: 'octo/widgets',
      objectType: 'security-finding',
      objectId: '7',
      timestamp: '2026-09-08T02:00:00Z',
      priority: 0,
      deepLink: 'https://github.com/octo/widgets/security/secret-scanning/7'
    }];
    const snapshot = structuredClone(events);

    normalizeNotificationStories(events);

    expect(events).toEqual(snapshot);
  });

  it('canonicalizes numeric IDs and keeps security alert namespaces separate', () => {
    const stories = normalizeNotificationStories([{
      id: 1,
      title: 'Issue updated',
      repository: 'octo/widgets',
      objectType: 'issue',
      objectId: 42,
      timestamp: '2026-09-08T01:00:00Z'
    }, {
      id: 2,
      title: 'Issue updated again',
      repository: 'octo/widgets',
      objectType: 'issue',
      objectId: 42,
      timestamp: '2026-09-08T02:00:00Z'
    }, {
      id: 3,
      title: 'Secret alert',
      deepLink: 'https://github.com/octo/widgets/security/secret-scanning/7',
      timestamp: '2026-09-08T03:00:00Z'
    }, {
      id: 4,
      title: 'Code alert',
      deepLink: 'https://github.com/octo/widgets/security/code-scanning/7',
      timestamp: '2026-09-08T04:00:00Z'
    }]);

    expect(stories).toHaveLength(3);
    expect(stories.find((story) => story.objectType === 'issue')?.contributingRawEventIds).toEqual(['1', '2']);
    expect(stories.filter((story) => story.objectType === 'security-finding').map((story) => story.objectId))
      .toEqual(['code-scanning:7', 'secret-scanning:7']);
  });
});
