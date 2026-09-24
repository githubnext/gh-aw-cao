#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const REPOSITORY_COORDINATE = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/;
const MAX_ALERT_PAGES = Number(process.env.CAO_DEPENDABOT_ALERTS_MAX_PAGES ?? 1000);
const GITHUB_API_URL = (() => {
  try {
    return new URL(process.env.GITHUB_API_URL ?? 'https://api.github.com');
  } catch {
    fail('GITHUB_API_URL must be a valid URL');
  }
})();

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
if (!Number.isSafeInteger(MAX_ALERT_PAGES) || MAX_ALERT_PAGES < 1) {
  fail('CAO_DEPENDABOT_ALERTS_MAX_PAGES must be a positive integer');
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

function parseResponse(output, repository) {
  const normalized = String(output).replace(/\r\n/g, '\n');
  let offset = 0;
  let headers = '';
  const headerStart = /HTTP\/\S+/iy;
  while (true) {
    // gh api --include can emit interim header blocks; the final block describes the body.
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
    fail(`GitHub API returned HTTP ${statusCode}${status[2] ? ` ${status[2]}` : ''} for ${repository} Dependabot alerts`);
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

function canonicalEndpoint(endpoint, repository, fields = []) {
  const apiPath = GITHUB_API_URL.pathname.replace(/\/$/, '');
  const base = `${GITHUB_API_URL.origin}${apiPath || ''}/`;
  let url;
  let pathname;
  try {
    url = new URL(endpoint, base);
    pathname = decodeURIComponent(url.pathname);
  } catch {
    fail('GitHub API returned an invalid Dependabot alerts next link');
  }
  const expectedPath = `${apiPath}/repos/${repository}/dependabot/alerts`;
  if (
    url.origin !== GITHUB_API_URL.origin
    || pathname.toLowerCase() !== expectedPath.toLowerCase()
  ) {
    fail('GitHub API returned an unexpected Dependabot alerts next link');
  }
  for (let index = 0; index < fields.length; index += 2) {
    if (fields[index] !== '-f') continue;
    const field = String(fields[index + 1]);
    const separator = field.indexOf('=');
    const name = separator < 0 ? field : field.slice(0, separator);
    const value = separator < 0 ? '' : field.slice(separator + 1);
    url.searchParams.set(name, value);
  }
  url.searchParams.sort();
  return url.toString();
}

function validateNextEndpoint(next, repository) {
  if (!next) return undefined;
  canonicalEndpoint(next, repository);
  return next;
}

function repeatedEndpoint(endpoint, repository, fields, visited) {
  const canonical = canonicalEndpoint(endpoint, repository, fields);
  if (visited.has(canonical)) return true;
  visited.add(canonical);
  return false;
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
    if (repeatedEndpoint(endpoint, repository, fields, visited)) {
      fail(`Dependabot alerts pagination repeated a page for ${repository}`);
    }
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
    ]), repository);
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
