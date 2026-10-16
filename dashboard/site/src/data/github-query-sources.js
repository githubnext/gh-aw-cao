import { createDebug } from '../debug.js';

const debugSource = createDebug('github-query-sources');

export const GITHUB_QUERY_SOURCE_FIELDS = {
  'github-repository': ['full_name', 'description', 'html_url', 'default_branch', 'stargazers_count', 'forks_count', 'open_issues_count', 'archived', 'visibility'],
  'github-latest-release': ['tag_name', 'name', 'html_url', 'published_at', 'draft', 'prerelease']
};

/** @param {string} name */
export function isGitHubQuerySource(name) {
  return Object.hasOwn(GITHUB_QUERY_SOURCE_FIELDS, name);
}

/**
 * Source adaptation only. Selection, joins and projection remain declarative.
 * @param {string} source
 * @param {import('./github-service.js').GitHubResourceSnapshot} snapshot
 * @returns {import('../presenter.js').LogicalSourceInput}
 */
export function githubSnapshotSource(source, snapshot) {
  const instant = new Date().toISOString();
  debugSource({
    event: 'snapshot',
    source,
    status: snapshot.status,
    origin: snapshot.source,
    hasData: Boolean(snapshot.data),
    hasError: snapshot.error !== null
  });
  return {
    source,
    rows: snapshot.data ? [snapshot.data] : [],
    metadata: {
      'source-id': source, 'source-kind': 'github-resource',
      'as-of': instant, 'retrieved-at': instant,
      availability: snapshot.data ? 'available' : 'unavailable',
      completeness: snapshot.data ? 'complete' : 'unknown',
      freshness: snapshot.status === 'available' ? 'fresh' : snapshot.status === 'stale' ? 'stale' : 'unknown'
    }
  };
}
