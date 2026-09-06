/**
 * Registry for JSON-selected dashboard UI elements.
 */

import { h } from '../dom.js';
import { octicon } from '../octicons.js';
import { formatClockDuration } from '../view-formatters.js';
import { findLink } from './link-content.js';
import { renderPackagesView, renderPackageSummary, renderPackageUtilization, renderRunTrend } from './packages-view.js';
import { renderPackageRouteVariant, renderPackageRouteView } from './package-route-view.js';
import { renderOutcomeDetail } from './outcome-detail.js';
import { isOutcomeDetailSectionConfig, renderOutcomeDetailSection } from './outcome-detail-sections.js';
import { renderSectionHeading, isPlainObject, renderIdentityLink, renderDlRow, renderIconSpan } from './ui-primitives.js';
import { renderDefinitionList, renderPageSection, renderViewSectionChrome } from './view-chrome.js';
import { renderAnomalyReadiness } from './anomaly-readiness.js';
import { renderWorkflowRouteView } from './workflow-route-view.js';
import { renderConfigurationView } from './configuration-view.js';
import { renderConfigurationActions } from './configuration-actions.js';
import { renderExperimentsEvaluation } from './experiments-evaluation.js';
import { modeBadgeClassName } from './badge.js';
import { rowsFor as rowsForSource } from './source-rows.js';
import { renderPackagesModeShell } from './packages-mode-shell.js';
import { renderWorkflowRoutePage } from './workflow-route-page.js';
/**
 * @typedef {{
 *   pageId: string,
 *   title: string,
 *   description?: string,
 *   sourceNames: string[],
 *   sources: Record<string, import('../presenter.js').LogicalSourceInput>,
 *   contextDetails: string[],
 *   scope?: Record<string, unknown>,
 *   routeParameter?: string,
 *   titleLink?: Record<string, unknown>,
 *   element?: string,
 *   viewId?: string,
 *   elementConfig?: { body?: string, sections?: string[], section?: string },
 *   headingTag: 'h3'|'h4'
 * }} ElementRenderContext
 */

/** @type {Map<string, (context: ElementRenderContext) => HTMLElement | null>} */
const ELEMENT_RENDERERS = new Map([
  ['domain-attention', renderDomainAttentionElement],
  ['package-status-grid', renderPackageStatusGridElement],
  ['summary-grid', renderSummaryGridElement],
  ['readiness-verdict', renderReadinessVerdictElement],
  ['context-summary', renderContextSummaryElement],
  ['anomaly-readiness', renderAnomalyReadinessElement],
  ['signal-list', renderSignalListElement],
  ['package-activity', ({ sources, pageId }) => renderPackagesView(sources, pageId)],
  ['package-utilization', ({ sources }) => renderPackageUtilization(sources)],
  ['package-run-trend', ({ sources }) => renderRunTrend(sources)],
  ['package-summary-table', ({ sources }) => renderPackageSummary(sources)],
  ['package-activity-shell', renderPackageActivityShellElement],
  ['package-insights', (context) => renderPackageRouteVariant(context, 'insights')],
  ['package-detail', (context) => renderPackageRouteVariant(context, 'workflows')],
  ['package-dispatches', (context) => renderPackageRouteVariant(context, 'dispatches')],
  ['package-reports', (context) => renderPackageRouteVariant(context, 'reports')],
  ['package-route', renderPackageRouteView],
  ['workflow-route', renderWorkflowRouteView],
  ['workflow-route-page', renderWorkflowRoutePage],
  ['outcome-detail', renderOutcomeDetail],
  ['outcome-detail-section', renderOutcomeDetailSectionElement],
  ['configuration-policy', renderConfigurationView],
  ['configuration-actions', renderConfigurationActions],
  ['experiments-evaluation', renderExperimentsEvaluation]
]);

const EMPTY_AWARE_ELEMENTS = new Set(['summary-grid', 'readiness-verdict', 'context-summary', 'signal-list', 'package-insights', 'package-detail', 'package-dispatches', 'package-reports', 'package-route', 'workflow-route', 'workflow-route-page', 'outcome-detail', 'outcome-detail-section', 'configuration-policy', 'configuration-actions', 'experiments-evaluation', 'package-activity-shell']);

/**
 * @param {string} name
 * @param {ElementRenderContext} context
 * @returns {HTMLElement | null}
 */
export function renderUiElement(name, context) {
  return ELEMENT_RENDERERS.get(name)?.({ ...context, element: name }) ?? null;
}

/**
 * @param {ElementRenderContext} context
 * @returns {HTMLElement | null}
 */
function renderOutcomeDetailSectionElement(context) {
  const outcomes = rowsFor(context, 'outcomes');
  const sectionConfig = isOutcomeDetailSectionConfig(context.elementConfig)
    ? context.elementConfig
    : null;
  if (!sectionConfig) return null;
  const outcomeId = stringValue(context.scope?.['safe-output']);
  const outcome = outcomes.find((row) => String(row['safe-output']) === outcomeId);
  return outcome ? renderOutcomeDetailSection(outcome, sectionConfig.body) : null;
}

/**
 * @param {ElementRenderContext} context
 * @returns {HTMLElement}
 */
function renderPackageActivityShellElement(context) {
  return renderPackagesModeShell({
    pageId: context.pageId,
    sections: [
      {
        id: 'utilization',
        render: (mode) => renderPackageUtilization(context.sources, mode)
      },
      {
        id: 'run-trend',
        render: (mode) => renderRunTrend(context.sources, mode)
      },
      {
        id: 'summary',
        render: (mode) => renderPackageSummary(context.sources, mode)
      }
    ]
  });
}

/**
 * @param {string} name
 * @returns {boolean}
 */
export function elementHandlesEmptyRows(name) {
  return EMPTY_AWARE_ELEMENTS.has(name);
}

/**
 * @param {ElementRenderContext} context
 */
function renderDomainAttentionElement(context) {
  const rows = rowsFor(context, 'overview-attention-domains');
  const headingId = `${context.pageId}-${slugify(context.title)}-heading`;
  return h(
    'section',
    { className: 'overview-observability', 'aria-labelledby': headingId },
    renderSectionHeading({
      kicker: 'Current decision window',
      id: headingId,
      title: context.title,
      description: context.description,
      headingTag: 'h2'
    }),
    h(
      'div',
      { className: 'attention-domain-grid' },
      ...rows.map((row) => h(
        'a',
        {
          className: `attention-domain-card attention-domain-${stringValue(row.tone)}`,
          href: stringValue(row.href)
        },
        h(
          'header',
          null,
          renderIconSpan('attention-domain-icon', stringValue(row.icon)),
          h('strong', null, stringValue(row.domain)),
          h('span', { className: 'attention-domain-state' }, stringValue(row.state))
        ),
        h('span', { className: 'attention-domain-value' }, stringValue(row.value)),
        h('p', null, stringValue(row.detail)),
        h('footer', null, 'Open evidence')
      ))
    ),
    h(
      'p',
      { className: 'overview-method-note' },
      h('strong', null, 'State key:'),
      ' Act now is a direct failure; Investigate is a direct control, collection, or attribution signal; Monitor has observations without a direct signal; Unavailable means a required threshold or evidence feed is absent.'
    )
  );
}

/**
 * @param {ElementRenderContext} context
 */
function renderPackageStatusGridElement(context) {
  const rows = rowsFor(context, 'overview-managed-packages');
  const headingId = `${context.pageId}-${slugify(context.title)}-heading`;
  return h(
    'section',
    { className: 'overview-package-status', 'aria-labelledby': headingId },
    renderSectionHeading({
      kicker: 'Managed packages',
      id: headingId,
      title: context.title,
      description: context.description,
      headingTag: 'h2'
    }),
    h(
      'div',
      { className: 'package-status-grid' },
      ...rows.map((row) => {
        const liveCoveragePercent = Number(row['live-coverage-percent']);
        const rolloutLiveRepositories = Number(row['rollout-live-repositories']);
        const rolloutRepositories = Number(row['rollout-repositories']);
        const coverageKnown = Number.isFinite(liveCoveragePercent) && Number.isFinite(rolloutLiveRepositories) && rolloutRepositories > 0;
        const coveragePercent = coverageKnown ? Math.min(100, Math.max(0, liveCoveragePercent)) : null;
        const reviewRepositories = coverageKnown ? rolloutRepositories - rolloutLiveRepositories : null;
        const dispatchCount = row['dispatch-count'] == null ? null : Number(row['dispatch-count']);
        const runTelemetryUnavailable = context.sources.runs?.metadata?.availability === 'unavailable' || !context.sources.runs;
        const outputCollectionUnavailable = context.sources.outcomes?.metadata?.availability === 'unavailable' || !context.sources.outcomes;
        const dispatchStatus = packageDispatchStatus(row, dispatchCount, runTelemetryUnavailable);
        const outputDispatchCount = row['dispatches-with-safe-output'] == null ? null : Number(row['dispatches-with-safe-output']);
        const dispatchText = Number.isFinite(dispatchCount)
          ? `${dispatchCount} dispatch${dispatchCount === 1 ? '' : 'es'}`
          : runTelemetryUnavailable ? 'Run telemetry unavailable' : 'Dispatches unavailable';
        const outputCountsKnown = dispatchCount !== null && outputDispatchCount !== null && Number.isFinite(dispatchCount) && Number.isFinite(outputDispatchCount);
        const outputText = outputCountsKnown
          ? (dispatchCount ?? 0) > 0 ? `${outputDispatchCount}/${dispatchCount} produced output` : 'No output opportunity'
          : outputCollectionUnavailable ? 'Output collection unavailable' : 'Outputs unavailable';
        const noOutputWarning = outputCountsKnown && (dispatchCount ?? 0) > 0 && outputDispatchCount === 0;
        const repoModes = Array.isArray(row['repository-modes']) ? row['repository-modes'].filter(isPlainObject) : [];
        const repoEntries = repoModes.length > 0 ? repoModes.filter((entry) => typeof entry.repository === 'string' && entry.repository) : [];
        const inventoryText = stringValue(row.inventory || 'Needs attention');
        return h(
          'article',
          {
            className: `package-status-card package-status-${stringValue(row['inventory-state']) === 'inventory-ready' ? 'ready' : 'attention'}`
          },
          h(
            'header',
            { className: 'package-status-header' },
            h('strong', null, renderIdentityLink({ href: stringValue(row.href), icon: stringValue(row.icon) || 'package', label: stringValue(row.title), className: 'package-status-identity' })),
            inventoryText === 'Ready' ? null : h('span', { className: 'package-status-state' }, inventoryText)
          ),
          h(
            'div',
            { className: 'package-status-live-coverage' },
            h(
              'div',
              { className: 'package-status-live-coverage-heading' },
              h('div', null, h('span', null, 'Rollout'), h('strong', null, coverageKnown ? `${rolloutLiveRepositories} live · ${reviewRepositories} review` : 'No target data')),
              h('strong', null, coverageKnown ? `${coveragePercent}% live` : 'Unknown')
            ),
            coverageKnown ? h('progress', {
              max: 100,
              value: coveragePercent,
              'aria-label': `${rolloutLiveRepositories} of ${rolloutRepositories} target repositories are live`
            }) : null
          ),
          h(
            'div',
            { className: 'package-status-runtime' },
            h(
              'div',
              { className: 'package-status-repository-heading' },
              h('span', null, 'Target repositories'),
              h('span', null, 'Mode')
            ),
            repoEntries.length > 0
              ? h(
                  'ul',
                  { className: 'package-status-repositories' },
                  ...repoEntries.map((entry) => {
                    const repoMode = stringValue(entry.mode || 'review');
                    return h(
                      'li',
                      null,
                      h('span', { className: 'package-status-repository-name' }, octicon('repo'), h('span', null, stringValue(entry.repository))),
                      h('span', { className: `mode-badge ${modeBadgeClassName(repoMode.toLowerCase())}`.trim() }, octicon('dot-fill'), capitalize(repoMode))
                    );
                  })
                )
              : h('p', { className: 'package-status-repositories-empty' }, 'No repositories reported')
          ),
          h(
            'a',
            {
              className: `package-status-activity${noOutputWarning ? ' package-status-activity-warning' : ''}`,
              href: `#page-package-dispatches?package=${encodeURIComponent(stringValue(row.package))}`,
              title: stringValue(row['activity-window']),
              'aria-label': `Recent activity: ${dispatchStatus.detail}; ${dispatchText}; ${outputText}${noOutputWarning ? '; warning: dispatches produced no output' : ''}`
            },
            h(
              'span',
              { className: 'package-status-activity-heading' },
              h('span', { className: 'package-status-activity-label' }, 'Recent'),
              h(
                'span',
                {
                  className: `package-status-activity-state package-status-activity-state-${dispatchStatus.tone}`,
                  title: dispatchStatus.detail
                },
                octicon(dispatchStatus.icon),
                dispatchStatus.label
              )
            ),
            h('span', null, octicon('paper-airplane'), h('strong', null, dispatchText)),
            h(
              'span',
              noOutputWarning ? { title: 'Dispatched but produced no output' } : null,
              octicon(noOutputWarning ? 'alert' : 'shield-check'),
              h('strong', null, outputText)
            )
          )
        );
      })
    )
  );
}

/**
 * @param {Record<string, unknown>} row
 * @param {number | null} dispatchCount
 * @param {boolean} runTelemetryUnavailable
 */
function packageDispatchStatus(row, dispatchCount, runTelemetryUnavailable = false) {
  const successful = row['dispatch-success-count'] == null ? null : Number(row['dispatch-success-count']);
  const failed = row['dispatch-failure-count'] == null ? null : Number(row['dispatch-failure-count']);
  const approval = row['dispatch-approval-count'] == null ? null : Number(row['dispatch-approval-count']);
  const pending = row['dispatch-pending-count'] == null ? null : Number(row['dispatch-pending-count']);
  if (![dispatchCount, successful, failed, approval, pending].every(Number.isFinite)) {
    return {
      tone: 'unknown',
      icon: 'circle',
      label: 'Unknown',
      detail: runTelemetryUnavailable
        ? 'Recent dispatch status is unavailable because run telemetry was not collected.'
        : 'Recent dispatch status unavailable'
    };
  }

  const other = Math.max(0, Number(dispatchCount) - Number(successful) - Number(failed) - Number(approval) - Number(pending));
  const details = [
    Number(successful) > 0 ? `${successful} succeeded` : '',
    Number(failed) > 0 ? `${failed} failed` : '',
    Number(approval) > 0 ? `${approval} awaiting approval` : '',
    Number(pending) > 0 ? `${pending} in progress` : '',
    other > 0 ? `${other} other` : ''
  ].filter(Boolean);
  const detail = details.join(', ') || 'No recent dispatches';
  if (Number(failed) > 0) return { tone: 'failed', icon: 'x-circle', label: `${failed} failed`, detail };
  if (Number(approval) > 0) return { tone: 'attention', icon: 'clock', label: `${approval} awaiting approval`, detail };
  if (Number(pending) > 0) return { tone: 'attention', icon: 'sync', label: `${pending} in progress`, detail };
  if (other > 0) return { tone: 'unknown', icon: 'alert', label: `${other} other`, detail };
  if (Number(dispatchCount) > 0) return { tone: 'success', icon: 'check-circle', label: `${successful} succeeded`, detail };
  return { tone: 'unknown', icon: 'dash', label: 'None', detail };
}

/** @param {ElementRenderContext} context */
function renderSummaryGridElement(context) {
  const rows = rowsFor(context, context.sourceNames[0]).map((row) => ({
    label: stringValue(row.label),
    value: stringValue(row.value)
  }));
  return renderDefinitionList('summary-grid', rows);
}

/** @param {ElementRenderContext} context */
function renderReadinessVerdictElement(context) {
  const rows = rowsFor(context, context.sourceNames[0]);
  const verdict = stringValue(rows.find((row) => row.label === 'Control plane')?.value) || 'Evidence incomplete';
  const tone = verdict === 'Ready to ship' ? 'ready' : verdict === 'Not ready' ? 'blocked' : 'unknown';
  const checks = rowsFor(context, 'readiness-checks');
  const signals = rowsFor(context, 'readiness-signals');
  const observations = rowsFor(context, 'readiness-observations');
  const metadata = context.sources[context.sourceNames[0]]?.metadata;
  const blocking = signals.filter((row) => stringValue(row.tone) === 'critical' || Number(row.priority) === 0);
  const stateLabel = tone === 'ready' ? 'READY' : tone === 'blocked' ? 'BLOCKED' : 'UNKNOWN';
  const icon = tone === 'ready' ? 'check-circle' : tone === 'blocked' ? 'x-circle' : 'question';
  const evidenceRows = rows.filter((row) => row.label !== 'Control plane' && row.label !== 'Unblock first');
  return h(
    'section',
    { className: `readiness-verdict readiness-verdict-${tone}`, role: 'status', 'aria-label': 'Control-plane readiness' },
    h(
      'div',
      { className: 'readiness-verdict-primary' },
      h('div', { className: 'readiness-hero' },
        h('small', null, 'Control-plane readiness'),
        h('div', { className: 'readiness-state' },
          renderIconSpan('readiness-verdict-icon', icon, { ariaHidden: true }),
          h('strong', null, stateLabel)
        ),
        h('p', null, tone === 'ready'
          ? 'The control plane is ready to execute the next scheduled operation.'
          : tone === 'blocked'
            ? 'The control plane should not be treated as ready for the next operation.'
            : 'Current readiness cannot be determined reliably.'),
        h('div', { className: 'readiness-snapshot-meta' },
          h('span', null, h('strong', null, 'Snapshot'), ` ${snapshotAge(metadata)}`),
          h('span', null, h('strong', null, 'Evidence'), ` ${evidenceState(metadata)}`)
        ),
        h('span', { className: 'readiness-verdict-legacy' }, verdict)
      ),
      h('div', { className: 'readiness-verdict-summary' },
        h('strong', null, tone === 'ready' ? 'All required readiness gates passed.' : tone === 'blocked' ? `${blocking.length} blocking gate${blocking.length === 1 ? '' : 's'}` : 'Evidence is stale or incomplete.'),
        h('span', null, `${signals.filter((row) => stringValue(row.tone) === 'warning').length} warning${signals.filter((row) => stringValue(row.tone) === 'warning').length === 1 ? '' : 's'}`)
      )
    ),
    h('div', { className: 'readiness-verdict-details' },
      readinessBlock('Unblock first', blocking.length > 0
        ? blocking.map((row) => h('article', { className: 'readiness-blocker' },
          h('strong', null, stringValue(row.title || row.kind)),
          h('p', null, stringValue(row.detail)),
          h('small', null, stringValue(row.evidence))
        ))
        : rows.find((row) => row.label === 'Unblock first')
          ? [h('p', { className: 'readiness-clear' }, stringValue(rows.find((row) => row.label === 'Unblock first')?.value))]
        : [h('p', { className: 'readiness-clear' }, 'No blocking conditions.')]),
      readinessBlock('Readiness gates', checks.map((row) => h('div', { className: `readiness-gate readiness-gate-${stringValue(row['readiness-state']).toLowerCase()}` },
        octicon(stringValue(row['readiness-state']) === 'Ready' ? 'check-circle' : stringValue(row['readiness-state']) === 'Blocked' ? 'stop' : 'question'),
        h('span', null, h('strong', null, stringValue(row.check)), h('small', null, stringValue(row.detail)))
      ))),
      readinessBlock(observations.length > 0 ? 'Other observations' : 'Evidence', observations.length > 0
        ? observations.map((row) => h('div', { className: 'readiness-observation' },
          h('strong', null, stringValue(row.signal)),
          h('span', null, stringValue(row.detail))
        ))
        : evidenceRows.map((row) => h('div', { className: 'readiness-evidence-row' },
          h('span', null, stringValue(row.label)),
          h('strong', null, stringValue(row.value))
        )))
    )
  );
}

/** @param {string} title @param {Array<HTMLElement|string|null>} content */
function readinessBlock(title, content) {
  return h('section', { className: 'readiness-block' }, h('h3', null, title), h('div', { className: 'readiness-block-content' }, ...content));
}

/** @param {import('../presenter.js').SourceMetadata | undefined} metadata */
function snapshotAge(metadata) {
  const value = metadata?.['as-of'] || metadata?.['retrieved-at'];
  if (!value) return 'Unavailable';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC · ${elapsedSince(date)}`;
}

/** @param {Date} date */
function elapsedSince(date) {
  const minutes = Math.max(0, Math.round((Date.now() - date.getTime()) / 60000));
  return minutes < 60 ? `${minutes}m ago` : `${Math.floor(minutes / 60)}h ${minutes % 60}m ago`;
}

/** @param {import('../presenter.js').SourceMetadata | undefined} metadata */
function evidenceState(metadata) {
  if (!metadata || metadata.availability === 'unavailable') return 'Unavailable';
  if (metadata.completeness !== 'complete' || metadata.freshness !== 'fresh') return 'Incomplete';
  return '✓ Complete';
}

/**
 * @param {ElementRenderContext} context
 */
function renderContextSummaryElement(context) {
  const rows = context.sourceNames
    .flatMap((sourceName) => rowsFor(context, sourceName))
    .filter(isContextSummaryRow);
  return h(
    'dl',
    { className: 'context-summary', 'aria-label': context.title },
    ...rows.map((row) => renderDlRow(stringValue(row.label), renderContextSummaryValue(row)))
  );
}

/** @param {ElementRenderContext} context */
function renderAnomalyReadinessElement(context) {
  const sourceName = context.sourceNames[0];
  const row = sourceName ? rowsFor(context, sourceName)[0] : undefined;
  return row ? renderAnomalyReadiness(row) : null;
}

/** @param {Record<string, unknown>} row */
function isContextSummaryRow(row) {
  return typeof row.label === 'string'
    && (['string', 'number', 'boolean'].includes(typeof row.value) || Array.isArray(row.items));
}

/**
 * @param {Record<string, unknown>} row
 * @returns {Array<string | HTMLElement | null>}
 */
function renderContextSummaryValue(row) {
  if (!Array.isArray(row.items)) return [stringValue(row.value)];
  return row.items.filter(isPlainObject).flatMap((item, index) => {
    const label = stringValue(item.label);
    const href = safeNavigationHref(item['navigation-href']);
    return [
      index > 0 ? ', ' : null,
      href ? h('a', { href }, label) : label
    ];
  });
}

/** @param {ElementRenderContext} context */
function renderSignalListElement(context) {
  const sourceName = context.sourceNames[0];
  const source = context.sources[sourceName];
  const isCanonicalAttention = sourceName === 'attention-signals';
  const sourceRows = rowsFor(context, sourceName);
  const rows = isCanonicalAttention ? rankCanonicalAttention(sourceRows).slice(0, 1) : sourceRows;
  const list = h(
    'div',
    { className: `signal-list-region${isCanonicalAttention ? ' canonical-attention-list' : ''}` },
    context.description && !isCanonicalAttention ? h('p', { className: 'signal-boundary-note' }, context.description) : null,
    h(
      'ol',
      { className: 'signal-list' },
      ...(rows.length > 0
        ? rows.map((row, index) => renderSignal(row, index, isCanonicalAttention))
        : [h(
          'li',
          { className: 'signal-clear' },
          renderIconSpan('signal-icon', 'check-circle'),
          h('span', { className: 'signal-copy' }, h('strong', null, isCanonicalAttention
            ? 'No unresolved attention signals'
            : 'No signals require attention'))
        )])
    )
  );
  if (!isCanonicalAttention || !source) return list;
  return renderPageSection(
    context.pageId,
    context.title,
    [...renderViewSectionChrome(source.metadata, context.contextDetails), list],
    context.headingTag,
    context.description
  );
}

/**
 * @param {Record<string, unknown>} row
 * @param {number} index
 * @param {boolean} [isCanonicalAttention]
 */
function renderSignal(row, index, isCanonicalAttention = false) {
  const link = isCanonicalAttention
    ? findLink(row, 'evidence-link') ?? findLink(row, 'run-link') ?? findLink(row, 'external-link')
    : findLink(row, 'run-link') ?? findLink(row, 'external-link');
  const navigationHref = safeNavigationHref(row['navigation-href']);
  const navigationPage = stringValue(row['navigation-page']);
  const consequence = stringValue(row['consequence-tier']);
  const urgency = stringValue(row.urgency) || consequence;
  const kind = stringValue(row.kind) || humanizeSignalLabel(row['signal-type']);
  const title = stringValue(row.title) || stringValue(row.objective);
  const reason = stringValue(row.detail) || stringValue(row.reason);
  const scope = isCanonicalAttention ? stringValue(row.scope) : '';
  const ageSeconds = Number(row['age-seconds']);
  const age = isCanonicalAttention && Number.isFinite(ageSeconds)
    ? `${formatClockDuration(ageSeconds * 1000)} old`
    : '';
  const evidence = stringValue(row.evidence) || (isCanonicalAttention
    ? [stringValue(row['expected-actor']), age].filter(Boolean).join(' · ')
    : '');
  const tone = stringValue(row.tone) || canonicalAttentionTone(consequence);
  const content = [
    isCanonicalAttention
      ? h(
          'span',
          { className: 'signal-rank signal-priority-rank', 'aria-hidden': 'true' },
          h('strong', null, String(index + 1)),
          h('small', null, 'Priority')
        )
      : h('span', { className: 'signal-rank', 'aria-hidden': 'true' }, String(index + 1)),
    renderIconSpan('signal-icon', stringValue(row.icon) || 'issue'),
    h(
      'span',
      { className: 'signal-copy' },
      h('span', null, [urgency, kind].filter(Boolean).join(' · ')),
      h('strong', null, title),
      h('small', null, [scope, reason].filter(Boolean).join(' · '))
    ),
    h(
      'span',
      { className: 'signal-evidence' },
      h('strong', null, evidence),
      h('small', null, stringValue(row.action) || 'View details')
    )
  ];
  const className = `signal-item signal-${tone || 'informational'}${isCanonicalAttention ? ' canonical-attention-item' : ''}`;
  if (link) {
    return h('li', { className }, h('a', { href: link.href, 'aria-label': link.label }, ...content));
  }
  if (navigationPage) {
    return h('li', { className }, h('a', { href: `#page-${navigationPage}`, dataset: { navPageId: navigationPage } }, ...content));
  }
  if (navigationHref) {
    return h('li', { className }, h('a', { href: navigationHref }, ...content));
  }
  return h('li', { className }, h('div', null, ...content));
}

/** @param {unknown} value */
function humanizeSignalLabel(value) {
  return stringValue(value).replace(/[-_]+/g, ' ');
}

/** @param {string} consequence */
function canonicalAttentionTone(consequence) {
  if (['critical', 'high'].includes(consequence.toLowerCase())) return 'critical';
  if (consequence.toLowerCase() === 'low') return 'informational';
  return 'action';
}

/** @param {Array<Record<string, unknown>>} rows */
function rankCanonicalAttention(rows) {
  return [...rows].sort((left, right) => {
    const priority = numericValue(left.priority) - numericValue(right.priority);
    if (priority !== 0) return priority;
    const age = numericValue(right['age-seconds']) - numericValue(left['age-seconds']);
    if (age !== 0) return age;
    return stringValue(left['attention-signal-id']).localeCompare(stringValue(right['attention-signal-id']));
  });
}

/** @param {unknown} value */
function numericValue(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
}

/** @param {unknown} value */
function safeNavigationHref(value) {
  if (typeof value !== 'string' || !value.startsWith('#')) return null;
  try {
    const url = new URL(value, 'https://dashboard.invalid/');
    return url.origin === 'https://dashboard.invalid' && url.hash === value ? value : null;
  } catch {
    return null;
  }
}

/**
 * @param {ElementRenderContext} context
 * @param {string} sourceName
 */
function rowsFor(context, sourceName) {
  return rowsForSource(context.sources, sourceName);
}

/**
 * @param {unknown} value
 */
function stringValue(value) {
  return value == null ? '' : String(value);
}

/**
 * @param {string} value
 */
function capitalize(value) {
  return value.length === 0 ? value : `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

/**
 * @param {string} value
 */
function slugify(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'element';
}
