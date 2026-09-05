/**
 * Report-style package activity view composed from workflow, run, and usage sources.
 */

import { h } from '../dom.js';
import { formatNumber, formatPercent } from '../view-formatters.js';
import { pluralSuffix, titleCase } from './count-formatters.js';
import { classifyUtilizationRatio, isFailureConclusion } from './run-classification.js';
import { completenessCaveat, coverageWindowHours, formatMediumUtcDate, formatMediumUtcDateTime, renderEmptyMessage, renderEmptyTableRow, renderIdentityLink, renderLegendSwatch, renderPanelHeader, renderTableHeadRow } from './ui-primitives.js';
import { rowsFor } from './source-rows.js';
import { renderPackagesModeShell } from './packages-mode-shell.js';
const DAY_IN_MILLISECONDS = 86_400_000;

/**
 * Declarative host for the built-in packages page that composes reusable
 * package activity sections under the existing mode tabs.
 *
 * @param {Record<string, import('../presenter.js').LogicalSourceInput>} sources
 * @param {string} [pageId]
 * @returns {HTMLElement}
 */
export function renderPackagesView(sources, pageId = 'packages') {
  return renderPackagesModeShell({
    pageId,
    sections: [
      { id: 'utilization', render: (mode) => renderPackageUtilization(sources, mode) },
      { id: 'run-trend', render: (mode) => renderRunTrend(sources, mode) },
      { id: 'summary', render: (mode) => renderPackageSummary(sources, mode) }
    ]
  });
}

/**
 * @param {Record<string, import('../presenter.js').LogicalSourceInput>} sources
 * @param {string} mode
 * @returns {HTMLElement}
 */
export function renderPackageSummary(sources, mode = 'all') {
  const packages = summarizePackages(rowsFor(sources, 'workflows'));
  const summaries = summarizePackageActivity(packages, sources, mode);
  const modeLabel = titleCase(mode);
  const headingId = 'packages-summary-heading';

  return h(
    'section',
    { className: 'package-summary', 'aria-labelledby': headingId },
    renderPanelHeader(headingId, `${modeLabel} output by package`, 'Durable outputs and inventory health for each control-plane package.', { className: 'package-summary-heading' }),
    h(
      'div',
      { className: 'table-region', role: 'region', 'aria-labelledby': `${headingId}-caption`, tabIndex: 0 },
      h(
        'table',
        { className: 'package-summary-table' },
        h('caption', { id: `${headingId}-caption` }, `${modeLabel} package summary`),
        h(
          'thead',
          null,
          renderTableHeadRow(['Package', 'Runs', 'Successful', 'Failed', 'Run warnings', 'Inventory warnings', 'AIC', 'Latest activity'])
        ),
        h(
          'tbody',
          null,
          ...(packages.length > 0
            ? packages.map((entry) => renderPackageSummaryRow(entry, summaries.get(entry.key)))
            : [renderEmptyTableRow(8, 'No packages discovered.')])
        )
      )
    )
  );
}

/**
 * @param {ReturnType<typeof summarizePackages>[number]} entry
 * @param {{ runs: number, successful: number, failed: number, warnings: number | null, inventoryWarnings: number | null, aic: number | null, latestActivity: Date | null } | undefined} summary
 * @returns {HTMLTableRowElement}
 */
function renderPackageSummaryRow(entry, summary) {
  return /** @type {HTMLTableRowElement} */ (h(
    'tr',
    { dataset: { packageSummaryKey: entry.key } },
    h('th', { scope: 'row' }, renderPackageIdentityLink(entry, 'span')),
    h('td', null, formatNumber(summary?.runs ?? 0)),
    h('td', null, formatNumber(summary?.successful ?? 0)),
    h('td', null, formatNumber(summary?.failed ?? 0)),
    h('td', null, summary?.warnings === null || summary?.warnings === undefined ? '—' : formatNumber(summary.warnings)),
    h('td', null, summary?.inventoryWarnings === null || summary?.inventoryWarnings === undefined ? '—' : formatNumber(summary.inventoryWarnings)),
    h('td', null, summary?.aic === null || summary?.aic === undefined ? '—' : formatAic(summary.aic)),
    h('td', null, summary?.latestActivity ? formatDate(summary.latestActivity) : 'No activity yet')
  ));
}

/**
 * @param {ReturnType<typeof summarizePackages>} packages
 * @param {Record<string, import('../presenter.js').LogicalSourceInput>} sources
 * @param {string} mode
 */
function summarizePackageActivity(packages, sources, mode) {
  const workflowDetails = new Map(packages.flatMap((entry) => entry.workflows.map((row) => [
    scopedEntityKey(row, 'workflow'),
    entry.key
  ])));
  const findingsAvailable = Boolean(sources.findings) && sources.findings?.metadata?.availability !== 'unavailable';
  const usageAvailable = Boolean(sources.usage) && sources.usage?.metadata?.availability !== 'unavailable';
  const activity = packageActivityRuns(packages, sources, mode);
  const runDetails = new Map();
  const summaries = new Map(packages.map((entry) => [entry.key, {
    runs: 0,
    successful: 0,
    failed: 0,
    warnings: findingsAvailable ? 0 : null,
    inventoryWarnings: packageInventoryWarnings(entry),
    aic: usageAvailable ? 0 : null,
    latestActivity: null
  }]));

  for (const row of activity.rows) {
    const packageKey = String(row.packageKey);
    const runKey = String(row.runKey);
    const summary = summaries.get(packageKey);
    if (!summary || runDetails.has(runKey)) continue;
    runDetails.set(runKey, { packageKey, mode: String(row['rollout-mode'] ?? 'unknown') });
    summary.runs += 1;
    if (String(row['run-conclusion']) === 'success') summary.successful += 1;
    if (isFailureConclusion(row['run-conclusion'])) summary.failed += 1;
    updateLatestActivity(summary, row['ended-at'], row['started-at']);
  }

  if (findingsAvailable) {
    const warningRuns = new Set();
    for (const row of rowsFor(sources, 'findings')) {
      const runKey = runIdentity(row);
      const run = runDetails.get(runKey);
      const packageKey = run?.packageKey ?? workflowDetails.get(scopedEntityKey(row, 'workflow'));
      const summary = packageKey ? summaries.get(packageKey) : null;
      const findingMode = run?.mode ?? String(row['rollout-mode'] ?? 'unknown');
      if (!summary || (mode !== 'all' && findingMode !== mode)) continue;
      updateLatestActivity(summary, row['observed-at']);
      if (row['finding-kind'] !== 'authored-warning' || !run || warningRuns.has(runKey)) continue;
      warningRuns.add(runKey);
      summary.warnings = (summary.warnings ?? 0) + 1;
    }
  }

  if (usageAvailable) {
    for (const row of rowsFor(sources, 'usage')) {
      const packageKey = workflowDetails.get(scopedEntityKey(row, 'workflow'));
      const summary = packageKey ? summaries.get(packageKey) : null;
      if (!summary || !matchesMode(row, mode)) continue;
      const aic = Number(row.aic);
      if (Number.isFinite(aic) && aic >= 0) summary.aic = (summary.aic ?? 0) + aic;
      updateLatestActivity(summary, row['observed-at']);
    }
  }

  return summaries;
}

/**
 * @param {ReturnType<typeof summarizePackages>[number]} entry
 * @returns {number | null}
 */
function packageInventoryWarnings(entry) {
  const explicitCount = entry.workflows
    .map((row) => Number(row['package-inventory-warnings']))
    .find(Number.isFinite);
  if (explicitCount !== undefined) return Math.max(0, explicitCount);
  const readiness = entry.workflows
    .map((row) => row['inventory-ready'])
    .filter((value) => typeof value === 'boolean');
  if (readiness.includes(false)) return 1;
  return readiness.length > 0 ? 0 : null;
}

/**
 * @param {{ latestActivity: Date | null }} summary
 * @param {...unknown} values
 */
function updateLatestActivity(summary, ...values) {
  const timestamp = Math.max(...values
    .map((value) => Date.parse(String(value ?? '')))
    .filter(Number.isFinite));
  if (Number.isFinite(timestamp) && (!summary.latestActivity || timestamp > summary.latestActivity.getTime())) {
    summary.latestActivity = new Date(timestamp);
  }
}

/**
 * @param {Record<string, unknown>} row
 * @param {string} mode
 */
function matchesMode(row, mode) {
  return mode === 'all' || row['rollout-mode'] === mode;
}

/**
 * Prefer durable-output run evidence, which is retained for the package report
 * window, over the shorter Actions inventory window.
 *
 * @param {ReturnType<typeof summarizePackages>} packages
 * @param {Record<string, import('../presenter.js').LogicalSourceInput>} sources
 * @param {string} mode
 */
function packageActivityRuns(packages, sources, mode) {
  const outcomesAvailable = Boolean(sources.outcomes)
    && sources.outcomes?.metadata?.availability !== 'unavailable';
  const source = outcomesAvailable ? sources.outcomes : sources.runs;
  const rows = outcomesAvailable ? rowsFor(sources, 'outcomes') : rowsFor(sources, 'runs');
  const windowStart = outcomesAvailable ? outcomeWindowStart(source) : Number.NEGATIVE_INFINITY;
  const workflowPackages = new Map(packages.flatMap((entry) => entry.workflows.map((row) => [
    scopedEntityKey(row, 'workflow'),
    entry.key
  ])));
  const runs = new Map();

  for (const row of rows) {
    const rolloutMode = String(row['rollout-mode'] ?? 'unknown');
    if (!matchesMode(row, mode) || (outcomesAvailable && !['review', 'live'].includes(rolloutMode))) continue;
    const publishedAt = Date.parse(String(row['published-at'] ?? ''));
    if (outcomesAvailable && (!Number.isFinite(publishedAt) || publishedAt < windowStart)) continue;
    const packageKey = outcomesAvailable
      ? packageKeyForOutcome(row, packages)
      : workflowPackages.get(scopedEntityKey(row, 'workflow'));
    const runKey = runIdentity(row);
    if (!packageKey || !runKey) continue;
    const startedAt = outcomesAvailable ? row['published-at'] : row['started-at'];
    const endedAt = outcomesAvailable ? row['observed-at'] : row['ended-at'];
    const existing = runs.get(runKey);
    if (!existing) {
      runs.set(runKey, {
        packageKey,
        runKey,
        'rollout-mode': rolloutMode,
        'run-conclusion': String(row['run-conclusion'] ?? 'unknown'),
        'started-at': startedAt,
        'ended-at': endedAt
      });
      continue;
    }
    if (existing['run-conclusion'] === 'unknown' && row['run-conclusion'] !== 'unknown') {
      existing['run-conclusion'] = row['run-conclusion'];
    }
    existing['started-at'] = earlierDate(existing['started-at'], startedAt);
    existing['ended-at'] = laterDate(existing['ended-at'], endedAt);
  }

  return { rows: [...runs.values()], source };
}

/** @param {import('../presenter.js').LogicalSourceInput | undefined} source */
function outcomeWindowStart(source) {
  const asOf = Date.parse(String(source?.metadata?.['as-of'] ?? source?.metadata?.['retrieved-at'] ?? ''));
  if (!Number.isFinite(asOf)) return Number.NEGATIVE_INFINITY;
  const start = new Date(asOf);
  start.setUTCHours(0, 0, 0, 0);
  return start.getTime() - (29 * DAY_IN_MILLISECONDS);
}

/**
 * @param {Record<string, unknown>} row
 * @param {ReturnType<typeof summarizePackages>} packages
 */
function packageKeyForOutcome(row, packages) {
  const packageId = String(row.package ?? '').toLowerCase();
  if (!packageId) return null;
  const candidates = packages.filter((entry) => entry.id.toLowerCase() === packageId);
  const runtimeRepository = String(row['runtime-repository'] ?? '').toLowerCase();
  const scoped = candidates.find((entry) => (
    [entry.organization, entry.repository].filter(Boolean).join('/').toLowerCase() === runtimeRepository
  ));
  return scoped?.key ?? (candidates.length === 1 ? candidates[0].key : null);
}

/** @param {Record<string, unknown>} row */
function runIdentity(row) {
  const runLink = row['run-link'];
  if (runLink && typeof runLink === 'object' && 'href' in runLink && typeof runLink.href === 'string') return runLink.href;
  const run = String(row.run ?? '');
  if (!run) return '';
  const repository = String(row['runtime-repository'] ?? '')
    || [row.organization, row.repository].filter(Boolean).join('/');
  return JSON.stringify([repository, run]);
}

/** @param {unknown} left @param {unknown} right */
function earlierDate(left, right) {
  const values = [left, right].filter((value) => Number.isFinite(Date.parse(String(value ?? ''))));
  return values.sort((a, b) => Date.parse(String(a)) - Date.parse(String(b)))[0] ?? left ?? right;
}

/** @param {unknown} left @param {unknown} right */
function laterDate(left, right) {
  const values = [left, right].filter((value) => Number.isFinite(Date.parse(String(value ?? ''))));
  return values.sort((a, b) => Date.parse(String(b)) - Date.parse(String(a)))[0] ?? left ?? right;
}

/**
 * @param {Record<string, import('../presenter.js').LogicalSourceInput>} sources
 * @param {string} mode
 * @returns {HTMLElement}
 */
export function renderPackageUtilization(sources, mode = 'all') {
  const workflows = rowsFor(sources, 'workflows');
  const usage = rowsFor(sources, 'usage');
  const packages = summarizePackages(workflows);
  const utilization = summarizeUtilization(packages, usage, mode);
  const usageMetadata = sources.usage?.metadata;
  const available = Boolean(sources.usage) && usageMetadata?.availability !== 'unavailable';
  const completeness = usageMetadata?.completeness ?? 'unknown';
  const windowLabel = sourceWindowLabel(usageMetadata);
  const modeLabel = mode;
  const headingId = 'packages-utilization-heading';

  return h(
    'section',
    { className: 'package-utilization', 'aria-labelledby': headingId },
    renderPanelHeader(
      headingId,
      'Package AIC utilization',
      available
        ? `Actual AI Credits against summed per-run limits for ${modeLabel} package runs retained from ${windowLabel}.`
        : 'AI Credit usage artifacts are unavailable.',
      { className: 'package-utilization-heading' }
    ),
    h(
      'div',
      { className: 'package-utilization-grid' },
      ...(packages.length > 0
        ? packages.map((entry) => renderUtilizationCard(entry, utilization.get(entry.key), available, completeness))
        : [renderEmptyMessage('No centrally managed packages were observed.')])
    )
  );
}

/**
 * @param {ReturnType<typeof summarizePackages>[number]} entry
 * @param {{ used: number, allowed: number, reportedRuns: number } | undefined} utilization
 * @param {boolean} available
 * @param {string} completeness
 * @returns {HTMLElement}
 */
function renderUtilizationCard(entry, utilization, available, completeness) {
  const used = utilization?.used ?? 0;
  const allowed = utilization?.allowed ?? 0;
  const reportedRuns = utilization?.reportedRuns ?? 0;
  const ratio = available && allowed > 0 ? used / allowed : null;
  const meterPercent = ratio === null ? 0 : Math.min(100, ratio * 100);
  const status = ratio === null ? 'empty' : classifyUtilizationRatio(ratio);
  const detail = !available
    ? 'AI Credit usage artifacts are unavailable.'
    : reportedRuns === 0
      ? 'No AIC usage was reported in the retained window.'
      : `${formatAic(used)} of ${formatAic(allowed)} AIC across ${formatNumber(reportedRuns)} reported run${pluralSuffix(reportedRuns)}.`;
  const coverage = !available
    ? ''
    : completenessCaveat(completeness, 'usage');
  const ariaLabel = ratio === null
    ? `${entry.name}: no utilization available`
    : `${entry.name}: ${formatAic(used)} of ${formatAic(allowed)} AI Credits used, ${formatPercent(ratio)}`;
  const scopeLabel = [entry.organization, entry.repository].filter(Boolean).join('/');

  return h(
    'article',
    {
      className: `package-utilization-card utilization-${status}`,
      dataset: {
        packageId: entry.id,
        packageKey: entry.key,
        packageOrganization: entry.organization,
        packageRepository: entry.repository
      }
    },
    h(
      'header',
      null,
      h(
        'span',
        { className: 'package-utilization-identity' },
        renderPackageIdentityLink(entry, 'strong'),
        scopeLabel ? h('small', null, scopeLabel) : null
      ),
      h('span', { className: 'package-utilization-value' }, ratio === null ? '—' : formatPercent(ratio))
    ),
    h(
      'div',
      { className: 'utilization-track', role: 'img', 'aria-label': ariaLabel },
      h('span', { style: `width: ${meterPercent.toFixed(2)}%` })
    ),
    h('p', null, detail, coverage ? ` ${coverage}` : ''),
    h(
      'small',
      null,
      entry.completeAttemptAllowance === null
        ? 'Complete package attempt allowance unavailable'
        : `${formatAic(entry.completeAttemptAllowance)} AIC allowance per complete package attempt`
    )
  );
}

/**
 * @param {Record<string, import('../presenter.js').LogicalSourceInput>} sources
 * @param {string} mode
 * @returns {HTMLElement}
 */
export function renderRunTrend(sources, mode = 'all') {
  const packages = summarizePackages(rowsFor(sources, 'workflows'));
  const activity = packageActivityRuns(packages, sources, mode);
  const runsSource = activity.source;
  const modeLabel = titleCase(mode);
  const heading = `${modeLabel} runs over time`;
  const headingId = 'packages-trend-heading';
  if (!runsSource || runsSource.metadata?.availability === 'unavailable') {
    return renderUnavailableRunTrend(heading, headingId, 'Package run data is unavailable.');
  }
  const allRuns = activity.rows;
  const trendDays = buildTrendDays(runsSource, allRuns);
  if (trendDays.length === 0) {
    return renderUnavailableRunTrend(heading, headingId, 'Package run trend is unavailable because no reporting date was provided.');
  }
  const windowStart = trendDays[0]?.getTime() ?? Number.NEGATIVE_INFINITY;
  const windowEnd = (trendDays.at(-1)?.getTime() ?? Number.POSITIVE_INFINITY) + DAY_IN_MILLISECONDS;
  const runs = allRuns.filter((row) => {
    const startedAt = Date.parse(String(row['started-at'] ?? ''));
    return Number.isFinite(startedAt) && startedAt >= windowStart && startedAt < windowEnd;
  });
  const series = {
    successful: cumulativeCounts(trendDays, runs.filter((row) => row['run-conclusion'] === 'success')),
    failed: cumulativeCounts(trendDays, runs.filter((row) => isFailureConclusion(row['run-conclusion']))),
    cancelled: cumulativeCounts(trendDays, runs.filter((row) => row['run-conclusion'] === 'cancelled'))
  };
  const maximum = Math.max(1, ...series.successful, ...series.failed, ...series.cancelled);
  const chartDescription = `Daily cumulative successful, failed, and cancelled ${modeLabel.toLowerCase()} package run counts.`;
  const coverage = completenessCaveat(runsSource.metadata?.completeness, 'run') || null;

  return h(
    'section',
    { className: 'package-trend-panel', 'aria-labelledby': headingId },
    h(
      'header',
      null,
      h(
        'div',
        null,
        h('h3', { id: headingId }, heading),
        h(
          'p',
          null,
          h('strong', null, formatNumber(runs.length)),
          h('span', null, `as of ${formatDate(trendDays.at(-1))}`)
        )
      ),
      h('span', { className: 'package-trend-group' }, 'Group by: ', h('strong', null, 'Status'))
    ),
    h(
      'div',
      { className: 'package-trend-legend', 'aria-label': 'Run status legend' },
      renderLegendItem('successful', 'Successful'),
      renderLegendItem('failed', 'Failed'),
      renderLegendItem('cancelled', 'Cancelled')
    ),
    h(
      'div',
      { className: 'package-trend-chart' },
      h(
        'svg',
        {
          viewBox: '0 0 800 240',
          role: 'img',
          'aria-label': chartDescription,
          preserveAspectRatio: 'xMinYMin meet'
        },
        h('title', null, `${heading} for the last 30 days`),
        h('line', { x1: 58, y1: 50, x2: 772, y2: 50 }),
        h('line', { x1: 58, y1: 125, x2: 772, y2: 125 }),
        h('line', { x1: 58, y1: 200, x2: 772, y2: 200 }),
        ...[58, 201, 344, 487, 630, 772].map((x) => h('line', { className: 'vertical-grid', x1: x, y1: 50, x2: x, y2: 200 })),
        h('text', { x: 8, y: 54 }, formatNumber(maximum)),
        h('text', { x: 8, y: 129 }, formatNumber(maximum / 2)),
        h('text', { x: 8, y: 204 }, '0'),
        h('polyline', { className: 'package-chart-successful', points: trendPoints(series.successful, maximum) }),
        h('polyline', { className: 'package-chart-failed', points: trendPoints(series.failed, maximum) }),
        h('polyline', { className: 'package-chart-cancelled', points: trendPoints(series.cancelled, maximum) }),
        ...renderTrendPoints(trendDays, series, maximum)
      ),
      h(
        'div',
        { className: 'package-trend-axis' },
        h('span', null, formatDate(trendDays[0], true)),
        h('span', null, formatDate(trendDays.at(-1), true))
      )
    ),
    coverage ? h('p', { className: 'package-trend-coverage' }, coverage) : null
  );
}

/**
 * @param {string} heading
 * @param {string} headingId
 * @param {string} message
 * @returns {HTMLElement}
 */
function renderUnavailableRunTrend(heading, headingId, message) {
  return h(
    'section',
    { className: 'package-trend-panel', 'aria-labelledby': headingId },
    renderPanelHeader(headingId, heading),
    renderEmptyMessage(message)
  );
}

/**
 * @param {string} status
 * @param {string} label
 * @returns {HTMLElement}
 */
function renderLegendItem(status, label) {
  return h('span', null, renderLegendSwatch(`package-legend-${status}`), label);
}

/**
 * @param {Date[]} days
 * @param {{ successful: number[], failed: number[], cancelled: number[] }} series
 * @param {number} maximum
 * @returns {SVGElement[]}
 */
function renderTrendPoints(days, series, maximum) {
  return /** @type {SVGElement[]} */ (days.map((day, index) => {
    const x = 58 + (index * 714 / 29);
    const tooltipX = Math.min(578, Math.max(4, x - 95));
    const values = {
      successful: series.successful[index],
      failed: series.failed[index],
      cancelled: series.cancelled[index]
    };
    const label = `${formatDate(day, true)}: ${values.successful} successful, ${values.failed} failed, ${values.cancelled} cancelled runs`;
    return /** @type {SVGElement} */ (/** @type {unknown} */ (h(
      'g',
      { className: 'package-chart-point', tabIndex: 0, role: 'img', 'aria-label': label },
      h('rect', { className: 'package-point-hit', x: x - 12, y: 40, width: 24, height: 170 }),
      ...Object.entries(values).map(([status, value]) => h('circle', {
        className: `package-point-marker package-point-marker-${status}`,
        cx: x,
        cy: 200 - (value * 150 / maximum),
        r: 5
      })),
      h(
        'g',
        { className: 'package-point-tooltip', transform: `translate(${tooltipX} 44)`, 'aria-hidden': 'true' },
        h('rect', { width: 190, height: 92, rx: 6 }),
        h('text', { className: 'tooltip-date', x: 12, y: 20 }, formatDate(day, true)),
        renderTooltipLine('successful', 'Successful', values.successful, 42),
        renderTooltipLine('failed', 'Failed', values.failed, 62),
        renderTooltipLine('cancelled', 'Cancelled', values.cancelled, 82)
      )
    )));
  }));
}

/**
 * @param {string} status
 * @param {string} label
 * @param {number} value
 * @param {number} y
 * @returns {SVGElement}
 */
function renderTooltipLine(status, label, value, y) {
  return /** @type {SVGElement} */ (/** @type {unknown} */ (h(
    'g',
    null,
    h('text', { className: `tooltip-swatch tooltip-swatch-${status}`, x: 12, y }, status === 'successful' ? '—' : '---'),
    h('text', { className: 'tooltip-label', x: 28, y }, label),
    h('text', { className: 'tooltip-value', x: 178, y, 'text-anchor': 'end' }, String(value))
  )));
}

/**
 * @param {Array<Record<string, unknown>>} workflows
 */
function summarizePackages(workflows) {
  /** @type {Map<string, Array<Record<string, unknown>>>} */
  const grouped = new Map();
  for (const row of workflows) {
    if (!isPackageWorkflow(row)) continue;
    const packageKey = scopedEntityKey(row, 'package');
    const rows = grouped.get(packageKey) ?? [];
    rows.push(row);
    grouped.set(packageKey, rows);
  }

  return [...grouped.entries()].map(([key, rows]) => {
    const firstRow = rows[0] ?? {};
    const uniqueWorkflowAllowances = new Map(rows
      .filter((row) => typeof row.workflow === 'string' && isNonNegativeNumber(row['max-ai-credits']))
      .map((row) => [scopedEntityKey(row, 'workflow'), /** @type {number} */ (row['max-ai-credits'])]));
    const summedAllowance = [...uniqueWorkflowAllowances.values()]
      .reduce((total, value) => total + value, 0);
    const id = String(firstRow.package);
    return {
      key,
      id,
      name: String(rows.find((row) => typeof row['package-name'] === 'string')?.['package-name'] ?? titleCase(id)),
      icon: String(rows.find((row) => typeof row['package-icon'] === 'string')?.['package-icon'] ?? 'package'),
      organization: String(firstRow.organization ?? ''),
      repository: String(firstRow.repository ?? ''),
      completeAttemptAllowance: uniqueWorkflowAllowances.size > 0 ? summedAllowance : null,
      workflows: rows
    };
  }).sort((left, right) => left.name.localeCompare(right.name));
}

/** @param {string} packageId */
function packageInsightsHref(packageId) {
  return `#page-package-insights?package=${encodeURIComponent(packageId)}`;
}

/**
 * Renders the shared package-identity link (icon plus name) used by both the
 * summary table and the utilization card header, wrapping the name in the
 * caller-selected inline element.
 * @param {{ id: string, icon: string, name: string }} entry
 * @param {'span'|'strong'} nameTag
 * @returns {HTMLElement}
 */
function renderPackageIdentityLink(entry, nameTag) {
  return renderIdentityLink({ href: packageInsightsHref(entry.id), icon: entry.icon, label: entry.name, labelTag: nameTag });
}

/**
 * @param {ReturnType<typeof summarizePackages>} packages
 * @param {Array<Record<string, unknown>>} usage
 * @param {string} mode
 * @returns {Map<string, { used: number, allowed: number, reportedRuns: number }>}
 */
function summarizeUtilization(packages, usage, mode) {
  const workflowDetails = new Map(packages.flatMap((entry) => entry.workflows.map((row) => [
    scopedEntityKey(row, 'workflow'),
    { packageKey: entry.key, allowance: Number(row['max-ai-credits']) }
  ])));
  /** @type {Map<string, { packageKey: string, used: number, allowance: number }>} */
  const runs = new Map();
  for (const row of usage) {
    if (mode !== 'all' && row['rollout-mode'] !== mode) continue;
    const details = workflowDetails.get(scopedEntityKey(row, 'workflow'));
    const aic = Number(row.aic);
    if (!details || !Number.isFinite(aic) || aic < 0) continue;
    const runId = String(row.run ?? row.invocation ?? '');
    if (!runId) continue;
    const key = JSON.stringify([details.packageKey, scopedEntityKey(row, row.run == null ? 'invocation' : 'run')]);
    const run = runs.get(key) ?? {
      packageKey: details.packageKey,
      used: 0,
      allowance: Number.isFinite(details.allowance) && details.allowance > 0 ? details.allowance : 0
    };
    run.used += aic;
    runs.set(key, run);
  }
  /** @type {Map<string, { used: number, allowed: number, reportedRuns: number }>} */
  const totals = new Map();
  for (const run of runs.values()) {
    const total = totals.get(run.packageKey) ?? { used: 0, allowed: 0, reportedRuns: 0 };
    total.used += run.used;
    total.allowed += run.allowance;
    total.reportedRuns += 1;
    totals.set(run.packageKey, total);
  }
  return totals;
}

/**
 * @param {import('../presenter.js').LogicalSourceInput | undefined} source
 * @param {Array<Record<string, unknown>>} runs
 * @returns {Date[]}
 */
function buildTrendDays(source, runs) {
  const metadataDate = Date.parse(String(source?.metadata?.['as-of'] ?? source?.metadata?.['retrieved-at'] ?? ''));
  const latestRunDate = Math.max(...runs.map((row) => Date.parse(String(row['started-at'] ?? ''))).filter(Number.isFinite));
  const endTimestamp = Number.isFinite(metadataDate) ? metadataDate : latestRunDate;
  if (!Number.isFinite(endTimestamp)) return [];
  const end = new Date(endTimestamp);
  end.setUTCHours(0, 0, 0, 0);
  return Array.from({ length: 30 }, (_, index) => new Date(end.getTime() - ((29 - index) * DAY_IN_MILLISECONDS)));
}

/**
 * @param {Date[]} days
 * @param {Array<Record<string, unknown>>} runs
 * @returns {number[]}
 */
function cumulativeCounts(days, runs) {
  return days.map((day) => {
    const endOfDay = day.getTime() + DAY_IN_MILLISECONDS;
    return runs.filter((row) => Date.parse(String(row['started-at'])) < endOfDay).length;
  });
}

/**
 * @param {number[]} values
 * @param {number} maximum
 * @returns {string}
 */
function trendPoints(values, maximum) {
  return values.map((value, index) => `${58 + (index * 714 / 29)},${200 - (value * 150 / maximum)}`).join(' ');
}

/**
 * @param {import('../presenter.js').SourceMetadata | undefined} metadata
 * @returns {string}
 */
function sourceWindowLabel(metadata) {
  const hours = coverageWindowHours(metadata);
  if (hours != null) {
    return `the last ${formatNumber(hours)} hour${pluralSuffix(hours)}`;
  }
  return 'the retained usage window';
}

/**

 * @param {Record<string, unknown>} row
 * @returns {boolean}
 */
function isPackageWorkflow(row) {
  return typeof row.package === 'string'
    && row.package.length > 0
    && (row['workflow-role'] === 'orchestrator' || row['workflow-role'] === 'worker');
}

/**
 * @param {Record<string, unknown>} row
 * @param {string} field
 * @returns {string}
 */
function scopedEntityKey(row, field) {
  return JSON.stringify([
    String(row.organization ?? ''),
    String(row.repository ?? ''),
    String(row[field] ?? '')
  ]);
}

/**
 * @param {unknown} value
 * @returns {value is number}
 */
function isNonNegativeNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * @param {number} value
 * @returns {string}
 */
function formatAic(value) {
  return new Intl.NumberFormat('en', { maximumFractionDigits: 1 }).format(value);
}

/**
 * @param {Date | undefined} value
 * @param {boolean} [dateOnly]
 * @returns {string}
 */
function formatDate(value, dateOnly = false) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) return 'Unavailable';
  return dateOnly ? formatMediumUtcDate(value) : formatMediumUtcDateTime(value);
}

/**
 * @param {string} value
 * @returns {string}
 */
