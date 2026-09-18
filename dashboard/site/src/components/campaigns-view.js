/**
 * Report-style campaign activity view composed from workflow, run, and usage sources.
 */

import { h } from '../dom.js';
import { formatNumber, formatPercent } from '../view-formatters.js';
import { formatAic, pluralSuffix, titleCase } from './count-formatters.js';
import { classifyUtilizationRatio, isFailureConclusion } from './run-classification.js';
import { coverageWindowHours, formatMediumUtcDate, formatMediumUtcDateTime, renderEmptyMessage, renderEmptyTableRow, renderIdentityLink, renderLegendSwatch, renderPanelHeader, renderTableHeadRow } from './ui-primitives.js';
import { rowsFor } from './source-rows.js';
import { renderCampaignsModeShell } from './campaigns-mode-shell.js';
const DAY_IN_MILLISECONDS = 86_400_000;

/**
 * Declarative host for the built-in campaigns page that composes reusable
 * campaign activity sections under the existing mode tabs.
 *
 * @param {Record<string, import('../presenter.js').LogicalSourceInput>} sources
 * @param {string} [pageId]
 * @returns {HTMLElement}
 */
export function renderCampaignsView(sources, pageId = 'campaigns') {
  return renderCampaignsModeShell({
    pageId,
    sections: [
      { id: 'utilization', render: (mode) => renderCampaignUtilization(sources, mode) },
      { id: 'run-trend', render: (mode) => renderRunTrend(sources, mode) },
      { id: 'summary', render: (mode) => renderCampaignSummary(sources, mode) }
    ]
  });
}

/**
 * @param {Record<string, import('../presenter.js').LogicalSourceInput>} sources
 * @param {string} mode
 * @returns {HTMLElement}
 */
export function renderCampaignSummary(sources, mode = 'all') {
  const campaigns = summarizeCampaigns(rowsFor(sources, 'workflows'));
  const summaries = summarizeCampaignActivity(campaigns, sources, mode);
  const modeLabel = titleCase(mode);
  const headingId = 'campaigns-summary-heading';

  return h(
    'section',
    { className: 'campaign-summary', 'aria-labelledby': headingId },
    renderPanelHeader(headingId, `${modeLabel} output by campaign`, 'Durable outputs and inventory health for each control-plane campaign.', { className: 'campaign-summary-heading' }),
    h(
      'div',
      { className: 'table-region', role: 'region', 'aria-labelledby': `${headingId}-caption`, tabIndex: 0 },
      h(
        'table',
        { className: 'campaign-summary-table' },
        h('caption', { id: `${headingId}-caption` }, `${modeLabel} campaign summary`),
        h(
          'thead',
          null,
          renderTableHeadRow(['Campaign', 'Runs', 'Successful', 'Failed', 'Run warnings', 'Inventory warnings', 'AIC', 'Latest activity'])
        ),
        h(
          'tbody',
          null,
          ...(campaigns.length > 0
            ? campaigns.map((entry) => renderCampaignSummaryRow(entry, summaries.get(entry.key)))
            : [renderEmptyTableRow(8, 'No campaigns discovered.')])
        )
      )
    )
  );
}

/**
 * @param {ReturnType<typeof summarizeCampaigns>[number]} entry
 * @param {{ runs: number, successful: number, failed: number, warnings: number | null, inventoryWarnings: number | null, aic: number | null, latestActivity: Date | null } | undefined} summary
 * @returns {HTMLTableRowElement}
 */
function renderCampaignSummaryRow(entry, summary) {
  return /** @type {HTMLTableRowElement} */ (h(
    'tr',
    { dataset: { campaignSummaryKey: entry.key } },
    h('th', { scope: 'row' }, renderCampaignIdentityLink(entry, 'span')),
    h('td', null, summary ? formatNumber(summary.runs) : ''),
    h('td', null, summary ? formatNumber(summary.successful) : ''),
    h('td', null, summary ? formatNumber(summary.failed) : ''),
    h('td', null, summary?.warnings === null || summary?.warnings === undefined ? '' : formatNumber(summary.warnings)),
    h('td', null, summary?.inventoryWarnings === null || summary?.inventoryWarnings === undefined ? '' : formatNumber(summary.inventoryWarnings)),
    h('td', null, summary?.aic === null || summary?.aic === undefined ? '' : formatAic(summary.aic)),
    h('td', null, summary?.latestActivity ? formatDate(summary.latestActivity) : 'No activity yet')
  ));
}

/**
 * @param {ReturnType<typeof summarizeCampaigns>} campaigns
 * @param {Record<string, import('../presenter.js').LogicalSourceInput>} sources
 * @param {string} mode
 */
function summarizeCampaignActivity(campaigns, sources, mode) {
  const workflowDetails = new Map(campaigns.flatMap((entry) => entry.workflows.map((row) => [
    scopedEntityKey(row, 'workflow'),
    entry.key
  ])));
  const findingsAvailable = Boolean(sources.findings) && sources.findings?.metadata?.availability !== 'unavailable';
  const usageAvailable = Boolean(sources.usage) && sources.usage?.metadata?.availability !== 'unavailable';
  const activity = campaignActivityRuns(campaigns, sources, mode);
  const runDetails = new Map();
  const summaries = new Map(campaigns.map((entry) => [entry.key, {
    runs: 0,
    successful: 0,
    failed: 0,
    warnings: findingsAvailable ? 0 : null,
    inventoryWarnings: campaignInventoryWarnings(entry),
    aic: /** @type {number | null} */ (null),
    latestActivity: null
  }]));

  for (const row of activity.rows) {
    const campaignKey = String(row.campaignKey);
    const runKey = String(row.runKey);
    const summary = summaries.get(campaignKey);
    if (!summary || runDetails.has(runKey)) continue;
    runDetails.set(runKey, { campaignKey, mode: String(row['rollout-mode'] ?? 'unknown') });
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
      const campaignKey = run?.campaignKey ?? workflowDetails.get(scopedEntityKey(row, 'workflow'));
      const summary = campaignKey ? summaries.get(campaignKey) : null;
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
      const campaignKey = workflowDetails.get(scopedEntityKey(row, 'workflow'));
      const summary = campaignKey ? summaries.get(campaignKey) : null;
      if (!summary || !matchesMode(row, mode)) continue;
      const aic = Number(row.aic);
      if (Number.isFinite(aic) && aic >= 0) summary.aic = (summary.aic ?? 0) + aic;
      updateLatestActivity(summary, row['observed-at']);
    }
  }

  return summaries;
}

/**
 * @param {ReturnType<typeof summarizeCampaigns>[number]} entry
 * @returns {number | null}
 */
function campaignInventoryWarnings(entry) {
  const explicitCount = entry.workflows
    .map((row) => Number(row['campaign-inventory-warnings']))
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
 * Prefer durable-output run evidence, which is retained for the campaign report
 * window, over the shorter Actions inventory window.
 *
 * @param {ReturnType<typeof summarizeCampaigns>} campaigns
 * @param {Record<string, import('../presenter.js').LogicalSourceInput>} sources
 * @param {string} mode
 */
function campaignActivityRuns(campaigns, sources, mode) {
  const outcomesAvailable = Boolean(sources.outcomes)
    && sources.outcomes?.metadata?.availability !== 'unavailable';
  const source = outcomesAvailable ? sources.outcomes : sources.runs;
  const rows = outcomesAvailable ? rowsFor(sources, 'outcomes') : rowsFor(sources, 'runs');
  const windowStart = outcomesAvailable ? outcomeWindowStart(source) : Number.NEGATIVE_INFINITY;
  const workflowCampaigns = new Map(campaigns.flatMap((entry) => entry.workflows.map((row) => [
    scopedEntityKey(row, 'workflow'),
    entry.key
  ])));
  const runs = new Map();

  for (const row of rows) {
    const rolloutMode = String(row['rollout-mode'] ?? 'unknown');
    if (!matchesMode(row, mode) || (outcomesAvailable && !['review', 'live'].includes(rolloutMode))) continue;
    const publishedAt = Date.parse(String(row['published-at'] ?? ''));
    if (outcomesAvailable && (!Number.isFinite(publishedAt) || publishedAt < windowStart)) continue;
    const campaignKey = outcomesAvailable
      ? campaignKeyForOutcome(row, campaigns)
      : workflowCampaigns.get(scopedEntityKey(row, 'workflow'));
    const runKey = runIdentity(row);
    if (!campaignKey || !runKey) continue;
    const startedAt = outcomesAvailable ? row['published-at'] : row['started-at'];
    const endedAt = outcomesAvailable ? row['observed-at'] : row['ended-at'];
    const existing = runs.get(runKey);
    if (!existing) {
      runs.set(runKey, {
        campaignKey,
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
 * @param {ReturnType<typeof summarizeCampaigns>} campaigns
 */
function campaignKeyForOutcome(row, campaigns) {
  const campaignId = String(row.campaign ?? '').toLowerCase();
  if (!campaignId) return null;
  const candidates = campaigns.filter((entry) => entry.id.toLowerCase() === campaignId);
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
export function renderCampaignUtilization(sources, mode = 'all') {
  const workflows = rowsFor(sources, 'workflows');
  const usage = rowsFor(sources, 'usage');
  const campaigns = summarizeCampaigns(workflows);
  const utilization = summarizeUtilization(campaigns, usage, mode);
  const usageMetadata = sources.usage?.metadata;
  const available = Boolean(sources.usage) && usageMetadata?.availability !== 'unavailable';
  const windowLabel = sourceWindowLabel(usageMetadata);
  const modeLabel = mode;
  const headingId = 'campaigns-utilization-heading';

  return h(
    'section',
    { className: 'campaign-utilization', 'aria-labelledby': headingId },
    renderPanelHeader(
      headingId,
      'Campaign AIC utilization',
      available
        ? `Actual AI Credits against summed per-run limits for ${modeLabel} campaign runs retained from ${windowLabel}.`
        : 'AI Credit usage artifacts are unavailable.',
      { className: 'campaign-utilization-heading' }
    ),
    h(
      'div',
      { className: 'campaign-utilization-grid' },
      ...(campaigns.length > 0
        ? campaigns.map((entry) => renderUtilizationCard(entry, utilization.get(entry.key), available))
        : [renderEmptyMessage('No centrally managed campaigns were observed.')])
    )
  );
}

/**
 * @param {ReturnType<typeof summarizeCampaigns>[number]} entry
 * @param {{ used: number, allowed: number, reportedRuns: number } | undefined} utilization
 * @param {boolean} available
 * @returns {HTMLElement}
 */
function renderUtilizationCard(entry, utilization, available) {
  const used = utilization?.used ?? 0;
  const allowed = utilization?.allowed ?? 0;
  const reportedRuns = utilization?.reportedRuns ?? 0;
  const ratio = available && allowed > 0 && reportedRuns > 0 ? used / allowed : null;
  const meterPercent = ratio === null ? 0 : Math.min(100, ratio * 100);
  const status = ratio === null ? 'empty' : classifyUtilizationRatio(ratio);
  const detail = !available
    ? 'AI Credit usage artifacts are unavailable.'
    : reportedRuns === 0
      ? 'No AIC usage was reported in the retained window.'
      : `${formatAic(used)} of ${formatAic(allowed)} AIC across ${formatNumber(reportedRuns)} reported run${pluralSuffix(reportedRuns)}.`;
  const ariaLabel = ratio === null
    ? `${entry.name}: no utilization available`
    : `${entry.name}: ${formatAic(used)} of ${formatAic(allowed)} AI Credits used, ${formatPercent(ratio)}`;
  const scopeLabel = [entry.organization, entry.repository].filter(Boolean).join('/');

  return h(
    'article',
    {
      className: `campaign-utilization-card utilization-${status}`,
      dataset: {
        campaignId: entry.id,
        campaignKey: entry.key,
        campaignOrganization: entry.organization,
        campaignRepository: entry.repository
      }
    },
    h(
      'header',
      null,
      h(
        'span',
        { className: 'campaign-utilization-identity' },
        renderCampaignIdentityLink(entry, 'strong'),
        scopeLabel ? h('small', null, scopeLabel) : null
      ),
      h('span', { className: 'campaign-utilization-value' }, ratio === null ? '' : formatPercent(ratio))
    ),
    h(
      'div',
      { className: 'utilization-track', role: 'img', 'aria-label': ariaLabel },
      h('span', { style: `width: ${meterPercent.toFixed(2)}%` })
    ),
    h('p', null, detail),
    h(
      'small',
      null,
      entry.completeAttemptAllowance === null
        ? 'Complete campaign attempt allowance unavailable'
        : `${formatAic(entry.completeAttemptAllowance)} AIC allowance per complete campaign attempt`
    )
  );
}

/**
 * @param {Record<string, import('../presenter.js').LogicalSourceInput>} sources
 * @param {string} mode
 * @returns {HTMLElement}
 */
export function renderRunTrend(sources, mode = 'all') {
  const campaigns = summarizeCampaigns(rowsFor(sources, 'workflows'));
  const activity = campaignActivityRuns(campaigns, sources, mode);
  const runsSource = activity.source;
  const modeLabel = titleCase(mode);
  const heading = `${modeLabel} runs over time`;
  const headingId = 'campaigns-trend-heading';
  if (!runsSource || runsSource.metadata?.availability === 'unavailable') {
    return renderUnavailableRunTrend(heading, headingId, 'Campaign run data is unavailable.');
  }
  const allRuns = activity.rows;
  const trendDays = buildTrendDays(runsSource, allRuns);
  if (trendDays.length === 0) {
    return renderUnavailableRunTrend(heading, headingId, 'Campaign run trend is unavailable because no reporting date was provided.');
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
  const chartDescription = `Daily cumulative successful, failed, and cancelled ${modeLabel.toLowerCase()} campaign run counts.`;

  return h(
    'section',
    { className: 'campaign-trend-panel', 'aria-labelledby': headingId },
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
      h('span', { className: 'campaign-trend-group' }, 'Group by: ', h('strong', null, 'Status'))
    ),
    h(
      'div',
      { className: 'campaign-trend-legend', 'aria-label': 'Run status legend' },
      renderLegendItem('successful', 'Successful'),
      renderLegendItem('failed', 'Failed'),
      renderLegendItem('cancelled', 'Cancelled')
    ),
    h(
      'div',
      { className: 'campaign-trend-chart' },
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
        h('polyline', { className: 'campaign-chart-successful', points: trendPoints(series.successful, maximum) }),
        h('polyline', { className: 'campaign-chart-failed', points: trendPoints(series.failed, maximum) }),
        h('polyline', { className: 'campaign-chart-cancelled', points: trendPoints(series.cancelled, maximum) }),
        ...renderTrendPoints(trendDays, series, maximum)
      ),
      h(
        'div',
        { className: 'campaign-trend-axis' },
        h('span', null, formatDate(trendDays[0], true)),
        h('span', null, formatDate(trendDays.at(-1), true))
      )
    )
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
    { className: 'campaign-trend-panel', 'aria-labelledby': headingId },
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
  return h('span', null, renderLegendSwatch(`campaign-legend-${status}`), label);
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
      { className: 'campaign-chart-point', tabIndex: 0, role: 'img', 'aria-label': label },
      h('rect', { className: 'campaign-point-hit', x: x - 12, y: 40, width: 24, height: 170 }),
      ...Object.entries(values).map(([status, value]) => h('circle', {
        className: `campaign-point-marker campaign-point-marker-${status}`,
        cx: x,
        cy: 200 - (value * 150 / maximum),
        r: 5
      })),
      h(
        'g',
        { className: 'campaign-point-tooltip', transform: `translate(${tooltipX} 44)`, 'aria-hidden': 'true' },
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
function summarizeCampaigns(workflows) {
  /** @type {Map<string, Array<Record<string, unknown>>>} */
  const grouped = new Map();
  for (const row of workflows) {
    if (!isCampaignWorkflow(row)) continue;
    const campaignKey = scopedEntityKey(row, 'campaign');
    const rows = grouped.get(campaignKey) ?? [];
    rows.push(row);
    grouped.set(campaignKey, rows);
  }

  return [...grouped.entries()].map(([key, rows]) => {
    const firstRow = rows[0] ?? {};
    const uniqueWorkflowAllowances = new Map(rows
      .filter((row) => typeof row.workflow === 'string' && isNonNegativeNumber(row['max-ai-credits']))
      .map((row) => [scopedEntityKey(row, 'workflow'), /** @type {number} */ (row['max-ai-credits'])]));
    const summedAllowance = [...uniqueWorkflowAllowances.values()]
      .reduce((total, value) => total + value, 0);
    const id = String(firstRow.campaign);
    return {
      key,
      id,
      name: String(rows.find((row) => typeof row['campaign-name'] === 'string')?.['campaign-name'] ?? titleCase(id)),
      icon: String(rows.find((row) => typeof row['campaign-icon'] === 'string')?.['campaign-icon'] ?? 'goal'),
      organization: String(firstRow.organization ?? ''),
      repository: String(firstRow.repository ?? ''),
      completeAttemptAllowance: uniqueWorkflowAllowances.size > 0 ? summedAllowance : null,
      workflows: rows
    };
  }).sort((left, right) => left.name.localeCompare(right.name));
}

/** @param {string} campaignId */
function campaignInsightsHref(campaignId) {
  return `#page-campaign-insights?campaign=${encodeURIComponent(campaignId)}`;
}

/**
 * Renders the shared campaign-identity link (icon plus name) used by both the
 * summary table and the utilization card header, wrapping the name in the
 * caller-selected inline element.
 * @param {{ id: string, icon: string, name: string }} entry
 * @param {'span'|'strong'} nameTag
 * @returns {HTMLElement}
 */
function renderCampaignIdentityLink(entry, nameTag) {
  return renderIdentityLink({ href: campaignInsightsHref(entry.id), icon: entry.icon, label: entry.name, labelTag: nameTag });
}

/**
 * @param {ReturnType<typeof summarizeCampaigns>} campaigns
 * @param {Array<Record<string, unknown>>} usage
 * @param {string} mode
 * @returns {Map<string, { used: number, allowed: number, reportedRuns: number }>}
 */
function summarizeUtilization(campaigns, usage, mode) {
  const workflowDetails = new Map(campaigns.flatMap((entry) => entry.workflows.map((row) => [
    scopedEntityKey(row, 'workflow'),
    { campaignKey: entry.key, allowance: Number(row['max-ai-credits']) }
  ])));
  /** @type {Map<string, { campaignKey: string, used: number, allowance: number }>} */
  const runs = new Map();
  for (const row of usage) {
    if (mode !== 'all' && row['rollout-mode'] !== mode) continue;
    const details = workflowDetails.get(scopedEntityKey(row, 'workflow'));
    const aic = Number(row.aic);
    if (!details || !Number.isFinite(aic) || aic < 0) continue;
    const runId = String(row.run ?? row.invocation ?? '');
    if (!runId) continue;
    const key = JSON.stringify([details.campaignKey, scopedEntityKey(row, row.run == null ? 'invocation' : 'run')]);
    const run = runs.get(key) ?? {
      campaignKey: details.campaignKey,
      used: 0,
      allowance: Number.isFinite(details.allowance) && details.allowance > 0 ? details.allowance : 0
    };
    run.used += aic;
    runs.set(key, run);
  }
  /** @type {Map<string, { used: number, allowed: number, reportedRuns: number }>} */
  const totals = new Map();
  for (const run of runs.values()) {
    const total = totals.get(run.campaignKey) ?? { used: 0, allowed: 0, reportedRuns: 0 };
    total.used += run.used;
    total.allowed += run.allowance;
    total.reportedRuns += 1;
    totals.set(run.campaignKey, total);
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
function isCampaignWorkflow(row) {
  return typeof row.campaign === 'string'
    && row.campaign.length > 0
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
