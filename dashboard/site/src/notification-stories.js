const LINK_FIELDS = [
  'evidence-link',
  'run-link',
  'external-link',
  'pull-request-link',
  'issue-link',
  'deployment-link',
  'security-finding-link',
  'repository-link'
];

const TRANSITION_RULES = [
  { initial: 'ci failed', terminal: 'ci passed', title: 'CI recovered' },
  { initial: 'deployment started', terminal: 'deployment succeeded', title: 'deployment completed' },
  { initial: 'review requested', terminal: 'review submitted', title: 'review completed' }
];

const STORY_CLASS_RANK = new Map([
  ['needs_you', 0],
  ['update', 1],
  ['fyi', 2]
]);

const CONSEQUENCE_RANK = new Map([
  ['critical', 0],
  ['high', 1],
  ['medium', 2],
  ['moderate', 2],
  ['warning', 2],
  ['low', 3],
  ['informational', 4],
  ['info', 4]
]);

/** @param {unknown} value */
function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** @param {unknown} value */
function normalizedText(value) {
  return text(value).toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
}

/** @param {unknown} value */
function identifier(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return text(value);
}

/** @param {unknown} value */
function numericPriority(value) {
  if (value === null || value === undefined || value === '') return null;
  const priority = Number(value);
  return Number.isFinite(priority) ? priority : null;
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {unknown} value */
function safeHref(value) {
  const href = text(value);
  if (href.startsWith('#page-')) return href;
  try {
    return new URL(href).protocol === 'https:' ? href : '';
  } catch {
    return '';
  }
}

/** @param {Record<string, unknown>} event */
function eventTimestamp(event) {
  const value = event.timestamp ?? event['observed-at'] ?? event['published-at']
    ?? event['ended-at'] ?? event['started-at'];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const timestamp = Date.parse(text(value));
  return Number.isFinite(timestamp) ? timestamp : 0;
}

/** @param {Record<string, unknown>} event */
function eventDeepLink(event) {
  const direct = safeHref(event.deepLink ?? event['deep-link']);
  if (direct) return direct;
  for (const field of LINK_FIELDS) {
    const link = event[field];
    if (!isRecord(link)) continue;
    const dashboardHref = safeHref(link['dashboard-href']);
    if (dashboardHref.startsWith('#page-')) return dashboardHref;
    const href = safeHref(link.href);
    if (href) return href;
  }
  return '';
}

/** @param {Record<string, unknown>} event */
function eventUrls(event) {
  return [
    text(event.deepLink ?? event['deep-link']),
    ...LINK_FIELDS.map((field) => {
      const link = event[field];
      return isRecord(link) ? text(link.href) : '';
    })
  ].filter(Boolean);
}

/** @param {Record<string, unknown>} event */
function eventRepository(event) {
  const explicit = text(event.repository);
  const organization = text(event.organization);
  if (organization && explicit && !explicit.includes('/')) return `${organization}/${explicit}`;
  if (/^[^/\s]+\/[^/\s]+$/.test(explicit)) return explicit;
  const scope = text(event.scope);
  if (/^[^/\s]+\/[^/\s]+$/.test(scope)) return scope;
  for (const href of eventUrls(event)) {
    try {
      const url = new URL(href);
      const [owner, repository] = url.pathname.split('/').filter(Boolean);
      if (url.hostname === 'github.com' && owner && repository) return `${owner}/${repository}`;
    } catch {
      // Ignore malformed raw links when deriving identity.
    }
  }
  return '';
}

/** @param {Record<string, unknown>} event */
function rawEventId(event) {
  const explicit = identifier(event['event-id'] ?? event.eventId ?? event.id
    ?? event['attention-signal-id'] ?? event['safe-output'] ?? event.finding
    ?? event['observation-id'] ?? event['smell-observation-id']);
  if (explicit) return explicit;
  return `event:${encodeURIComponent([
    eventRepository(event),
    text(event.title ?? event.objective ?? event['outcome-title'] ?? event['finding-summary']),
    eventTimestamp(event)
  ].join(':'))}`;
}

/** @param {string} href */
function linkedObject(href) {
  try {
    const url = new URL(href);
    if (url.hostname !== 'github.com') return null;
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[2] === 'pull' && parts[3]) return { objectType: 'pull-request', objectId: parts[3] };
    if (parts[2] === 'issues' && parts[3]) return { objectType: 'issue', objectId: parts[3] };
    if (parts[2] === 'actions' && parts[3] === 'runs' && parts[4]) return { objectType: 'workflow-run', objectId: parts[4] };
    if (parts[2] === 'deployments' && parts[3]) return { objectType: 'deployment', objectId: parts[3] };
    const securityFindingId = parts.slice(3).join(':');
    if (parts[2] === 'security' && securityFindingId) return { objectType: 'security-finding', objectId: securityFindingId };
  } catch {
    return null;
  }
  return null;
}

/** @param {Record<string, unknown>} event @returns {{ objectType: string, objectId: string }} */
function eventObject(event) {
  const objectType = text(event.objectType ?? event['object-type']);
  const objectId = identifier(event.objectId ?? event['object-id']);
  if (objectType && objectId) return { objectType, objectId };

  for (const href of eventUrls(event)) {
    const linked = linkedObject(href);
    if (linked) return linked;
  }

  const outcomeType = text(event['outcome-category']);
  const outcomeId = identifier(event['outcome-number'] ?? event['safe-output']);
  if (['pull-request', 'issue'].includes(outcomeType) && outcomeId) {
    return { objectType: outcomeType, objectId: outcomeId };
  }
  const findingId = identifier(event.finding ?? event['smell-observation-id']);
  if (findingId) return { objectType: 'security-finding', objectId: findingId };
  const runId = identifier(event.run);
  if (runId) return { objectType: 'workflow-run', objectId: runId };
  const workItemId = identifier(event['work-item-id']);
  if (workItemId) return { objectType: 'work-item', objectId: workItemId };
  return { objectType: 'event', objectId: rawEventId(event) };
}

/** @param {Record<string, unknown>} event */
function eventTitle(event) {
  return text(event.title ?? event.objective ?? event['outcome-title']
    ?? event['finding-summary'] ?? event['workflow-name']) || 'Notification';
}

/** @param {Record<string, unknown>} event */
function eventSourceType(event) {
  return text(event.classification ?? event['signal-type'] ?? event['event-type']
    ?? event['outcome-state'] ?? event.type);
}

/** @param {Record<string, unknown>} event */
function eventDetail(event) {
  return text(event.detail ?? event.reason ?? event['outcome-summary']
    ?? event['smell-summary']) || 'No additional detail';
}

/** @param {Record<string, unknown>[]} events @param {string} objectType */
function storyTitle(events, objectType) {
  const latest = events[0];
  const latestTitle = eventTitle(latest);
  if (objectType === 'security-finding') return latestTitle;

  const latestTimestamp = eventTimestamp(latest);
  if (!latestTimestamp) return latestTitle;

  const terminal = latestTitle.toLowerCase();
  const rule = TRANSITION_RULES.find((candidate) => candidate.terminal === terminal);
  if (!rule) return latestTitle;

  const prior = events.slice(1).find((event) => {
    const timestamp = eventTimestamp(event);
    if (timestamp <= 0 || timestamp >= latestTimestamp) return false;
    const title = eventTitle(event).toLowerCase();
    return title === rule.initial || title === rule.terminal;
  });

  const priorTitle = prior ? eventTitle(prior).toLowerCase() : '';
  return priorTitle === rule.initial ? rule.title : latestTitle;
}

/**
 * @param {Record<string, unknown>} event
 * @param {string} objectType
 * @param {string} title
 * @returns {'needs_you' | 'update' | 'fyi'}
 */
function storyClassification(event, objectType, title) {
  const state = [
    event.classification,
    event['signal-type'],
    event['event-type'],
    event['outcome-state'],
    event['run-conclusion'],
    event['lifecycle-state'],
    event.type
  ].map(normalizedText).filter(Boolean).join(' ');
  const summary = normalizedText(`${eventTitle(event)} ${text(event.action ?? event['next-action'])}`);
  const actor = normalizedText(event['expected-actor']);
  const resolved = /\b(?:accepted|closed|completed|passed|recovered|resolved|submitted|succeeded|success)\b/
    .test(`${state} ${normalizedText(title)}`);

  if (objectType === 'security-finding' || /\bsecurity (?:finding|alert)\b/.test(state)) return 'needs_you';
  if (resolved) return 'update';
  if (/\b(?:action required|blocked|failure|failed|pending|timed out)\b/.test(state)
      || /\b(?:failure|failed|failing|timed out)\b/.test(summary)
      || /\b(?:mention(?:ed|s)?|review|assign(?:ed|ment|s)?)\b/.test(`${state} ${summary}`)
      || /\b(?:human|maintainer|operator|owner|reviewer|user)\b/.test(actor)) {
    return 'needs_you';
  }
  if (/\b(?:lifecycle close|status update|update|workflow run)\b/.test(state)
      || /\b(?:changed|started|updated)\b/.test(summary)) {
    return 'update';
  }
  return 'fyi';
}

/** @param {Record<string, unknown>[]} events */
function consequenceRank(events) {
  const declaredRanks = events.flatMap((event) => [
    event['consequence-tier'],
    event.consequence,
    event.severity,
    event['finding-severity'],
    event['smell-severity']
  ]).map((value) => CONSEQUENCE_RANK.get(normalizedText(value)))
    .filter((value) => value !== undefined);
  if (declaredRanks.length > 0) return Math.min(...declaredRanks);

  const priorities = events.map((event) => numericPriority(event.priority)).filter((value) => value !== null);
  return priorities.length > 0 ? Math.min(...priorities) : Number.MAX_SAFE_INTEGER;
}

/**
 * Groups raw attention and operational events into stable object-level stories.
 * @param {Record<string, unknown>[]} rawEvents
 */
export function normalizeNotificationStories(rawEvents) {
  /** @type {Map<string, { repository: string, objectType: string, objectId: string, events: Record<string, unknown>[] }>} */
  const groups = new Map();
  for (const event of rawEvents) {
    const repository = eventRepository(event);
    const { objectType, objectId } = eventObject(event);
    const key = JSON.stringify([repository, objectType, objectId]);
    const group = groups.get(key) ?? {
      repository,
      objectType,
      objectId,
      events: /** @type {Record<string, unknown>[]} */ ([])
    };
    group.events.push(event);
    groups.set(key, group);
  }

  return [...groups.values()].map((group) => {
    const events = [...group.events].sort((left, right) => (
      eventTimestamp(right) - eventTimestamp(left)
      || rawEventId(left).localeCompare(rawEventId(right))
    ));
    const latest = events[0];
    const deepLinkEvent = events.find((event) => eventDeepLink(event));
    const priorities = events.map((event) => numericPriority(event.priority)).filter((value) => value !== null);
    const title = storyTitle(events, group.objectType);
    return {
      consequence: consequenceRank(events),
      story: {
        id: `notification-story:${encodeURIComponent(group.repository)}:${encodeURIComponent(group.objectType)}:${encodeURIComponent(group.objectId)}`,
        classification: storyClassification(latest, group.objectType, title),
        sourceType: eventSourceType(latest),
        title,
        detail: eventDetail(latest),
        repository: group.repository,
        objectType: group.objectType,
        objectId: group.objectId,
        timestamp: eventTimestamp(latest),
        deepLink: deepLinkEvent ? eventDeepLink(deepLinkEvent) : '',
        priority: priorities.length > 0 ? Math.min(...priorities) : null,
        contributingRawEventIds: [...new Set(events.map(rawEventId))].sort()
      }
    };
  }).sort((left, right) => (
    (STORY_CLASS_RANK.get(left.story.classification) ?? Number.MAX_SAFE_INTEGER)
      - (STORY_CLASS_RANK.get(right.story.classification) ?? Number.MAX_SAFE_INTEGER)
    || left.consequence - right.consequence
    || right.story.timestamp - left.story.timestamp
    || left.story.id.localeCompare(right.story.id)
  )).map(({ story }) => story);
}
