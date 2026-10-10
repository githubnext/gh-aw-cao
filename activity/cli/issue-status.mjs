import { spawnSync } from 'node:child_process';
import { readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readCollection } from '../../dashboard/site/src/data/storage/indexeddb.js';
import { option, boundedPositiveInteger, nonNegativeInteger } from './options.mjs';
import { jsonlLines } from './files.mjs';
import { githubEntityUrl } from './queries.mjs';

const DEFAULT_ISSUE_STATUS_BATCH_SIZE = 50;

const DEFAULT_ISSUE_STATUS_GRAPHQL_COST_BUDGET = 25;

const DEFAULT_ISSUE_STATUS_GRAPHQL_MIN_REMAINING = 500;

function graphqlDocument(query, variables = {}) {
  const arguments_ = ['api', 'graphql', '-f', `query=${query}`];
  for (const [name, value] of Object.entries(variables)) {
    arguments_.push('-f', `${name}=${value}`);
  }
  const result = spawnSync('gh', arguments_, {
    encoding: 'utf8',
    env: { ...process.env, GH_PAGER: 'cat' },
    maxBuffer: 16 * 1024 * 1024
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`GitHub GraphQL query failed: ${String(result.stderr || result.stdout).trim() || `exit ${result.status}`}`);
  }
  let document;
  try {
    document = JSON.parse(result.stdout);
  } catch {
    throw new Error('GitHub GraphQL query returned invalid JSON');
  }
  if (Array.isArray(document.errors) && document.errors.length > 0) {
    throw new Error(`GitHub GraphQL query failed: ${document.errors.map((error) => error.message).join('; ')}`);
  }
  return document;
}

function graphqlRateLimit(document) {
  const rateLimit = document?.data?.rateLimit;
  if (![rateLimit?.cost, rateLimit?.remaining].every(Number.isSafeInteger)) {
    throw new Error('GitHub GraphQL response did not include rate-limit cost and remaining points');
  }
  return {
    cost: rateLimit.cost,
    remaining: rateLimit.remaining,
    resetAt: typeof rateLimit.resetAt === 'string' ? rateLimit.resetAt : null
  };
}

function issueStatusKey(repository, number) {
  return `${repository.toLowerCase()}#${number}`;
}

function issueStatusTargets(issues) {
  const targets = new Map();
  for (const issue of issues) {
    if (issue.isPullRequest === true) continue;
    const repository = String(issue.repositoryFullName ?? (
      typeof issue.owner === 'string' && typeof issue.repository === 'string'
        ? `${issue.owner}/${issue.repository}`
        : ''
    ));
    const number = Number(issue.number);
    if (!repository.includes('/') || !Number.isSafeInteger(number) || number < 1) continue;
    const [owner, ...repositoryParts] = repository.split('/');
    const name = repositoryParts.join('/');
    if (!owner || !name || name.includes('/')) continue;
    targets.set(issueStatusKey(repository, number), {
      owner,
      name,
      repository: `${owner}/${name}`,
      number,
      statusObservedAt: issue.statusObservedAt
    });
  }
  return [...targets.values()].sort((left, right) => {
    const leftObserved = Date.parse(String(left.statusObservedAt ?? ''));
    const rightObserved = Date.parse(String(right.statusObservedAt ?? ''));
    const freshness = (Number.isFinite(leftObserved) ? leftObserved : Number.NEGATIVE_INFINITY)
      - (Number.isFinite(rightObserved) ? rightObserved : Number.NEGATIVE_INFINITY);
    return freshness || left.repository.localeCompare(right.repository) || left.number - right.number;
  });
}

export function issueStatusQuery(batch) {
  const fields = batch.map((target, index) => (
    `i${index}: issueOrPullRequest(number: ${target.number}) { ... on Issue { number state stateReason closedAt url } }`
  )).join('\n');
  return `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    ${fields}
  }
  rateLimit { cost remaining resetAt }
}`;
}

async function applyIssueStatuses(directory, statuses) {
  let updatedFiles = 0;
  let updatedRecords = 0;
  const names = (await readdir(directory)).filter((name) => name.endsWith('.jsonl')).sort();
  for (const name of names) {
    const filePath = path.join(directory, name);
    const lines = [];
    let changed = false;
    for await (const line of jsonlLines([filePath])) {
      const envelope = JSON.parse(line);
      const entity = envelope?.kind === 'safe_output_item'
        ? githubEntityUrl(envelope.safe_output?.url)
        : undefined;
      const status = entity && !entity.url.includes('/pull/')
        ? statuses.get(issueStatusKey(entity.repository, entity.number))
        : undefined;
      if (status) {
        envelope.safe_output = { ...envelope.safe_output, github_issue_status: status };
        changed = true;
        updatedRecords += 1;
        lines.push(JSON.stringify(envelope));
      } else {
        lines.push(line);
      }
    }
    if (!changed) continue;
    const temporaryPath = `${filePath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, `${lines.join('\n')}\n`, { flag: 'wx' });
    await rename(temporaryPath, filePath);
    updatedFiles += 1;
  }
  return { updatedFiles, updatedRecords };
}

export async function updateIssueStatuses(indexedDB, inputDirectory, options) {
  const batchSize = boundedPositiveInteger(
    option(options, 'batch-size', false),
    'batch-size',
    DEFAULT_ISSUE_STATUS_BATCH_SIZE,
    100
  );
  const costBudget = boundedPositiveInteger(
    option(options, 'graphql-cost-budget', false),
    'graphql-cost-budget',
    DEFAULT_ISSUE_STATUS_GRAPHQL_COST_BUDGET,
    5000
  );
  const minimumRemaining = nonNegativeInteger(
    option(options, 'graphql-min-remaining', false),
    'graphql-min-remaining',
    DEFAULT_ISSUE_STATUS_GRAPHQL_MIN_REMAINING
  );
  const targets = issueStatusTargets(await readCollection(indexedDB, 'issues'));
  if (targets.length === 0) {
    return {
      command: 'issue-status',
      issues: 0,
      queried: 0,
      statuses: 0,
      updatedFiles: 0,
      updatedRecords: 0,
      rateLimit: {
        budget: costBudget,
        cost: 0,
        minimumRemaining,
        remaining: null,
        resetAt: null
      },
      stopped: null,
      errors: []
    };
  }
  const initialDocument = graphqlDocument('query { rateLimit { cost remaining resetAt } }');
  let rateLimit = graphqlRateLimit(initialDocument);
  let cost = rateLimit.cost;
  const statuses = new Map();
  const errors = [];
  let queried = 0;
  let stopped = null;

  const byRepository = Map.groupBy(targets, (target) => target.repository);
  outer: for (const repositoryTargets of byRepository.values()) {
    for (let offset = 0; offset < repositoryTargets.length; offset += batchSize) {
      if (cost + 1 > costBudget) {
        stopped = 'cost-budget';
        break outer;
      }
      if (rateLimit.remaining - 1 < minimumRemaining) {
        stopped = 'remaining-floor';
        break outer;
      }
      const batch = repositoryTargets.slice(offset, offset + batchSize);
      const [{ owner, name, repository }] = batch;
      let document;
      try {
        document = graphqlDocument(issueStatusQuery(batch), { owner, name });
      } catch (error) {
        errors.push({
          repository,
          message: error instanceof Error ? error.message : String(error)
        });
        stopped = 'query-error';
        break outer;
      }
      rateLimit = graphqlRateLimit(document);
      cost += rateLimit.cost;
      const result = document.data?.repository;
      for (let index = 0; index < batch.length; index += 1) {
        queried += 1;
        const issue = result?.[`i${index}`];
        if (!issue) continue;
        const target = batch[index];
        statuses.set(issueStatusKey(target.repository, target.number), {
          state: issue.state,
          closed: issue.state === 'CLOSED',
          state_reason: issue.stateReason ?? null,
          closed_at: issue.closedAt ?? null,
          observed_at: new Date().toISOString()
        });
      }
      if (cost > costBudget) {
        stopped = 'cost-budget';
        break outer;
      }
    }
  }

  const updates = await applyIssueStatuses(path.resolve(inputDirectory), statuses);
  return {
    command: 'issue-status',
    issues: targets.length,
    queried,
    statuses: statuses.size,
    ...updates,
    rateLimit: {
      budget: costBudget,
      cost,
      minimumRemaining,
      remaining: rateLimit.remaining,
      resetAt: rateLimit.resetAt
    },
    stopped,
    errors
  };
}
