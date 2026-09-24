#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const REPOSITORY_COORDINATE = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/;

function fail(message) {
  console.error(message);
  process.exit(1);
}

const request = JSON.parse(readFileSync(0, 'utf8'));
if (
  request?.schemaVersion !== 1
  || typeof request.timestamp !== 'string'
  || !Array.isArray(request.repositories)
  || request.repositories.some((repository) => (
    typeof repository !== 'string' || !REPOSITORY_COORDINATE.test(repository)
  ))
) {
  fail('Invalid operational value request');
}

const minimumRemaining = Number(process.env.CAO_GITHUB_API_MIN_REMAINING ?? 0);
if (!Number.isSafeInteger(minimumRemaining) || minimumRemaining < 0) {
  fail('CAO_GITHUB_API_MIN_REMAINING must be a non-negative integer');
}

function ghApi(arguments_) {
  const result = spawnSync('gh', ['api', ...arguments_], {
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 16 * 1024 * 1024
  });
  if (result.error || result.status !== 0) {
    fail((result.stderr || '').trim() || result.error?.message || 'gh api failed');
  }
  return result.stdout;
}

for (const repository of request.repositories) {
  let page = 1;
  let value = 0;
  while (true) {
    if (minimumRemaining > 0) {
      const remaining = Number(ghApi(['rate_limit', '--jq', '.resources.core.remaining']).trim());
      if (!Number.isSafeInteger(remaining) || remaining < 0) {
        fail('GitHub API returned an invalid core rate limit');
      }
      if (remaining <= minimumRemaining) {
        fail(`GitHub API core remaining is at or below the reserved ${minimumRemaining} requests`);
      }
    }

    const issues = JSON.parse(ghApi([
      '--method', 'GET',
      `repos/${repository}/issues`,
      '-f', 'state=open',
      '-f', 'labels=dependabot',
      '-f', 'per_page=100',
      '-f', `page=${page}`
    ]));
    if (!Array.isArray(issues)) fail('GitHub API returned an invalid issues page');
    value += issues.filter((issue) => !issue.pull_request).length;
    if (issues.length < 100) break;
    page += 1;
  }
  console.log(JSON.stringify({
    timestamp: request.timestamp,
    repository,
    valueId: 'dependabot-issues',
    value
  }));
}
