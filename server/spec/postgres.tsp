/**
 * Physical PostgreSQL storage contract, separate from the public HTTP canonical
 * row contract. Optional presence is tracked independently from SQL NULL.
 */
namespace Cao.Postgres;

/** Source registry and resource accounting, scoped to a tenant. */
model Source {
  `namespace`: string;
  sourceName: string;
  estimatedBytes?: int64;
  /** Only explicitly registered canonical sources use the native row table. */
  isCanonical: boolean;
  /** Field/type diagnostic for a canonical source retaining legacy storage. */
  storageFallbackReason?: string | null;
}

/** Known canonical columns are never copied into the extension object. */
model CanonicalRow {
  `namespace`: string;
  sourceName: string;
  ordinal: int64;
  /** Names of present known fields; distinguishes missing from explicit null. */
  present: string[];
  /** Open fields only; SQL JSON preserves exceptional numeric lexemes that JSONB cannot store. */
  extension: Record<unknown>;
  /** Canonical identity; indexed with the namespace and source. */
  id?: string | null;
  /** Owning run relationship; indexed with the namespace and source. */
  runId?: string | null;
  /** Owning session relationship; indexed with the namespace and source. */
  sessionId?: string | null;
  /** Owning repository relationship. */
  repositoryId?: string | null;
  /** Owning workflow relationship. */
  workflowId?: string | null;
  owner?: string | null;
  repository?: string | null;
  name?: string | null;
  fullName?: string | null;
  path?: string | null;
  visibility?: string | null;
  state?: string | null;
  campaign?: string | null;
  campaignId?: string | null;
  headSha?: string | null;
  headBranch?: string | null;
  source?: string | null;
  sourceId?: string | null;
  repositoryFullName?: string | null;
  slug?: string | null;
  url?: string | null;
  type?: string | null;
  category?: string | null;
  correlationId?: string | null;
  description?: string | null;
  icon?: string | null;
  mode?: string | null;
  domain?: string | null;
  decision?: string | null;
  toolType?: string | null;
  mcpServer?: string | null;
  mcpTool?: string | null;
  safeOutputType?: string | null;
  githubEntityType?: string | null;
  summary?: string | null;
  payloadRef?: string | null;
  targetRepo?: string | null;
  targetOrganization?: string | null;
  targetRepository?: string | null;
  rolloutMode?: string | null;
  campaignName?: string | null;
  campaignIcon?: string | null;
  role?: string | null;
  workflowPath?: string | null;
  title?: string | null;
  branch?: string | null;
  engine?: string | null;
  engineVersion?: string | null;
  requestedModel?: string | null;
  resolvedModel?: string | null;
  modelId?: string | null;
  /** Scalar href columns reconstruct the known `{href}` link object on read. */
  organizationHref?: string | null;
  repositoryHref?: string | null;
  workflowHref?: string | null;
  runHref?: string | null;
  status?: string | null;
  conclusion?: string | null;
  event?: string | null;
  createdAt?: utcDateTime | null;
  startedAt?: utcDateTime | null;
  completedAt?: utcDateTime | null;
  updatedAt?: utcDateTime | null;
  observedAt?: utcDateTime | null;
  timestamp?: utcDateTime | null;
  /** PostgreSQL timestamps have microsecond resolution; text preserves exceptional original lexemes. */
  createdAtRaw?: string | null;
  startedAtRaw?: string | null;
  completedAtRaw?: string | null;
  updatedAtRaw?: string | null;
  observedAtRaw?: string | null;
  timestampRaw?: string | null;
  attempt?: decimal | null;
  sequence?: decimal | null;
  /** Column issue_number; distinct from canonical numeric key number. */
  number?: decimal | null;
  durationMs?: decimal | null;
  requestCount?: decimal | null;
  workerCount?: decimal | null;
  aicTotal?: decimal | null;
  /** Numeric lexemes may exceed PostgreSQL NUMERIC's range or differ in formatting. */
  attemptRaw?: string | null;
  sequenceRaw?: string | null;
  numberRaw?: string | null;
  durationMsRaw?: string | null;
  requestCountRaw?: string | null;
  workerCountRaw?: string | null;
  aicTotalRaw?: string | null;
  enabled?: boolean | null;
  isSkill?: boolean | null;
  isPullRequest?: boolean | null;
  /** Provider IDs accept both JSON numbers and strings; kind preserves the input type. */
  githubId?: string | null;
  githubIdKind?: "string" | "number" | null;
  githubIdNumeric?: decimal | null;
  githubRunId?: string | null;
  githubRunIdKind?: "string" | "number" | null;
  githubRunIdNumeric?: decimal | null;
}
