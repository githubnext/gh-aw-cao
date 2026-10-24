// Additive storage extension, intentionally outside the native detail digest.
namespace Cao.Postgres.Daily;

model dailyRunCounts {
  `namespace`: string;
  id: string;
  day: string;
  repositoryId: string;
  workflowId: string;
  owner: string;
  repository: string;
  workflowPath: string;
  total: int64;
  successful: int64;
  failed: int64;
  approval: int64;
  pending: int64;
  other: int64;
}

model runCountContributions {
  `namespace`: string;
  id: string;
  repositoryId: string;
  workflowId: string;
  owner?: string;
  repository?: string;
  workflowPath?: string;
  startedAt?: utcDateTime;
  attempt?: int64;
  status?: string;
  conclusion?: string;
  updatedAt?: utcDateTime;
  completedAt?: utcDateTime;
  observedAt: utcDateTime;
  retentionAt?: utcDateTime;
  knownFields: int64;
  conflict: boolean;
}

model dailyRunCountState {
  `namespace`: string;
  id: string;
  initializedAt: utcDateTime;
  watermarkAt: utcDateTime;
  cutoffAt: utcDateTime;
}
