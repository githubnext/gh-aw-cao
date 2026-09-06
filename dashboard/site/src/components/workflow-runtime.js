/**
 * Route-aware workflow runtime and operational-value view.
 */

import { h } from '../dom.js';
import { octicon } from '../octicons.js';
import { formatNumber, formatPercent } from '../view-formatters.js';
import { renderStatusBadge } from './badge.js';
import { renderChartLegend, renderChartWidget, renderPieLegend } from './chart-elements.js';
import { findLink, renderExternalLinkOrFallback } from './link-content.js';
import { isApprovalConclusion, isFailureConclusion } from './run-classification.js';
import { coverageWindowHours, formatUtcDateTime, renderLegendList, renderPanelHeader, renderTableHeadRow, renderVitalStat } from './ui-primitives.js';
import { formatCount, text } from './count-formatters.js';
import { renderTitledBodySection } from './view-chrome.js';
import { renderWorkflowRoutePage } from './workflow-route-page.js';
import { workflowRouteValue } from './workflow-route.js';
import { rowsFor } from './source-rows.js';

/**
 * @param {import('./ui-elements.js').ElementRenderContext} context
 * @returns {HTMLElement}
 */
export function renderWorkflowRuntime(context) {
  return renderWorkflowRoutePage({
    ...context,
    elementConfig: context.elementConfig ?? { body: 'insights' }
  });
}

/**
 * @param {import('./ui-elements.js').ElementRenderContext} context
 * @param {Record<string, unknown>} workflow
 */
export function renderWorkflowRuntimeBody(context, workflow) {
  const repository = qualifiedRepository(workflow);
  const workflowPath = text(workflow.workflow);
  const runs = matchingRows(context, 'runs', repository, workflowPath);
  const usage = matchingRows(context, 'usage', repository, workflowPath);

  return h(
    'div',
    null,
    renderRuntimeMetrics(context, workflow, runs, usage),
    renderWorkflowValueReport(context, workflow)
  );
}

/**
 * @param {import('./ui-elements.js').ElementRenderContext} context
 * @param {Record<string, unknown>} workflow
 */
export function renderWorkflowValueReport(context, workflow) {
  const repository = qualifiedRepository(workflow);
  const workflowPath = text(workflow.workflow);
  const workflowName = text(workflow['workflow-name']) || workflowPath || 'Unknown workflow';
  const observations = latestEvaluatorObservations(
    matchingRows(context, 'operational-values', repository, workflowPath)
  );
  return renderValueReport(workflowName, repository, workflowPath, observations, context.sources['operational-values']?.metadata);
}

/**
 * @param {import('./ui-elements.js').ElementRenderContext} context
 * @param {Record<string, unknown>} workflow
 * @param {Array<Record<string, unknown>>} runs
 * @param {Array<Record<string, unknown>>} usage
 */
function renderRuntimeMetrics(context, workflow, runs, usage) {
  const runMetadata = context.sources.runs?.metadata;
  const usageMetadata = context.sources.usage?.metadata;
  const healthAvailable = runMetadata?.availability === 'available';
  const usageAvailable = usageMetadata?.availability === 'available';
  const health = summarizeRunHealth(runs);
  const usageTotal = usage.reduce((total, row) => total + finiteNumber(row.aic), 0);
  const usageMeasured = usage.length > 0 || usageMetadata?.completeness === 'complete';
  const registration = text(workflow['workflow-active']) === 'true'
    ? 'active'
    : text(workflow['workflow-active']) === 'false' ? 'disabled' : 'unknown';

  return h(
    'section',
    { className: 'repository-workflow-summary workflow-runtime-summary', 'aria-label': 'Workflow execution summary' },
    h(
      'dl',
      { className: 'workflow-runtime-metrics' },
      renderRunHealthMetric(health, healthAvailable, coverageLabel(runMetadata), recentMetricLabel('Run health', runMetadata)),
      renderVitalStat('Registration', registration, 'Current GitHub Actions state'),
      renderVitalStat(
        recentMetricLabel('AI Credits', usageMetadata),
        usageAvailable && usageMeasured ? formatNumber(usageTotal, { name: 'AI Credits', symbol: 'AIC', significant: 0.1 }) : '—',
        usageAvailable
          ? `${formatCount(usage.length)} ${usage.length === 1 ? 'run' : 'runs'} with AIC telemetry; ${coverageLabel(usageMetadata)}`
          : 'AI Credit data unavailable'
      )
    )
  );
}

/**
 * @param {{ total: number, successful: number, failed: number, approval: number, pending: number, other: number }} health
 * @param {boolean} available
 * @param {string} coverage
 * @param {string} label
 */
function renderRunHealthMetric(health, available, coverage, label) {
  if (!available) {
    return h(
      'div',
      { className: 'workflow-run-health' },
      h('dt', null, label),
      h('dd', null, '—'),
      h('p', null, coverage)
    );
  }
  const entries = [
    ['Successful', health.successful],
    ['Failed', health.failed],
    ['Approval required', health.approval],
    ['Pending', health.pending],
    ['Skipped / neutral / stale / cancelled', health.other]
  ];
  return h(
    'div',
    { className: 'workflow-run-health' },
    h('dt', null, label),
    h(
      'dd',
      { className: 'workflow-health-chart' },
      renderChartWidget(
        'pie',
        entries.map(([label, value]) => ({ x: String(label), y: Number(value), color: null })),
        [],
        { entries: /** @type {Array<[string, number]>} */ (entries), total: health.total },
        'runs'
      ),
      h('span', { className: 'workflow-health-total' }, h('strong', null, formatNumber(health.total)), h('small', null, 'runs'))
    ),
    renderPieLegend(/** @type {Array<[string, number]>} */ (entries), health.total),
    h('p', null, coverage)
  );
}

/**
 * Renders the shared `<header>` used by both the empty and populated
 * `value-report` states: a titled identity block plus a trailing status
 * element (a badge or a score summary).
 * @param {string} headingId
 * @param {string} workflowName
 * @param {string} repository
 * @param {string} workflowPath
 * @param {HTMLElement} trailing
 * @param {string} [tagline]
 * @returns {HTMLElement}
 */
function renderValueReportHeader(headingId, workflowName, repository, workflowPath, trailing, tagline) {
  return h(
    'header',
    null,
    h(
      'div',
      null,
      h('h2', { id: headingId }, workflowName),
      h('p', null, `${repository} - ${workflowPath}`),
      tagline ? h('p', null, tagline) : null
    ),
    trailing
  );
}

/**
 * @param {string} workflowName
 * @param {string} repository
 * @param {string} workflowPath
 * @param {Array<Record<string, unknown>>} observations
 * @param {import('../presenter.js').SourceMetadata | undefined} metadata
 */
function renderValueReport(workflowName, repository, workflowPath, observations, metadata) {
  const headingId = `workflow-${slugify(workflowRouteValue(repository, workflowPath))}-value-heading`;
  if (observations.length === 0) {
    const unavailable = metadata?.availability === 'unavailable';
    return h(
      'section',
      { className: 'value-report value-report-empty', 'aria-labelledby': headingId },
      renderValueReportHeader(
        headingId,
        workflowName,
        repository,
        workflowPath,
        renderStatusBadge(unavailable ? 'Unavailable' : 'Not evaluated')
      ),
      h(
        'div',
        { className: 'value-empty' },
        octicon('graph'),
        h('h3', null, unavailable ? 'Operational-value evidence unavailable' : 'No workflow observations yet'),
        unavailable
          ? h('p', null, 'Operational-value collection was unavailable for this dashboard refresh.')
          : h('p', null, 'Operational value will appear after this workflow publishes a valid ', h('code', null, 'grader_results.json'), '.')
      ),
      h('div', { className: 'value-details-unavailable' }, 'Run evidence unavailable')
    );
  }

  const comparable = comparableObservations(observations);
  const latest = comparable.at(-1) ?? observations.at(-1) ?? {};
  const matured = comparable.filter((row) => text(row['maturity-status']) === 'matured');
  const matureAverage = matured.length > 0
    ? matured.reduce((total, row) => total + finiteNumber(row['operational-value']), 0) / matured.length
    : null;
  return h(
    'section',
    { className: 'value-report', 'aria-labelledby': headingId },
    renderValueReportHeader(
      headingId,
      workflowName,
      repository,
      workflowPath,
      h('div', { className: 'value-score' }, h('strong', null, formatPercent(latest['operational-value'])), h('span', null, 'Latest observation')),
      "Run-scoped attainment from the workflow's frozen operational-value evaluator."
    ),
    h(
      'div',
      { className: 'value-chart', role: 'group', 'aria-label': 'Operational-value summary' },
      renderValueHistory(observations),
      h(
        'dl',
        null,
        renderVitalStat('Latest', formatPercent(latest['operational-value'])),
        renderVitalStat('Mature average', formatPercent(matureAverage)),
        renderVitalStat('Opportunities', formatNumber(comparable.length)),
        renderVitalStat('Evaluator', text(latest['evaluator-digest']) ? h('code', null, text(latest['evaluator-digest']).slice(0, 12)) : 'Unavailable')
      )
    ),
    h(
      'details',
      { className: 'value-details-disclosure' },
      h('summary', null, 'View run evidence'),
      h(
        'div',
        { className: 'value-details' },
        renderTitledBodySection(
          '',
          'Workflow observations',
          [
            h('p', null, 'Missing, failed, and null grader results are excluded rather than scored as zero.'),
            renderObservationTable(comparable)
          ],
          {
            headingTag: 'h3'
          }
        )
      )
    )
  );
}

/**
 * Renders one titled, headed `value-history-panel` section shared by the
 * outcome-diagnostics and weekly-attainment history views.
 * @param {{ className: string, headingId: string, heading: string, description: string, body: Node[] }} options
 * @returns {HTMLElement}
 */
function renderValueHistoryPanel({ className, headingId, heading, description, body }) {
  return h(
    'section',
    { className: `value-history-panel ${className}`, 'aria-labelledby': headingId },
    renderPanelHeader(headingId, heading, description),
    ...body
  );
}

/** @param {Array<Record<string, unknown>>} observations */
function renderValueHistory(observations) {
  const diagnostics = diagnosticSeries(observations);
  const weekly = weeklyAttainment(observations);
  const outcomeSeries = diagnostics.length > 0 ? diagnostics : primaryChangeSeries(weekly);
  const sections = [];
  if (outcomeSeries.length > 0) {
    sections.push(renderValueHistoryPanel({
      className: 'value-outcomes',
      headingId: 'value-outcomes-heading',
      heading: 'Outcome change from first observation',
      description: diagnostics.length > 0
        ? 'Positive values mean improvement according to each diagnostic direction.'
        : 'Positive values mean higher primary operational attainment.',
      body: [
        renderOutcomeChangeChart(outcomeSeries),
        renderLegendList(
          'chart-legend value-diagnostic-legend',
          outcomeSeries,
          (series, index) => `chart-series-${(index % 6) + 1}`,
          (series) => [
            h('span', null, series.name),
            h('strong', { className: series.latestChange > 0 ? 'value-gain' : series.latestChange < 0 ? 'value-loss' : '' }, formatPointChange(series.latestChange))
          ]
        )
      ]
    }));
  }
  if (weekly.length > 0) {
    const primaryPoints = weekly.flatMap((week, index) => [
      { x: formatWeek(week.weekStart), y: week.value, color: 'Weekly value' },
      { x: formatWeek(week.weekStart), y: rollingMean(weekly, index), color: '4-week rolling mean' }
    ]);
    const primarySeries = [
      { name: 'Weekly value', className: 'primary-weekly' },
      { name: '4-week rolling mean', className: 'primary-rolling' }
    ];
    sections.push(renderValueHistoryPanel({
      className: 'value-attainment',
      headingId: 'value-attainment-heading',
      heading: 'Weekly operational attainment',
      description: 'Weekly opportunity-adjusted values and their 4-week rolling mean; separate from outcome diagnostics.',
      body: [
        renderChartWidget('line', primaryPoints, primarySeries),
        renderChartLegend(primarySeries, 'line')
      ]
    }));
  }
  return h('div', { className: 'value-history' }, sections);
}

/** @param {Array<{ weekStart: string, value: number }>} weekly */
function primaryChangeSeries(weekly) {
  if (weekly.length === 0) return [];
  const first = weekly[0].value;
  const points = weekly.map((week) => ({ weekStart: week.weekStart, change: week.value - first }));
  return [{
    name: 'Primary operational value',
    points,
    latestChange: points.at(-1)?.change ?? 0
  }];
}

/** @param {Array<{ name: string, points: Array<{ weekStart: string, change: number }>, latestChange: number }>} series */
function renderOutcomeChangeChart(series) {
  const allWeeks = [...new Set(series.flatMap((item) => item.points.map((point) => point.weekStart)))].sort();
  const maximumChange = Math.max(0.1, ...series.flatMap((item) => item.points.map((point) => Math.abs(point.change))));
  const extent = Math.min(1, Math.ceil(maximumChange * 10) / 10);
  /** @param {string} weekStart */
  const xFor = (weekStart) => allWeeks.length < 2 ? 54 : 10 + (allWeeks.indexOf(weekStart) / (allWeeks.length - 1)) * 88;
  /** @param {number} change */
  const yFor = (change) => 21 - (change / extent) * 17;
  const grid = [-extent, 0, extent];
  return h(
    'div',
    { className: 'diagnostic-chart', 'data-chart-widget': 'diagnostic-change' },
    h(
      'svg',
      { viewBox: '0 0 100 46', role: 'img', 'aria-label': `Outcome change: ${series.map((item) => `${item.name} ${formatPointChange(item.latestChange)}`).join(', ')}` },
      h('rect', { className: 'diagnostic-gain-zone', x: 10, y: 4, width: 88, height: 17 }),
      h('rect', { className: 'diagnostic-loss-zone', x: 10, y: 21, width: 88, height: 17 }),
      ...grid.flatMap((change) => {
        const y = yFor(change);
        return [
          h('line', { className: change === 0 ? 'diagnostic-baseline' : 'line-chart-grid', x1: 10, y1: y, x2: 98, y2: y }),
          h('text', { className: 'diagnostic-axis-label', x: 8, y: y + 1.5, 'text-anchor': 'end' }, formatPointChange(change, false))
        ];
      }),
      ...series.flatMap((item, index) => {
        const className = `chart-series-${(index % 6) + 1}`;
        const coordinates = item.points.map((point) => ({ ...point, x: xFor(point.weekStart), y: yFor(point.change) }));
        return [
          h('polyline', { className: `diagnostic-series ${className}`, points: coordinates.map((point) => `${point.x},${point.y}`).join(' '), fill: 'none' }),
          ...coordinates.map((point) => h(
            'circle',
            { className: `diagnostic-point ${className}`, cx: point.x, cy: point.y, r: 0.55, tabIndex: 0, role: 'img', 'aria-label': `${item.name}, ${formatWeek(point.weekStart)}: ${formatPointChange(point.change)}` },
            h('title', null, `${item.name}, ${formatWeek(point.weekStart)}: ${formatPointChange(point.change)}`)
          ))
        ];
      })
    ),
    h('div', { className: 'chart-axis' }, h('span', null, formatWeek(allWeeks[0])), h('span', null, formatWeek(allWeeks.at(-1))))
  );
}

/** @param {Array<Record<string, unknown>>} observations */
function diagnosticSeries(observations) {
  /** @type {Map<string, Record<string, unknown>>} */
  const definitions = new Map();
  for (const row of observations) {
    for (const definition of Array.isArray(row['diagnostic-definitions']) ? row['diagnostic-definitions'] : []) {
      if (definition && text(definition.id)) definitions.set(text(definition.id), definition);
    }
  }
  if (definitions.size === 0) {
    for (const row of observations) {
      for (const id of Object.keys(isRecord(row.diagnostics) ? row.diagnostics : {})) {
        definitions.set(id, { id, name: humanizeIdentifier(id), direction: 'higher_is_better', aggregation: 'latest' });
      }
    }
  }
  return [...definitions.values()].flatMap((definition) => {
    const weekly = weeklyDiagnostic(observations, text(definition.id), text(definition.aggregation));
    if (weekly.length === 0) return [];
    const first = weekly[0].value;
    const direction = text(definition.direction) === 'lower_is_better' ? -1 : 1;
    const points = weekly.map((week) => ({ weekStart: week.weekStart, change: (week.value - first) * direction }));
    return [{
      name: text(definition.name) || humanizeIdentifier(text(definition.id)),
      points,
      latestChange: points.at(-1)?.change ?? 0
    }];
  });
}

/** @param {Array<Record<string, unknown>>} observations @param {string} metricId @param {string} aggregation */
function weeklyDiagnostic(observations, metricId, aggregation) {
  const groups = groupObservationsByWeek(observations);
  return [...groups].sort(([left], [right]) => left.localeCompare(right)).flatMap(([weekStart, rows]) => {
    /** @type {Array<{ value: number, observedAt: number }>} */
    const values = rows.flatMap((row) => {
      const value = isRecord(row.diagnostics) ? normalizedValue(row.diagnostics[metricId]) : null;
      return value === null ? [] : [{ value, observedAt: rowTime(row) }];
    });
    if (values.length === 0) return [];
    const value = aggregation === 'mean'
      ? values.reduce((total, item) => total + item.value, 0) / values.length
      : values.toSorted((left, right) => left.observedAt - right.observedAt).at(-1)?.value;
    return value == null ? [] : [{ weekStart, value }];
  });
}

/** @param {Array<Record<string, unknown>>} observations */
function weeklyAttainment(observations) {
  return [...groupObservationsByWeek(observations)].sort(([left], [right]) => left.localeCompare(right)).flatMap(([weekStart, rows]) => {
    const opportunities = new Map();
    for (const row of rows) {
      const value = normalizedValue(row['operational-value']);
      if (value === null) continue;
      const key = text(row['operational-case']) || `run:${text(row.run)}`;
      const existing = opportunities.get(key);
      if (!existing || rowTime(row) >= rowTime(existing)) opportunities.set(key, row);
    }
    const values = [...opportunities.values()].map((row) => /** @type {number} */ (normalizedValue(row['operational-value'])));
    return values.length === 0 ? [] : [{ weekStart, value: values.reduce((total, value) => total + value, 0) / values.length }];
  });
}

/** @param {Array<Record<string, unknown>>} observations */
function groupObservationsByWeek(observations) {
  /** @type {Map<string, Array<Record<string, unknown>>>} */
  const groups = new Map();
  for (const row of observations) {
    const weekStart = utcWeekStart(row['requested-evidence-at'] ?? row['observed-at']);
    if (!weekStart) continue;
    const rows = groups.get(weekStart) ?? [];
    rows.push(row);
    groups.set(weekStart, rows);
  }
  return groups;
}

/** @param {unknown} value */
function utcWeekStart(value) {
  const date = new Date(text(value));
  if (!Number.isFinite(date.getTime())) return '';
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return date.toISOString();
}

/** @param {Array<{ value: number }>} weekly @param {number} index */
function rollingMean(weekly, index) {
  const values = weekly.slice(Math.max(0, index - 3), index + 1).map((week) => week.value);
  return values.reduce((total, value) => total + value, 0) / values.length;
}

/** @param {unknown} value */
function normalizedValue(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 && numeric <= 1 ? numeric : null;
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** @param {string} value */
function humanizeIdentifier(value) {
  const words = value.replaceAll(/[-_]+/g, ' ').trim();
  return words ? words[0].toUpperCase() + words.slice(1) : 'Diagnostic';
}

/** @param {number} value @param {boolean} [signed] */
function formatPointChange(value, signed = true) {
  const points = value * 100;
  const prefix = signed && points > 0 ? '+' : '';
  return `${prefix}${points.toFixed(1)} pts`;
}

/** @param {string | undefined} value */
function formatWeek(value) {
  if (!value || !Number.isFinite(Date.parse(value))) return 'Unknown';
  return new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(value));
}

/** @param {Array<Record<string, unknown>>} observations */
function renderObservationTable(observations) {
  return h(
    'div',
    { className: 'table-region', role: 'region', tabIndex: 0, 'aria-label': 'Workflow operational-value observations' },
    h(
      'table',
      null,
      h('thead', null, renderTableHeadRow(['Observed', 'Opportunity', 'Value', 'Evidence'])),
      h(
        'tbody',
        null,
        ...[...observations].reverse().map((row) => {
          const runLink = findLink(row, 'run-link');
          const evidenceLink = findLink(row, 'evidence-link');
          const observed = formatObservationDate(row['observed-at']);
          return h(
            'tr',
            null,
            h('th', { scope: 'row' }, runLink ? h('a', { href: runLink.href, 'aria-label': runLink.label }, observed) : observed),
            h('td', null, text(row['operational-case']) || 'unknown'),
            h('td', null, formatPercent(row['operational-value'])),
            h(
              'td',
              null,
              renderStatusBadge(text(row['maturity-status']) === 'matured' ? 'Mature' : 'As of run'),
              evidenceLink ? h('span', null, ' ', renderExternalLinkOrFallback(evidenceLink)) : null
            )
          );
        })
      )
    )
  );
}

/** @param {Array<Record<string, unknown>>} observations */
function comparableObservations(observations) {
  const valid = observations.filter((row) => normalizedValue(row['operational-value']) !== null && text(row['operational-case']));

  const opportunities = new Map();
  for (const row of valid) {
    const key = `${qualifiedRepository(row)}:${text(row['operational-case'])}`;
    const existing = opportunities.get(key);
    if (!existing || rowTime(row) >= rowTime(existing)) opportunities.set(key, row);
  }
  return [...opportunities.values()].sort((left, right) => rowTime(left) - rowTime(right));
}

/** @param {Array<Record<string, unknown>>} observations */
function latestEvaluatorObservations(observations) {
  const valid = observations.filter((row) => text(row['evaluator-digest']));
  const latestEvaluator = valid
    .toSorted((left, right) => evidenceAssignmentTime(right) - evidenceAssignmentTime(left))[0]?.['evaluator-digest'];
  if (!latestEvaluator) return [];
  return valid.filter((candidate) => candidate['evaluator-digest'] === latestEvaluator)
    .sort((left, right) => rowTime(left) - rowTime(right));
}

/** @param {Record<string, unknown>} row */
function evidenceAssignmentTime(row) {
  const value = Date.parse(text(row['requested-evidence-at'] ?? row['observed-at']));
  return Number.isFinite(value) ? value : 0;
}

/** @param {Array<Record<string, unknown>>} runs */
function summarizeRunHealth(runs) {
  const health = { total: runs.length, successful: 0, failed: 0, approval: 0, pending: 0, other: 0 };
  for (const run of runs) {
    const conclusion = run['run-conclusion'];
    const status = text(run['run-status']);
    if (conclusion === 'success') health.successful += 1;
    else if (isFailureConclusion(conclusion)) health.failed += 1;
    else if (isApprovalConclusion(conclusion)) health.approval += 1;
    else if (status && status !== 'completed') health.pending += 1;
    else health.other += 1;
  }
  return health;
}

/** @param {import('../presenter.js').SourceMetadata | undefined} metadata */
function coverageLabel(metadata) {
  if (metadata?.availability !== 'available') return 'Actions run data unavailable';
  const hours = coverageWindowHours(metadata);
  const completeness = metadata.completeness === 'complete' ? 'Complete' : metadata.completeness === 'partial' ? 'Partial' : 'Unknown';
  return `${completeness}${hours ? ` ${hours}-hour` : ''} Actions run window`;
}

/** @param {string} label @param {import('../presenter.js').SourceMetadata | undefined} metadata */
function recentMetricLabel(label, metadata) {
  const hours = coverageWindowHours(metadata);
  return hours ? `${label} (last ${hours}h)` : `Recent ${label}`;
}

/**
 * @param {import('./ui-elements.js').ElementRenderContext} context
 * @param {string} sourceName
 * @param {string} repository
 * @param {string} workflow
 */
function matchingRows(context, sourceName, repository, workflow) {
  return rowsFor(context.sources, sourceName).filter((row) => matchesWorkflow(row, repository, workflow));
}

/** @param {Record<string, unknown>} row @param {string} repository @param {string} workflow */
function matchesWorkflow(row, repository, workflow) {
  return qualifiedRepository(row).toLowerCase() === repository.toLowerCase()
    && text(row.workflow) === workflow;
}

/** @param {Record<string, unknown>} row */
function qualifiedRepository(row) {
  const repository = text(row.repository);
  return repository.includes('/') ? repository : `${text(row.organization)}/${repository}`.replace(/^\/|\/$/g, '');
}

/** @param {Record<string, unknown>} row */
function rowTime(row) {
  const value = Date.parse(text(row['observed-at']));
  return Number.isFinite(value) ? value : 0;
}

/** @param {unknown} value */
function formatObservationDate(value) {
  const date = text(value);
  return Number.isFinite(Date.parse(date)) ? formatUtcDateTime(date) : 'Unknown';
}

/** @param {unknown} value */
function finiteNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

/** @param {string} value */
function slugify(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
