#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const REPOSITORY_COORDINATE = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/;
const MAX_ALERT_PAGES = 1000;
const GITHUB_API_URL = new URL(process.env.GITHUB_API_URL ?? 'https://api.github.com');

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

function parseResponse(output) {
  const normalized = String(output).replace(/\r\n/g, '\n');
  let offset = 0;
  let headers = '';
  const headerStart = /HTTP\/\S+/iy;
  while (true) {
    headerStart.lastIndex = offset;
    if (!headerStart.test(normalized)) break;
    const separator = normalized.indexOf('\n\n', offset);
    if (separator < 0) fail('GitHub API returned a truncated header block');
    headers = normalized.slice(offset, separator);
    offset = separator + 2;
  }
  if (!headers) fail('GitHub API returned a response without headers');
  const body = normalized.slice(offset);
  const status = headers.split('\n')[0]?.match(/^HTTP\/\S+\s+(\d{3})(?:\s+(.*))?$/i);
  if (!status) fail('GitHub API returned a response without an HTTP status');
  const statusCode = Number(status[1]);
  if (statusCode < 200 || statusCode >= 300) {
    fail(`GitHub API returned HTTP ${statusCode}${status[2] ? ` ${status[2]}` : ''} for Dependabot alerts`);
  }
  const link = headers.split('\n')
    .find((line) => /^link:/i.test(line))
    ?.replace(/^link:\s*/i, '');
  const next = link?.split(',')
    .map((entry) => entry.trim())
    .find((entry) => /(?:^|;)\s*rel="?next"?\s*(?:;|$)/i.test(entry))
    ?.match(/^<([^>]+)>/)?.[1];
  return { body, next };
}

function validateNextEndpoint(next, repository) {
  if (!next) return undefined;
  let url;
  try {
    url = new URL(next);
  } catch {
    fail('GitHub API returned an invalid Dependabot alerts next link');
  }
  const apiPath = GITHUB_API_URL.pathname.replace(/\/$/, '');
  const expectedPath = `${apiPath}/repos/${repository}/dependabot/alerts`;
  if (
    url.origin !== GITHUB_API_URL.origin
    || decodeURIComponent(url.pathname).toLowerCase() !== expectedPath.toLowerCase()
  ) {
    fail('GitHub API returned an unexpected Dependabot alerts next link');
  }
  return next;
}

for (const repository of request.repositories) {
  let endpoint = `repos/${repository}/dependabot/alerts`;
  let fields = ['-f', 'state=open', '-f', 'per_page=100'];
  const visited = new Set();
  let value = 0;
  while (endpoint) {
    if (visited.size >= MAX_ALERT_PAGES) {
      fail(`Dependabot alerts pagination exceeded ${MAX_ALERT_PAGES} pages for ${repository}`);
    }
    if (visited.has(endpoint)) {
      fail(`Dependabot alerts pagination repeated a page for ${repository}`);
    }
    visited.add(endpoint);
    if (minimumRemaining > 0) {
      const remaining = Number(ghApi(['rate_limit', '--jq', '.resources.core.remaining']).trim());
      if (!Number.isSafeInteger(remaining) || remaining < 0) {
        fail('GitHub API returned an invalid core rate limit');
      }
      if (remaining <= minimumRemaining) {
        fail(`GitHub API core remaining is at or below the reserved ${minimumRemaining} requests`);
      }
    }

    const response = parseResponse(ghApi([
      '--method', 'GET',
      '--include',
      endpoint,
      ...fields
    ]));
    // Next links already carry state and per_page, so only the first request supplies fields.
    fields = [];
    endpoint = validateNextEndpoint(response.next, repository);
    const alerts = JSON.parse(response.body);
    if (!Array.isArray(alerts)) fail('GitHub API returned an invalid Dependabot alerts page');
    value += alerts.length;
  }
  console.log(JSON.stringify({
    timestamp: request.timestamp,
    repository,
    valueId: 'dependabot-vulnerability-alerts',
    value
  }));
}
