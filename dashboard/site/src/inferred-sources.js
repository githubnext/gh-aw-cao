import { findLink } from './components/link-content.js';

/**
 * @typedef {import('./presenter.js').LogicalSourceInput} LogicalSourceInput
 * @typedef {{ id: string, kind: 'built-in' | 'custom', route?: { ['hash-query-parameter']?: string } }} DashboardPage
 */

/**
 * @param {Record<string, LogicalSourceInput>} sources
 * @param {{ githubUrlBase: string, pages: DashboardPage[] }} context
 * @returns {Record<string, LogicalSourceInput>}
 */
export function deriveDashboardLinkSources(sources, context) {
  return deriveWorkflowDashboardLinks(
    deriveRepositoryDashboardLinks(deriveEntityLinkSources(sources, context.githubUrlBase), context.pages),
    context.pages
  );
}

/**
 * @param {Record<string, LogicalSourceInput>} sources
 * @param {string} githubUrlBase
 * @returns {Record<string, LogicalSourceInput>}
 */
export function deriveEntityLinkSources(sources, githubUrlBase) {
  return Object.fromEntries(Object.entries(sources).map(([name, source]) => [
    name,
    {
      ...source,
      rows: Array.isArray(source?.rows) ? source.rows.map((row) => deriveEntityLinkRow(row, githubUrlBase)) : source?.rows
    }
  ]));
}

/**
 * @param {Record<string, LogicalSourceInput>} sources
 * @param {DashboardPage[]} pages
 */
function deriveRepositoryDashboardLinks(sources, pages) {
  const detailPage = pages.find((page) => page.kind === 'custom' && page.route?.['hash-query-parameter'] === 'repository');
  if (!detailPage) return sources;

  return Object.fromEntries(Object.entries(sources).map(([name, source]) => [
    name,
    {
      ...source,
      rows: Array.isArray(source?.rows)
        ? source.rows.map((row) => deriveRepositoryDashboardLink(row, detailPage.id))
        : source?.rows
    }
  ]));
}

/**
 * @param {Record<string, LogicalSourceInput>} sources
 * @param {DashboardPage[]} pages
 */
function deriveWorkflowDashboardLinks(sources, pages) {
  const insightsPage = pages.find((page) => page.kind === 'custom' && page.id === 'workflow-runtime');
  if (!insightsPage) return sources;
  const knownWorkflows = new Set((sources.workflows?.rows ?? [])
    .map(workflowDashboardIdentity)
    .filter((identity) => identity !== null));

  return Object.fromEntries(Object.entries(sources).map(([name, source]) => [
    name,
    {
      ...source,
      rows: Array.isArray(source?.rows)
        ? source.rows.map((row) => deriveWorkflowDashboardLink(row, insightsPage.id, knownWorkflows))
        : source?.rows
    }
  ]));
}

/**
 * @param {Record<string, unknown>} row
 * @param {string} pageId
 * @param {Set<string>} knownWorkflows
 */
function deriveWorkflowDashboardLink(row, pageId, knownWorkflows) {
  const identity = workflowDashboardIdentity(row);
  const workflowLink = row['workflow-link'];
  if (!identity || !knownWorkflows.has(identity) || !isPlainObject(workflowLink)) return row;

  return {
    ...row,
    'workflow-link': {
      ...workflowLink,
      'dashboard-href': `#page-${encodeURIComponent(pageId)}?workflow=${encodeURIComponent(identity)}`,
      'dashboard-label': `View ${trimmedString(row['workflow-name']) ?? trimmedString(row.workflow)} workflow dashboard`
    }
  };
}

/** @param {Record<string, unknown>} row @param {string} pageId */
function deriveRepositoryDashboardLink(row, pageId) {
  const organization = trimmedString(row.organization);
  const repository = trimmedString(row.repository);
  const repositorySlug = repository && repository.includes('/') ? repository : (organization && repository ? `${organization}/${repository}` : null);
  const repositoryLink = row['repository-link'];
  if (!repositorySlug || !isPlainObject(repositoryLink)) return row;

  return {
    ...row,
    'repository-link': {
      ...repositoryLink,
      'dashboard-href': `#page-${encodeURIComponent(pageId)}?repository=${encodeURIComponent(repositorySlug)}`,
      'dashboard-label': `View ${repositorySlug} repository dashboard`
    }
  };
}

/** @param {Record<string, unknown>} row @param {string} githubUrlBase */
function deriveEntityLinkRow(row, githubUrlBase) {
  const organization = trimmedString(row.organization);
  const repository = trimmedString(row.repository);
  const workflow = trimmedString(row.workflow);
  const repositorySlug = repository && repository.includes('/') ? repository : (organization && repository ? `${organization}/${repository}` : null);
  const workflowRepositorySlug = repositorySlugValue(row['runtime-repository']) ?? repositorySlug;
  /** @type {Record<string, unknown>} */
  const derived = {};

  if (organization && !findLink(row, 'organization-link')) {
    derived['organization-link'] = {
      relation: 'organization',
      href: `${githubUrlBase}/${organization}`,
      label: `View ${organization} on GitHub`
    };
  }
  if (repositorySlug && !findLink(row, 'repository-link')) {
    derived['repository-link'] = {
      relation: 'repository',
      href: `${githubUrlBase}/${repositorySlug}`,
      label: `View ${repositorySlug} on GitHub`
    };
  }
  if (workflowRepositorySlug && workflow && !findLink(row, 'workflow-link')) {
    const workflowPath = workflow.replace(/^\/+/, '');
    derived['workflow-link'] = {
      relation: 'workflow',
      href: `${githubUrlBase}/${workflowRepositorySlug}/blob/HEAD/${workflowPath}`,
      label: `View ${workflow} on GitHub`
    };
  }

  return Object.keys(derived).length > 0 ? { ...row, ...derived } : row;
}

/** @param {unknown} value */
function trimmedString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** @param {unknown} value */
function repositorySlugValue(value) {
  const repository = trimmedString(value);
  return repository && /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,98}[A-Za-z0-9])?\/[A-Za-z0-9_.-]{1,100}$/.test(repository)
    ? repository
    : null;
}

/** @param {Record<string, unknown>} row */
function workflowDashboardIdentity(row) {
  const organization = trimmedString(row.organization);
  const repository = trimmedString(row.repository);
  const repositorySlug = repository && repository.includes('/') ? repository : (organization && repository ? `${organization}/${repository}` : null);
  const workflowRepositorySlug = repositorySlugValue(row['runtime-repository']) ?? repositorySlug;
  const workflow = trimmedString(row.workflow);
  return workflowRepositorySlug && workflow ? `${workflowRepositorySlug}:${workflow}` : null;
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
