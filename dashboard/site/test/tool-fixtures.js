/** Static aggregate fixtures; callers provide owning Run and observed identity. */
export const publishedToolMeasures = {
  'evidence-revision': 'tool-evidence-revision:fixture',
  'event-count': 1, 'call-count': 1, 'outcome-count': 0,
  'success-count': 0, 'failed-count': 0, 'incomplete-count': 0, 'unknown-outcome-count': 0,
  'unmatched-count': 1, 'ambiguous-count': 0, 'request-bytes': 0, 'request-bytes-count': 0,
  'response-bytes': 0, 'response-bytes-count': 0, 'latency-sum': 0, 'latency-count': 0
};

export const canonicalToolMeasures = {
  evidenceRevision: 'tool-evidence-revision:fixture',
  eventCount: 1, callCount: 1, outcomeCount: 0,
  successCount: 0, failedCount: 0, incompleteCount: 0, unknownOutcomeCount: 0,
  unmatchedCount: 1, ambiguousCount: 0, requestBytes: 0, requestBytesCount: 0,
  responseBytes: 0, responseBytesCount: 0, latencySum: 0, latencyCount: 0
};
