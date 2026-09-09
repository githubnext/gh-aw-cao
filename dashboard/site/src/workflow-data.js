/**
 * Derived workflow topology sources for generic JSON-selected views.
 */

import { titleCase } from './components/count-formatters.js';

/** @typedef {Record<string, unknown>} Row */
const AIC_TO_USD = 0.01;

/**
 * @param {Record<string, import('./presenter.js').LogicalSourceInput>} sources
 * @returns {Record<string, import('./presenter.js').LogicalSourceInput>}
 */
export function deriveWorkflowSources(sources) {
  const workflows = Array.isArray(sources.workflows?.rows) ? sources.workflows.rows : [];
  const runsAvailable = sources.runs?.metadata?.availability !== 'unavailable' && Array.isArray(sources.runs?.rows);
  const runs = runsAvailable ? sources.runs.rows : [];
  const usage = Array.isArray(sources.usage?.rows) ? sources.usage.rows : [];
  const outcomes = Array.isArray(sources.outcomes?.rows) ? sources.outcomes.rows : [];
  const workflowRuns = summarizeWorkflowRuns(workflows, runsAvailable ? runs : null);
  const workflowAic = summarizeWorkflowAic(workflows, usage);
  const usageMetadata = sources.usage?.metadata ?? unavailableMetadata();
  /** @param {Row} row */
  const isPackaged = (row) => row['workflow-role'] !== 'standalone' && Boolean(text(row.package));
  const packaged = workflows
    .filter(isPackaged)
    .map((row) => derivePackagedWorkflow(row, workflowRuns.get(row), workflowAic.get(row)))
    .sort(comparePackagedWorkflows);
  // Every row not captured above (including rows with an unrecognized or
  // missing workflow-role) is repository-owned; the two buckets must
  // together account for every row so no workflow is silently dropped.
  const standalone = workflows
    .filter((row) => !isPackaged(row))
    .map((row) => deriveStandaloneWorkflow(row, workflowRuns.get(row), workflowAic.get(row)))
    .sort(compareStandaloneWorkflows);
  const packages = new Set(packaged.map((row) => text(row.package)));
  const metadata = sources.workflows?.metadata ?? unavailableMetadata();
  return {
    ...sources,
    'workflow-topology-summary': {
      source: 'workflow-topology-summary',
      rows: [
        { label: 'Packages', value: String(packages.size) },
        { label: 'Package workflows', value: String(packaged.length) },
        { label: 'Standalone workflows', value: String(standalone.length) }
      ],
      metadata
    },
    'packaged-workflows': {
      source: 'packaged-workflows',
      rows: packaged,
      metadata
    },
    'package-inventory': {
      source: 'package-inventory',
      rows: summarizePackageInventory(packaged),
      metadata
    },
    'standalone-workflows': {
      source: 'standalone-workflows',
      rows: standalone,
      metadata
    },
    'workflow-reports': {
      source: 'workflow-reports',
      rows: outcomes.flatMap((row) => {
        const report = deriveWorkflowReport(row);
        return report ? [report] : [];
      }).sort(compareReports),
      metadata: sources.outcomes?.metadata ?? unavailableMetadata()
    },
    'workflow-runs': {
      source: 'workflow-runs',
      rows: runs.flatMap((row) => {
        const run = deriveWorkflowRun(row);
        return run ? [run] : [];
      }).sort(compareRuns),
      metadata: sources.runs?.metadata ?? unavailableMetadata()
    },
    'package-reports': {
      source: 'package-reports',
      rows: outcomes.flatMap((row) => {
        const report = derivePackageReport(row, workflows);
        return report ? [report] : [];
      }).sort(compareReports),
      metadata: sources.outcomes?.metadata ?? unavailableMetadata()
    },
    'model-usage-summary': {
      source: 'model-usage-summary',
      rows: summarizeModelUsage(usage),
      metadata: usageMetadata
    },
    'engine-usage-summary': {
      source: 'engine-usage-summary',
      rows: summarizeEngineUsage(usage),
      metadata: usageMetadata
    },
    'run-aggregate-summary': {
      source: 'run-aggregate-summary',
      rows: summarizeRuns(runs),
      metadata: sources.runs?.metadata ?? unavailableMetadata()
    }
  };
}

/** @param {Row[]} workflows */
function summarizePackageInventory(workflows) {
  /** @type {Map<string, Row[]>} */
  const grouped = new Map();
  for (const workflow of workflows) {
    const packageId = text(workflow.package);
    if (!packageId) continue;
    const key = `${text(workflow.repository).toLowerCase()}:${packageId.toLowerCase()}`;
    const rows = grouped.get(key) ?? [];
    rows.push(workflow);
    grouped.set(key, rows);
  }
  return [...grouped.values()].map((rows) => {
    const packageId = text(rows[0]?.package);
    /** @param {string} field */
    const values = (field) => [...new Set(rows.map((row) => text(row[field])).filter(Boolean))].sort();
    /** @param {string} field */
    const total = (field) => rows.reduce((sum, row) => {
      const value = Number(row[field]);
      return Number.isFinite(value) ? sum + value : sum;
    }, 0);
    const repositories = values('repository');
    return {
      package: packageId,
      'package-name': text(rows[0]?.['package-name']) || titleCase(packageId),
      workflows: rows.length,
      repositories: repositories.length,
      roles: values('workflow-role').join(', '),
      modes: values('rollout-mode').join(', '),
      registration: values('workflow-active').join(', '),
      runs: total('runs'),
      aic: total('aic'),
      ...(rows[0]?.['package-link'] ? { 'package-link': rows[0]['package-link'] } : {})
    };
  }).sort((left, right) => text(left['package-name']).localeCompare(text(right['package-name'])));
}

/** @param {Row} row @returns {Row | null} */
function deriveWorkflowRun(row) {
  const repository = qualifiedRepository(row);
  const workflow = text(row.workflow);
  if (!repository || repository.toLowerCase() === 'unknown' || !workflow || !text(row.run)) return null;
  return {
    'workflow-route': `${repository}:${workflow}`,
    ...row
  };
}

/** @param {Row} row @returns {Row | null} */
function deriveWorkflowReport(row) {
  const repository = text(row['runtime-repository']) || qualifiedRepository(row);
  const workflow = text(row.workflow);
  if (!repository || repository.toLowerCase() === 'unknown' || !workflow) return null;
  return {
    'workflow-route': `${repository}:${workflow}`,
    ...deriveReport(row)
  };
}

/** @param {Row} row @param {Row[]} workflows @returns {Row | null} */
function derivePackageReport(row, workflows) {
  const packageId = attributedPackage(row, workflows);
  if (!packageId) return null;
  const report = deriveReport(row);
  return {
    package: packageId,
    ...report
  };
}

/** @param {Row} row */
function deriveReport(row) {
  const safeOutput = text(row['safe-output']);
  const sourceLink = ['issue-link', 'pull-request-link', 'run-link', 'external-link']
    .map((field) => row[field])
    .find(isPlainObject);
  return {
    'safe-output': safeOutput,
    'outcome-title': text(row['outcome-title']) || safeOutput || 'Untitled report',
    'outcome-summary': text(row['outcome-summary']) || 'No report summary was provided.',
    'outcome-status': text(row['outcome-status']) || text(row['outcome-state']) || 'unknown',
    'rollout-mode': text(row['rollout-mode']) || 'unknown',
    engine: text(row.engine) || 'unknown',
    'engine-version': text(row['engine-version']) || 'unknown',
    'requested-model': text(row['requested-model']) || 'unknown',
    'resolved-model': text(row['resolved-model']) || 'unknown',
    'outcome-category': text(row['outcome-category']) || 'unknown',
    'observed-at': row['observed-at'] ?? row['published-at'],
    ...(sourceLink
      ? {
          'external-link': {
            ...sourceLink,
            relation: 'external',
            ...(safeOutput
              ? {
                  'dashboard-href': `#page-outcome-detail?outcome=${encodeURIComponent(safeOutput)}`,
                  'dashboard-label': `View ${text(row['outcome-title']) || safeOutput}`
                }
              : {})
          }
        }
      : {})
  };
}

/**
 * @param {Row[]} usage
 * @returns {Row[]}
 */
function summarizeModelUsage(usage) {
  const summaries = new Map();
  for (const row of usage) {
    const aic = number(row.aic);
    const model = text(row['resolved-model']) || text(row['requested-model']) || 'unknown';
    const summary = summaries.get(model) ?? {
      model,
      'resolved-model': model,
      engines: new Set(),
      'requested-models': new Set(),
      runs: new Set(),
      invocations: 0,
      'total-aic': 0,
      'estimated-usd': 0,
      pricing: aicPricingText()
    };
    summary.engines.add(text(row.engine) || 'unknown');
    summary['requested-models'].add(text(row['requested-model']) || 'unknown');
    summary.runs.add(runIdentity(row));
    summary.invocations += 1;
    summary['total-aic'] += aic;
    summary['estimated-usd'] += aic * AIC_TO_USD;
    summaries.set(model, summary);
  }
  return [...summaries.values()].map((summary) => ({
    model: summary.model,
    'resolved-model': summary['resolved-model'],
    engine: joinValues(summary.engines),
    'requested-model': joinValues(summary['requested-models']),
    runs: summary.runs.size,
    invocations: summary.invocations,
    'total-aic': summary['total-aic'],
    'estimated-usd': summary['estimated-usd'],
    pricing: summary.pricing
  })).sort(compareUsageSummaries);
}

/**
 * @param {Row[]} usage
 * @returns {Row[]}
 */
function summarizeEngineUsage(usage) {
  const summaries = new Map();
  for (const row of usage) {
    const aic = number(row.aic);
    const engine = text(row.engine) || 'unknown';
    const version = text(row['engine-version']);
    const summary = summaries.get(engine) ?? {
      engine,
      versions: new Set(),
      models: new Set(),
      runs: new Set(),
      invocations: 0,
      'total-aic': 0,
      'estimated-usd': 0
    };
    if (version && version !== 'unknown') summary.versions.add(version);
    summary.models.add(text(row['resolved-model']) || text(row['requested-model']) || 'unknown');
    summary.runs.add(runIdentity(row));
    summary.invocations += 1;
    summary['total-aic'] += aic;
    summary['estimated-usd'] += aic * AIC_TO_USD;
    summaries.set(engine, summary);
  }
  return [...summaries.values()].map((summary) => {
    const versions = [...summary.versions].sort(compareVersions);
    return {
      engine: summary.engine,
      runs: summary.runs.size,
      invocations: summary.invocations,
      'total-aic': summary['total-aic'],
      'estimated-usd': summary['estimated-usd'],
      'min-engine-version': versions[0] ?? 'unknown',
      'max-engine-version': versions.at(-1) ?? 'unknown',
      models: joinValues(summary.models)
    };
  }).sort(compareUsageSummaries);
}

/**
 * @param {Row[]} runs
 * @returns {Row[]}
 */
function summarizeRuns(runs) {
  const summaries = new Map();
  for (const row of runs) {
    const values = {
      engine: text(row.engine) || 'unknown',
      'engine-version': text(row['engine-version']) || 'unknown',
      'requested-model': text(row['requested-model']) || 'unknown',
      'resolved-model': text(row['resolved-model']) || 'unknown',
      'run-conclusion': text(row['run-conclusion']) || 'unknown'
    };
    const key = JSON.stringify(Object.values(values));
    const summary = summaries.get(key) ?? {
      ...values,
      runs: new Set(),
      'run-link': isPlainObject(row['run-link'])
        ? {
            ...row['run-link'],
            'dashboard-href': '#page-runs',
            'dashboard-label': 'View runs table'
          }
        : undefined
    };
    summary.runs.add(runIdentity(row));
    summaries.set(key, summary);
  }
  return [...summaries.values()]
    .map((summary) => ({
      engine: summary.engine,
      'engine-version': summary['engine-version'],
      'requested-model': summary['requested-model'],
      'resolved-model': summary['resolved-model'],
      'run-conclusion': summary['run-conclusion'],
      runs: summary.runs.size,
      ...(summary['run-link'] ? { 'run-link': summary['run-link'] } : {})
    }))
    .sort((left, right) => right.runs - left.runs || text(left.engine).localeCompare(text(right.engine)));
}

/** @param {Row} outcome @param {Row[]} workflows */
function attributedPackage(outcome, workflows) {
  const explicitPackage = text(outcome.package);
  if (explicitPackage) return explicitPackage;
  const workflow = workflows.find((candidate) => sameWorkflowScope(outcome, candidate)
    && (
      normalizeWorkflowIdentity(candidate.workflow) === normalizeWorkflowIdentity(outcome.workflow)
      || normalizeWorkflowIdentity(candidate['workflow-name']) === normalizeWorkflowIdentity(outcome['workflow-name'])
    ));
  return text(workflow?.package);
}

/** @param {Row} outcome @param {Row} workflow */
function sameWorkflowScope(outcome, workflow) {
  const outcomeRepository = text(outcome.repository).toLowerCase();
  const workflowRepository = text(workflow.repository).toLowerCase();
  const outcomeOrganization = text(outcome.organization).toLowerCase();
  const workflowOrganization = text(workflow.organization).toLowerCase();
  return (!outcomeRepository || !workflowRepository || outcomeRepository === workflowRepository)
    && (!outcomeOrganization || !workflowOrganization || outcomeOrganization === workflowOrganization);
}

/** @param {unknown} value */
function normalizeWorkflowIdentity(value) {
  return text(value).toLowerCase().replace(/\.lock\.yml$/, '.md');
}

/** @param {Row} row @param {number | undefined} runs @param {number | undefined} aic */
function derivePackagedWorkflow(row, runs, aic) {
  const packageId = text(row.package);
  const repositoryLink = isPlainObject(row['repository-link']) ? row['repository-link'] : null;
  const packageTargetLink = repositoryLink ?? (isPlainObject(row['workflow-link']) ? row['workflow-link'] : null);
  return {
    package: packageId,
    'package-name': text(row['package-name']) || titleCase(packageId),
    repository: qualifiedRepository(row),
    workflow: text(row.workflow),
    'workflow-name': text(row['workflow-name']) || text(row.workflow),
    'workflow-role': text(row['workflow-role']) || 'unknown',
    'rollout-mode': text(row['rollout-mode']) || 'unknown',
    'workflow-active': text(row['workflow-active']) || 'unknown',
    ...(runs === undefined ? {} : { runs }),
    ...(aic === undefined ? {} : { aic }),
    'package-link': {
      ...(packageTargetLink ?? {}),
      'dashboard-href': `#page-package-insights?package=${encodeURIComponent(packageId)}`,
      'dashboard-label': `View ${text(row['package-name']) || titleCase(packageId)} package dashboard`
    },
    ...(row['repository-link'] ? { 'repository-link': row['repository-link'] } : {}),
    ...(row['workflow-link'] ? { 'workflow-link': row['workflow-link'] } : {}),
    ...(row['external-link'] ? { 'external-link': row['external-link'] } : {})
  };
}

/** @param {Row} row @param {number | undefined} runs @param {number | undefined} aic */
function deriveStandaloneWorkflow(row, runs, aic) {
  return {
    repository: qualifiedRepository(row),
    workflow: text(row.workflow),
    'workflow-name': text(row['workflow-name']) || text(row.workflow),
    'rollout-mode': text(row['rollout-mode']) || 'unknown',
    'workflow-active': text(row['workflow-active']) || 'unknown',
    ...(runs === undefined ? {} : { runs }),
    ...(aic === undefined ? {} : { aic }),
    ...(row['repository-link'] ? { 'repository-link': row['repository-link'] } : {}),
    ...(row['workflow-link'] ? { 'workflow-link': row['workflow-link'] } : {})
  };
}

/**
 * @param {Row[]} workflows
 * @param {Row[] | null} runs
 * @returns {Map<Row, number>}
 */
function summarizeWorkflowRuns(workflows, runs) {
  const totals = new Map();
  if (runs === null) return totals;
  for (const workflow of workflows) totals.set(workflow, 0);
  for (const run of runs) {
    const workflow = matchedWorkflow(workflows, run);
    if (workflow) totals.set(workflow, (totals.get(workflow) ?? 0) + 1);
  }
  return totals;
}

/**
 * Attribute each usage observation only when it identifies one workflow row.
 * @param {Row[]} workflows
 * @param {Row[]} usage
 * @returns {Map<Row, number>}
 */
export function summarizeWorkflowAic(workflows, usage) {
  const totals = new Map();
  for (const observation of usage) {
    const aic = Number(observation.aic);
    if (!Number.isFinite(aic) || aic < 0 || !text(observation.workflow)) continue;
    const workflow = matchedWorkflow(workflows, observation);
    if (!workflow) continue;
    totals.set(workflow, (totals.get(workflow) ?? 0) + aic);
  }
  return totals;
}

/** @param {Row[]} workflows @param {Row} observation @returns {Row | undefined} */
function matchedWorkflow(workflows, observation) {
  const candidates = workflows.filter((workflow) => (
    normalizeWorkflowIdentity(workflow.workflow) === normalizeWorkflowIdentity(observation.workflow)
    && sameWorkflowScope(observation, workflow)
  ));
  return candidates.length === 1 ? candidates[0] : undefined;
}

/** @param {Row} left @param {Row} right */
function comparePackagedWorkflows(left, right) {
  return text(left['package-name']).localeCompare(text(right['package-name']))
    || roleOrder(left['workflow-role']) - roleOrder(right['workflow-role'])
    || text(left['workflow-name']).localeCompare(text(right['workflow-name']));
}

/** @param {Row} left @param {Row} right */
function compareStandaloneWorkflows(left, right) {
  return text(left.repository).localeCompare(text(right.repository))
    || text(left['workflow-name']).localeCompare(text(right['workflow-name']));
}

/** @param {Row} left @param {Row} right */
function compareReports(left, right) {
  return derivedReportTime(right) - derivedReportTime(left)
    || text(left['outcome-title']).localeCompare(text(right['outcome-title']));
}

/** @param {Row} left @param {Row} right */
function compareRuns(left, right) {
  return derivedRunTime(right) - derivedRunTime(left)
    || text(right.run).localeCompare(text(left.run), 'en', { numeric: true });
}

/** @param {Row} left @param {Row} right */
function compareUsageSummaries(left, right) {
  return Number(right['total-aic']) - Number(left['total-aic'])
    || text(left.model ?? left.engine).localeCompare(text(right.model ?? right.engine));
}

/** @param {Set<string>} values */
function joinValues(values) {
  return [...values].filter(Boolean).sort().join(', ') || 'unknown';
}

/** @param {Row} row */
function runIdentity(row) {
  return [row.organization, row.repository, row.workflow, row.run].map(text).join(':');
}

/** @param {unknown} value */
function number(value) {
  const result = Number(value);
  return Number.isFinite(result) && result >= 0 ? result : 0;
}

function aicPricingText() {
  return `1 AIC = $${AIC_TO_USD.toFixed(2)} USD`;
}

/** @param {string} left @param {string} right */
function compareVersions(left, right) {
  const leftParts = left.split(/[.-]/).map(versionPart);
  const rightParts = right.split(/[.-]/).map(versionPart);
  const count = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < count; index += 1) {
    const leftPart = leftParts[index] ?? { number: 0, text: '' };
    const rightPart = rightParts[index] ?? { number: 0, text: '' };
    const numeric = leftPart.number - rightPart.number;
    if (numeric !== 0) return numeric;
    const lexical = leftPart.text.localeCompare(rightPart.text);
    if (lexical !== 0) return lexical;
  }
  return left.localeCompare(right);
}

/** @param {string} part */
function versionPart(part) {
  const numeric = Number(part);
  return Number.isFinite(numeric) ? { number: numeric, text: '' } : { number: 0, text: part };
}

/** @param {Row} row */
function derivedRunTime(row) {
  const value = Date.parse(text(row['started-at']));
  return Number.isFinite(value) ? value : 0;
}

/** @param {Row} row */
function derivedReportTime(row) {
  const value = Date.parse(text(row['observed-at']));
  return Number.isFinite(value) ? value : 0;
}

/** @param {unknown} role */
function roleOrder(role) {
  return role === 'orchestrator' ? 0 : role === 'worker' ? 1 : 2;
}

/** @param {Row} row */
function qualifiedRepository(row) {
  const repository = text(row.repository);
  if (!repository) return 'unknown';
  if (repository.includes('/')) return repository;
  const organization = text(row.organization);
  return organization ? `${organization}/${repository}` : repository;
}

/** @param {unknown} value */
function text(value) {
  return value == null ? '' : String(value).trim();
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @returns {import('./presenter.js').SourceMetadata} */
function unavailableMetadata() {
  return {
    'source-id': 'workflow-topology-derived',
    'source-kind': 'derived',
    'as-of': new Date(0).toISOString(),
    'retrieved-at': new Date(0).toISOString(),
    completeness: 'unknown',
    freshness: 'unknown',
    availability: 'unavailable'
  };
}
