import { executeDashboardQuery, queryInputNames } from '../../dashboard/site/src/data/queries/declarative.js';
import { readCollection, readRecord, readTransactions } from '../../dashboard/site/src/data/storage/indexeddb.js';
import { DEFAULT_GH_LIMIT, QUERY_COLLECTIONS } from '../cli-usage.mjs';
import { DAY_MS, UsageError, option, queryLimit } from './options.mjs';

const GH_RESOURCES = new Set(['runs', 'issues', 'prs']);

function fieldValue(record, field) {
  return field.split('.').reduce((value, part) => (
    value && typeof value === 'object'
      ? /** @type {Record<string, unknown>} */ (value)[part]
      : undefined
  ), record);
}

function filters(options) {
  const values = options.where;
  if (!values) return [];
  return (Array.isArray(values) ? values : [values]).map((filter) => {
    const separator = filter.indexOf('=');
    if (separator < 1) throw new UsageError(`Invalid --where value: ${filter}`);
    return {
      field: filter.slice(0, separator),
      value: filter.slice(separator + 1)
    };
  });
}

function ghQueryLimit(options) {
  return queryLimit(options) ?? DEFAULT_GH_LIMIT;
}

function timeBoundary(options, name) {
  const value = option(options, name, false);
  if (!value) return undefined;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new UsageError(`--${name} must be a valid ISO 8601 time`);
  if (name === 'until' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return timestamp + DAY_MS - 1;
  return timestamp;
}

function ghTimeRange(options) {
  const since = timeBoundary(options, 'since');
  const until = timeBoundary(options, 'until');
  if (since !== undefined && until !== undefined && since > until) {
    throw new UsageError('--since must not be later than --until');
  }
  return { since, until };
}

export async function queryCanonicalData(indexedDB, options) {
  const collection = option(options, 'collection');
  if (!QUERY_COLLECTIONS.includes(collection)) {
    throw new Error(`Unknown collection: ${collection}`);
  }

  const id = option(options, 'id', false);
  let records;
  if (id && collection !== 'transactions') {
    const record = await readRecord(indexedDB, collection, id);
    records = record ? [record] : [];
  } else {
    records = collection === 'transactions'
      ? await readTransactions(indexedDB)
      : await readCollection(indexedDB, collection);
    if (id) records = records.filter((record) => record.id === id);
  }

  for (const filter of filters(options)) {
    records = records.filter((record) => String(fieldValue(record, filter.field)) === filter.value);
  }
  const limit = queryLimit(options);
  return limit ? records.slice(0, limit) : records;
}

function normalizedWorkflowAliases(workflow) {
  return [workflow.id, workflow.name, workflow.path]
    .filter((value) => typeof value === 'string' && value)
    .flatMap((value) => {
      const normalized = value.toLowerCase();
      const basename = normalized.split('/').at(-1) ?? normalized;
      return [normalized, basename, basename.replace(/\.(?:md|ya?ml)$/, '')];
    });
}

function matchesWorkflow(workflow, value) {
  if (!value) return true;
  const normalized = value.toLowerCase();
  const basename = normalized.split('/').at(-1) ?? normalized;
  const aliases = normalizedWorkflowAliases(workflow);
  return aliases.includes(normalized)
    || aliases.includes(basename)
    || aliases.includes(basename.replace(/\.(?:md|ya?ml)$/, ''));
}

export function githubEntityUrl(value) {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    if (url.hostname.toLowerCase() !== 'github.com') return undefined;
    const match = url.pathname.match(/^\/([^/]+\/[^/]+)\/(issues|pull)\/(\d+)(?:\/|$)/);
    if (!match) return undefined;
    return { repository: match[1], number: Number(match[3]), url: value };
  } catch {
    return undefined;
  }
}

function recordTimestamp(record, fields) {
  for (const field of fields) {
    const timestamp = Date.parse(String(record[field] ?? ''));
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return Number.NEGATIVE_INFINITY;
}

function inTimeRange(timestamp, range) {
  return (range.since === undefined || timestamp >= range.since)
    && (range.until === undefined || timestamp <= range.until);
}

export async function queryGhData(indexedDB, resource, options) {
  if (!GH_RESOURCES.has(resource)) throw new Error(`Unknown gh resource: ${resource}`);
  const [repositories, workflows, runs, issues] = await Promise.all([
    readCollection(indexedDB, 'repositories'),
    readCollection(indexedDB, 'workflows'),
    readCollection(indexedDB, 'runs'),
    readCollection(indexedDB, 'issues')
  ]);
  const repositoryFilter = option(options, 'repo', false)?.toLowerCase();
  const workflowFilter = option(options, 'workflow', false);
  const range = ghTimeRange(options);
  const repositoriesById = new Map(repositories.map((record) => [record.id, record]));
  const workflowsById = new Map(workflows.map((record) => [record.id, record]));
  const runsById = new Map(runs.map((record) => [record.id, record]));
  const sourceRepository = (run) => repositoriesById.get(run.repositoryId) ?? {};
  const sourceWorkflow = (run) => workflowsById.get(run.workflowId) ?? {};

  let records;
  if (resource === 'runs') {
    const statusFilter = option(options, 'status', false)?.toLowerCase();
    records = runs.filter((run) => {
      const repository = sourceRepository(run);
      const workflow = sourceWorkflow(run);
      const fullName = (repository.owner && repository.name
        ? `${repository.owner}/${repository.name}`
        : `${String(run.owner ?? '')}/${String(run.repository ?? '')}`).toLowerCase();
      const timestamp = recordTimestamp(run, ['startedAt', 'createdAt', 'updatedAt', 'observedAt']);
      return (!repositoryFilter || fullName === repositoryFilter)
        && matchesWorkflow(workflow, workflowFilter)
        && (!statusFilter || [run.status, run.conclusion]
          .some((value) => String(value ?? '').toLowerCase() === statusFilter))
        && inTimeRange(timestamp, range);
    });
  } else {
    const safeOutputType = resource === 'issues' ? 'create_issue' : 'create_pull_request';
    records = issues
      .filter((event) => (
        event.type === 'safe_output.created'
        && event.isPullRequest === (resource === 'prs')
        && event.safeOutputType === safeOutputType
      ))
      .map((event) => {
        const run = runsById.get(event.runId) ?? {};
        const workflow = sourceWorkflow(run);
        const executionRepository = sourceRepository(run);
        const target = githubEntityUrl(event.correlationId);
        return {
          id: event.id,
          number: target?.number ?? null,
          repository: target?.repository ?? executionRepository.fullName ?? null,
          workflow: workflow.path ?? workflow.name ?? null,
          workflowName: workflow.name ?? null,
          workflowId: workflow.id ?? null,
          createdAt: event.timestamp ?? event.observedAt ?? null,
          url: target?.url ?? null,
          type: event.safeOutputType ?? null,
          status: event.status ?? null,
          summary: event.summary ?? null,
          runId: run.id ?? null,
          githubRunId: run.githubRunId ?? null
        };
      })
      .filter((record) => (
        (!repositoryFilter || String(record.repository ?? '').toLowerCase() === repositoryFilter)
        && matchesWorkflow({
          id: record.workflowId,
          path: record.workflow,
          name: record.workflowName
        }, workflowFilter)
        && inTimeRange(recordTimestamp(record, ['createdAt']), range)
      ));
  }

  const timestampFields = resource === 'runs'
    ? ['startedAt', 'createdAt', 'updatedAt', 'observedAt']
    : ['createdAt'];
  return records
    .sort((left, right) => recordTimestamp(right, timestampFields) - recordTimestamp(left, timestampFields))
    .slice(0, ghQueryLimit(options));
}

export async function queryRawCanonicalData(indexedDB, query) {
  const inputNames = queryInputNames(query);
  const unknown = inputNames.find((name) => !QUERY_COLLECTIONS.includes(name));
  if (unknown) throw new Error(`Unknown collection: ${unknown}`);
  const sources = Object.fromEntries(await Promise.all(inputNames.map(async (name) => [
    name,
    {
      source: name,
      rows: name === 'transactions'
        ? await readTransactions(indexedDB)
        : await readCollection(indexedDB, name),
      metadata: {
        'source-id': name,
        'source-kind': 'canonical-query',
        availability: 'available',
        completeness: 'complete',
        freshness: 'unknown'
      }
    }
  ])));
  const time = console.time;
  const timeEnd = console.timeEnd;
  let rows;
  try {
    console.time = () => {};
    console.timeEnd = () => {};
    const result = executeDashboardQuery(query, sources);
    if (result.metadata?.availability === 'unavailable') {
      throw new Error(String(result.metadata['query-diagnostic'] ?? 'Query is unavailable'));
    }
    rows = result.rows;
  } finally {
    console.time = time;
    console.timeEnd = timeEnd;
  }
  return rows;
}
