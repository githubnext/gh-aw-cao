import { describe, expect, it } from 'vitest'
import {
  buildCatchUpQueue,
  normalizeNotificationStories,
} from '../../src/notification-stories.js'

const pullRequestLink = {
  relation: 'pull-request',
  href: 'https://github.com/octo/widgets/pull/42',
  label: 'View pull request 42',
}

describe('notification story normalization', () => {
  it('collapses a CI failure followed by success into one recovered story', () => {
    const events = [
      {
        'attention-signal-id': 'signal-ci-failed',
        'signal-type': 'runtime-failure',
        objective: 'CI failed',
        reason: 'The test job failed.',
        scope: 'octo/widgets',
        priority: 1,
        'observed-at': '2026-09-08T01:00:00Z',
        'pull-request-link': pullRequestLink,
      },
      {
        'event-id': 'event-ci-passed',
        classification: 'status-update',
        title: 'CI passed',
        detail: 'All required checks passed.',
        repository: 'octo/widgets',
        priority: 3,
        timestamp: '2026-09-08T02:00:00Z',
        'pull-request-link': pullRequestLink,
      },
    ]

    const expected = [
      {
        id: 'notification-story:octo%2Fwidgets:pull-request:42',
        classification: 'update',
        sourceType: 'status-update',
        title: 'CI recovered',
        detail: 'All required checks passed.',
        repository: 'octo/widgets',
        objectType: 'pull-request',
        objectId: '42',
        timestamp: Date.parse('2026-09-08T02:00:00Z'),
        deepLink: pullRequestLink.href,
        priority: 1,
        contributingRawEventIds: ['event-ci-passed', 'signal-ci-failed'],
      },
    ]

    expect(normalizeNotificationStories(events)).toEqual(expected)
    expect(normalizeNotificationStories([...events].reverse())).toEqual(
      expected,
    )
  })

  it.each([
    {
      initialTitle: 'deployment started',
      terminalTitle: 'deployment succeeded',
      storyTitle: 'deployment completed',
      objectType: 'deployment',
    },
    {
      initialTitle: 'review requested',
      terminalTitle: 'review submitted',
      storyTitle: 'review completed',
      objectType: 'pull-request',
    },
  ])(
    'collapses $initialTitle and $terminalTitle into $storyTitle',
    ({ initialTitle, terminalTitle, storyTitle, objectType }) => {
      const events = [
        {
          'event-id': 'initial',
          title: initialTitle,
          repository: 'octo/widgets',
          objectType,
          objectId: '42',
          timestamp: '2026-09-08T01:00:00Z',
        },
        {
          'event-id': 'terminal',
          title: terminalTitle,
          detail: 'The transition finished successfully.',
          repository: 'octo/widgets',
          objectType,
          objectId: '42',
          timestamp: '2026-09-08T02:00:00Z',
        },
      ]

      expect(normalizeNotificationStories(events)[0]).toMatchObject({
        title: storyTitle,
        detail: 'The transition finished successfully.',
        contributingRawEventIds: ['initial', 'terminal'],
      })
    },
  )

  it('keeps a failure actionable when it is the latest state', () => {
    const events = [
      {
        'event-id': 'initial-ci-failed',
        title: 'CI failed',
        repository: 'octo/widgets',
        objectType: 'pull-request',
        objectId: '42',
        timestamp: '2026-09-08T01:00:00Z',
      },
      {
        'event-id': 'ci-passed',
        title: 'CI passed',
        repository: 'octo/widgets',
        objectType: 'pull-request',
        objectId: '42',
        timestamp: '2026-09-08T02:00:00Z',
      },
      {
        'event-id': 'ci-failed',
        classification: 'runtime-failure',
        title: 'CI failed',
        detail: 'The newest run failed.',
        repository: 'octo/widgets',
        objectType: 'pull-request',
        objectId: '42',
        timestamp: '2026-09-08T03:00:00Z',
      },
    ]

    expect(normalizeNotificationStories(events)[0]).toMatchObject({
      classification: 'needs_you',
      title: 'CI failed',
      detail: 'The newest run failed.',
      contributingRawEventIds: ['ci-failed', 'ci-passed', 'initial-ci-failed'],
    })
  })

  it('does not infer transitions from events without a strict time order', () => {
    const events = [
      {
        'event-id': 'z-initial',
        title: 'deployment started',
        repository: 'octo/widgets',
        objectType: 'deployment',
        objectId: '42',
        timestamp: '2026-09-08T01:00:00Z',
      },
      {
        'event-id': 'a-terminal',
        title: 'deployment succeeded',
        repository: 'octo/widgets',
        objectType: 'deployment',
        objectId: '42',
        timestamp: '2026-09-08T01:00:00Z',
      },
    ]

    expect(normalizeNotificationStories(events)[0]?.title).toBe(
      'deployment succeeded',
    )
  })

  it('does not replace security finding titles with transition summaries', () => {
    const events = [
      {
        'event-id': 'review-requested',
        title: 'review requested',
        repository: 'octo/widgets',
        objectType: 'security-finding',
        objectId: 'secret-scanning:7',
        timestamp: '2026-09-08T01:00:00Z',
      },
      {
        'event-id': 'review-submitted',
        title: 'review submitted',
        repository: 'octo/widgets',
        objectType: 'security-finding',
        objectId: 'secret-scanning:7',
        timestamp: '2026-09-08T02:00:00Z',
      },
    ]

    expect(normalizeNotificationStories(events)[0]).toMatchObject({
      title: 'review submitted',
      contributingRawEventIds: ['review-requested', 'review-submitted'],
    })
  })

  it('keeps story IDs stable across refreshes and does not merge unrelated objects', () => {
    const firstRefresh = [
      {
        'event-id': 'run-started',
        classification: 'workflow-run',
        title: 'CI started',
        repository: 'octo/widgets',
        timestamp: '2026-09-08T01:00:00Z',
        'run-link': {
          relation: 'run',
          href: 'https://github.com/octo/widgets/actions/runs/9001',
          label: 'View run 9001',
        },
      },
    ]
    const secondRefresh = [
      {
        ...firstRefresh[0],
        'event-id': 'run-completed',
        title: 'CI completed',
        timestamp: '2026-09-08T02:00:00Z',
      },
      firstRefresh[0],
      {
        'event-id': 'other-run',
        classification: 'workflow-run',
        title: 'Deploy completed',
        repository: 'octo/widgets',
        objectType: 'workflow-run',
        objectId: '9002',
        timestamp: '2026-09-08T03:00:00Z',
        deepLink: 'https://github.com/octo/widgets/actions/runs/9002',
      },
    ]

    const firstStory = normalizeNotificationStories(firstRefresh)[0]
    const refreshedStories = normalizeNotificationStories(secondRefresh)
    const refreshedStory = refreshedStories.find(
      (story) => story.objectId === '9001',
    )

    expect(refreshedStory?.id).toBe(firstStory.id)
    expect(refreshedStory?.contributingRawEventIds).toEqual([
      'run-completed',
      'run-started',
    ])
    expect(refreshedStories).toHaveLength(2)
    expect(new Set(refreshedStories.map((story) => story.id)).size).toBe(2)
  })

  it('does not mutate or remove raw events used as story evidence', () => {
    const events = [
      {
        'event-id': 'finding-7',
        classification: 'security-finding',
        title: 'Secret detected',
        detail: 'Review the detected credential.',
        repository: 'octo/widgets',
        objectType: 'security-finding',
        objectId: '7',
        timestamp: '2026-09-08T02:00:00Z',
        priority: 0,
        deepLink: 'https://github.com/octo/widgets/security/secret-scanning/7',
      },
    ]
    const snapshot = structuredClone(events)

    normalizeNotificationStories(events)

    expect(events).toEqual(snapshot)
  })

  it('does not merge matching local object IDs from different non-repository scopes', () => {
    const stories = normalizeNotificationStories([
      {
        'event-id': 'production-deploy',
        title: 'Production deployment',
        scope: 'production',
        objectType: 'deployment',
        objectId: '42',
      },
      {
        'event-id': 'staging-deploy',
        title: 'Staging deployment',
        scope: 'staging',
        objectType: 'deployment',
        objectId: '42',
      },
    ])

    expect(stories).toHaveLength(2)
    expect(stories.map((story) => story.title).sort()).toEqual([
      'Production deployment',
      'Staging deployment',
    ])
    expect(new Set(stories.map((story) => story.id)).size).toBe(2)
  })

  it('canonicalizes numeric IDs and keeps security alert namespaces separate', () => {
    const stories = normalizeNotificationStories([
      {
        id: 1,
        title: 'Issue updated',
        repository: 'octo/widgets',
        objectType: 'issue',
        objectId: 42,
        timestamp: '2026-09-08T01:00:00Z',
      },
      {
        id: 2,
        title: 'Issue updated again',
        repository: 'octo/widgets',
        objectType: 'issue',
        objectId: 42,
        timestamp: '2026-09-08T02:00:00Z',
      },
      {
        id: 3,
        title: 'Secret alert',
        deepLink: 'https://github.com/octo/widgets/security/secret-scanning/7',
        timestamp: '2026-09-08T03:00:00Z',
      },
      {
        id: 4,
        title: 'Code alert',
        deepLink: 'https://github.com/octo/widgets/security/code-scanning/7',
        timestamp: '2026-09-08T04:00:00Z',
      },
    ])

    expect(stories).toHaveLength(3)
    expect(
      stories.find((story) => story.objectType === 'issue')
        ?.contributingRawEventIds,
    ).toEqual(['1', '2'])
    expect(
      stories
        .filter((story) => story.objectType === 'security-finding')
        .map((story) => story.objectId),
    ).toEqual(['code-scanning:7', 'secret-scanning:7'])
  })

  it.each([
    [
      'mention',
      { classification: 'mention', title: 'You were mentioned' },
      'needs_you',
    ],
    [
      'review request',
      { 'signal-type': 'review', title: 'Review requested' },
      'needs_you',
    ],
    [
      'assignment',
      { 'event-type': 'assignment', title: 'Issue assigned' },
      'needs_you',
    ],
    [
      'unresolved failure',
      { 'run-conclusion': 'failure', title: 'CI failed' },
      'needs_you',
    ],
    [
      'security finding',
      {
        objectType: 'security-finding',
        objectId: '7',
        title: 'Secret detected',
      },
      'needs_you',
    ],
    [
      'operator action',
      {
        'expected-actor': 'operator',
        action: 'Approve rollout',
        title: 'Approval required',
      },
      'needs_you',
    ],
    [
      'resolved update',
      { classification: 'status-update', title: 'CI recovered' },
      'update',
    ],
    [
      'passive information',
      { classification: 'operational-value', title: 'Value measured' },
      'fyi',
    ],
  ])('classifies %s stories', (_name, event, classification) => {
    expect(
      normalizeNotificationStories([
        {
          'event-id': 'event-1',
          repository: 'octo/widgets',
          objectType: 'issue',
          objectId: '42',
          timestamp: '2026-09-08T01:00:00Z',
          ...event,
        },
      ])[0]?.classification,
    ).toBe(classification)
  })

  it('ranks by classification, consequence, recency, and stable identity', () => {
    const events = [
      {
        'event-id': 'fyi-newest',
        classification: 'operational-value',
        title: 'Value measured',
        repository: 'octo/widgets',
        objectType: 'workflow-run',
        objectId: '6',
        timestamp: '2026-09-08T06:00:00Z',
      },
      {
        'event-id': 'update-newer',
        classification: 'status-update',
        title: 'Deployment completed',
        repository: 'octo/widgets',
        objectType: 'deployment',
        objectId: '5',
        timestamp: '2026-09-08T05:00:00Z',
      },
      {
        'event-id': 'update-older',
        classification: 'status-update',
        title: 'Deployment started',
        repository: 'octo/widgets',
        objectType: 'deployment',
        objectId: '4',
        timestamp: '2026-09-08T04:00:00Z',
      },
      {
        'event-id': 'low-failure',
        classification: 'runtime-failure',
        title: 'CI failed',
        repository: 'octo/widgets',
        objectType: 'workflow-run',
        objectId: '3',
        'consequence-tier': 'low',
        timestamp: '2026-09-08T03:00:00Z',
      },
      {
        'event-id': 'critical-failure',
        classification: 'runtime-failure',
        title: 'Deploy failed',
        repository: 'octo/widgets',
        objectType: 'workflow-run',
        objectId: '2',
        severity: 'critical',
        timestamp: '2026-09-08T02:00:00Z',
      },
      {
        'event-id': 'security-finding',
        title: 'Secret detected',
        repository: 'octo/widgets',
        objectType: 'security-finding',
        objectId: '1',
        severity: 'critical',
        timestamp: '2026-09-08T02:00:00Z',
      },
    ]
    const expectedIds = ['1', '2', '3', '5', '4', '6']

    expect(
      normalizeNotificationStories(events).map((story) => story.objectId),
    ).toEqual(expectedIds)
    expect(
      normalizeNotificationStories([...events].reverse()).map(
        (story) => story.objectId,
      ),
    ).toEqual(expectedIds)
  })
})

describe('catch up queue construction', () => {
  const storyA = { id: 'story-a' }
  const storyB = { id: 'story-b' }
  const storyC = { id: 'story-c' }

  it('queues every story on the first construction and captures the initial size', () => {
    const { queue, size } = buildCatchUpQueue([storyA, storyB, storyC])

    expect(queue).toEqual(['story-a', 'story-b', 'story-c'])
    expect(size).toBe(3)
  })

  it('excludes stories already marked done or later, and they do not return after a refresh', () => {
    const previous = {
      queue: ['story-a', 'story-b', 'story-c'],
      size: 3,
      done: ['story-a'],
      later: ['story-b'],
    }

    const { queue, size } = buildCatchUpQueue(
      [storyA, storyB, storyC],
      previous,
    )

    expect(queue).toEqual(['story-c'])
    expect(size).toBe(3)
  })

  it('preserves the position of previously queued stories and appends newly discovered ones', () => {
    const previous = {
      queue: ['story-b', 'story-a'],
      size: 2,
      done: [],
      later: [],
    }

    const { queue, size } = buildCatchUpQueue(
      [storyA, storyB, storyC],
      previous,
    )

    expect(queue).toEqual(['story-b', 'story-a', 'story-c'])
    expect(size).toBe(3)
  })

  it('does not reset progress when new events arrive alongside already-processed stories', () => {
    const previous = {
      queue: ['story-a', 'story-b'],
      size: 2,
      done: ['story-a'],
      later: [],
    }

    const { queue, size } = buildCatchUpQueue(
      [storyA, storyB, storyC],
      previous,
    )

    expect(queue).toEqual(['story-b', 'story-c'])
    expect(size).toBe(3)
  })

  it('advances the total when a new story arrives after the prior queue is complete', () => {
    const previous = {
      queue: [],
      size: 2,
      done: ['story-a'],
      later: ['story-b'],
    }

    const { queue, size } = buildCatchUpQueue(
      [storyA, storyB, storyC],
      previous,
    )

    expect(queue).toEqual(['story-c'])
    expect(size).toBe(3)
  })

  it('does not grow the total when a previously seen story reappears', () => {
    const previous = {
      queue: [],
      size: 3,
      seen: ['story-a', 'story-b', 'story-c'],
      done: ['story-a'],
      later: ['story-b'],
    }

    const { queue, size } = buildCatchUpQueue(
      [storyA, storyB, storyC],
      previous,
    )

    expect(queue).toEqual(['story-c'])
    expect(size).toBe(3)
  })

  it('does not double-count a returning story while migrating legacy state', () => {
    const previous = {
      queue: [],
      size: 3,
      done: ['story-a'],
      later: ['story-b'],
    }

    const { queue, size } = buildCatchUpQueue(
      [storyA, storyB, storyC],
      previous,
    )

    expect(queue).toEqual(['story-c'])
    expect(size).toBe(3)
  })

  it('drops queued stories that disappear from the current data without shrinking the recorded size', () => {
    const previous = {
      queue: ['story-a', 'story-b', 'story-c'],
      size: 3,
      done: [],
      later: [],
    }

    const { queue, size } = buildCatchUpQueue([storyA, storyC], previous)

    expect(queue).toEqual(['story-a', 'story-c'])
    expect(size).toBe(3)
  })
})
