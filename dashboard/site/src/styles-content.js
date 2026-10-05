export const contentStyles = `table { width: 100%; min-width: 600px; border-collapse: collapse; font-size: .875rem; }
caption { padding: 10px 14px; border-bottom: 1px solid var(--border); background: var(--canvas-subtle); color: var(--muted); text-align: left; font-weight: 600; font-size: .8125rem; }
th, td { padding: 10px 14px; border-bottom: 1px solid var(--border-muted); text-align: left; font-variant-numeric: tabular-nums; }
th:last-child, td:last-child { width: 100%; }
thead th { background: var(--canvas-subtle); color: var(--muted); font-size: .75rem; font-weight: 600; border-bottom: 1px solid var(--border); white-space: nowrap; }
.table-summary-row th { min-width: 150px; padding-block: 8px; vertical-align: top; white-space: normal; }
.table-summary-row th:first-child { padding-left: 38px; }
.table-summary-row th.table-compact-column { width: 44px; min-width: 44px; max-width: 44px; padding-right: 6px; padding-left: 6px; }
.table-summary-toggle { width: 24px; height: 24px; display: grid; place-items: center; float: left; margin-left: -30px; padding: 0; border: 1px solid var(--border); border-radius: 6px; background: var(--canvas); color: var(--muted); cursor: pointer; }
.table-summary-toggle:hover { background: var(--neutral-muted); color: var(--fg); }
.table-summary-toggle:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.table-summary-toggle .octicon { width: 14px; height: 14px; }
.table-summary-collapsed th { height: 40px; padding-block: 7px; vertical-align: middle; }
.table-summary-compact { min-width: 0; overflow: hidden; color: var(--fg); font-weight: 400; text-overflow: ellipsis; white-space: nowrap; }
.table-summary-compact[hidden], .table-summary-expanded[hidden] { display: none; }
.table-summary-compact-value { display: flex; min-width: 0; justify-content: space-between; gap: 8px; }
.table-summary-compact-value > :first-child { overflow: hidden; text-overflow: ellipsis; }
.table-summary-compact-value strong { flex: none; }
.table-summary-compact .table-summary-histogram { height: 24px; display: block; }
.table-summary-compact-chart .chart-widget { min-height: 26px; margin: 0; }
.table-summary-compact-chart .chart-widget svg { width: 26px; height: 26px; }
.table-summary-compact-chart .pie-chart-total-value, .table-summary-compact-chart .pie-chart-total-label { display: none; }
.table-summary-skeleton { display: grid; gap: 6px; padding-block: 2px; }
.table-summary-skeleton span { height: 10px; border-radius: 4px; background: linear-gradient(90deg, var(--canvas-subtle) 25%, var(--neutral-muted) 50%, var(--canvas-subtle) 75%); background-size: 200% 100%; animation: dashboard-skeleton-pulse 1.5s ease-in-out infinite; }
.table-summary-skeleton span:first-child { height: 32px; }
.table-summary-skeleton span:last-child { width: 72%; }
.table-summary-categories { display: grid; gap: 2px; margin: 0; padding: 0; list-style: none; font-weight: 400; }
.table-summary-categories li { display: flex; min-width: 0; justify-content: space-between; gap: 8px; }
.table-summary-categories li span { overflow: hidden; color: var(--fg); text-overflow: ellipsis; white-space: nowrap; }
.table-summary-categories strong, .table-summary-boolean strong, .table-summary-count strong { color: var(--fg); font-weight: 600; }
.table-summary-boolean { display: grid; grid-template-columns: 52px minmax(0, 1fr); align-items: center; gap: 8px; }
.table-summary-boolean .chart-widget { min-height: 52px; margin: 0; }
.table-summary-boolean .chart-widget svg { width: 52px; height: 52px; }
.table-summary-boolean .pie-chart-total-value, .table-summary-boolean .pie-chart-total-label { display: none; }
.table-summary-boolean .chart-legend { min-width: 0; display: grid; gap: 3px; margin: 0; }
.table-summary-boolean .chart-legend li { display: grid; grid-template-columns: 8px minmax(0, 1fr) auto; gap: 5px; }
.table-summary-boolean .chart-legend i { width: 8px; height: 8px; }
.table-summary-boolean .chart-legend strong { display: none; }
.table-summary-boolean .chart-widget .chart-series-1 { stroke: var(--success); }
.table-summary-boolean .chart-widget .chart-series-2 { stroke: var(--attention); }
.table-summary-boolean .chart-widget .chart-series-3 { stroke: var(--muted); }
.table-summary-boolean .chart-widget .chart-series-semantic-failure { stroke: var(--danger); }
.table-summary-boolean .chart-legend i.chart-series-1 { color: var(--success); }
.table-summary-boolean .chart-legend i.chart-series-2 { color: var(--attention); }
.table-summary-boolean .chart-legend i.chart-series-3 { color: var(--muted); }
.table-summary-boolean .chart-legend i.chart-series-semantic-failure { border-color: var(--danger); color: var(--danger); }
.table-summary-count { font-weight: 400; }
.table-summary-quantitative { display: grid; gap: 6px; }
.table-summary-histogram { width: 100%; max-width: 120px; height: 32px; overflow: visible; } /* cap at the SVG's natural viewBox width (histogram.js) so wide columns don't stretch the bars */
.table-summary-histogram rect { fill: var(--accent); opacity: .75; }
.table-output-evidence { display: block; max-width: 80ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tree-table-cell { display: block; padding-inline-start: calc(var(--tree-depth) * 1.25rem); }
:is(.table-summary-quantitative dl, .table-summary-temporal) { display: grid; gap: 2px; margin: 0; }
:is(.table-summary-quantitative dl, .table-summary-temporal) div { display: flex; justify-content: space-between; gap: 8px; }
:is(.table-summary-quantitative dl, .table-summary-temporal) dt { font-weight: 400; }
:is(.table-summary-quantitative dl, .table-summary-temporal) dd { margin: 0; color: var(--fg); font-weight: 600; }
.table-summary-empty { font-weight: 400; font-style: italic; }
.table-missing-value { color: var(--muted, GrayText); font-style: italic; }
tbody tr:last-child > * { border-bottom: 0; }
tbody tr:hover { background: var(--canvas-subtle); }
.kind, .status, .mode-badge, .workflow-badge { display: inline-flex; align-items: center; min-height: 20px; padding: 0 7px; border: 1px solid var(--border); border-radius: 2em; color: var(--muted); font-size: .6875rem; font-weight: 600; text-transform: capitalize; white-space: nowrap; }
.status-success { border-color: color-mix(in srgb, var(--success) 45%, var(--border)); background: var(--success-muted); color: var(--success); }
.status-attention { border-color: color-mix(in srgb, var(--attention) 45%, var(--border)); background: var(--attention-muted); color: var(--attention); }
.status-danger { border-color: color-mix(in srgb, var(--danger) 45%, var(--border)); background: var(--danger-muted, color-mix(in srgb, var(--danger) 10%, transparent)); color: var(--danger); }
.status-muted { background: var(--neutral-muted); }
.mode-live { border-color: color-mix(in srgb, var(--success) 45%, var(--border)); background: var(--success-muted); color: var(--success); }
.mode-review { border-color: color-mix(in srgb, var(--attention) 45%, var(--border)); background: var(--attention-muted); color: var(--attention); }
.outcome-view { display: grid; grid-template-columns: minmax(0, 1fr) 250px; align-items: start; gap: 24px; }
.discussion-post { min-width: 0; overflow: hidden; border: 1px solid var(--border); border-radius: 6px; }
.discussion-post > header { min-height: 56px; display: flex; align-items: center; gap: 10px; padding: 10px 16px; border-bottom: 1px solid var(--border); background: var(--canvas-subtle); }
.discussion-post > header p { margin: 1px 0 0; color: var(--muted); font-size: .75rem; }
.post-avatar { width: 32px; height: 32px; display: grid; flex: 0 0 32px; place-items: center; border-radius: 50%; background: var(--fg); color: var(--canvas); }
.markdown-body { padding: 24px 28px 32px; overflow-wrap: anywhere; font-size: .9375rem; }
.markdown-body > :first-child { margin-top: 0; }
.markdown-body > :last-child { margin-bottom: 0; }
.markdown-body h1, .markdown-body h2 { margin: 24px 0 16px; padding-bottom: 8px; border-bottom: 1px solid var(--border-muted); line-height: 1.25; }
.markdown-body h1 { font-size: 1.5rem; }
.markdown-body h2 { font-size: 1.25rem; }
.markdown-body h3 { margin: 20px 0 10px; font-size: 1.125rem; }
.markdown-body p, .markdown-body ul, .markdown-body ol, .markdown-body blockquote, .markdown-body pre, .markdown-body table { margin-block: 0 16px; }
.markdown-body li + li { margin-top: 4px; }
.markdown-body blockquote { margin-inline: 0; padding: 0 16px; border-left: 4px solid var(--border); color: var(--muted); }
.markdown-body .markdown-alert { color: var(--fg); }
.markdown-body .markdown-alert-note, .markdown-body .markdown-alert-important { border-left-color: var(--accent); }
.markdown-body .markdown-alert-tip { border-left-color: var(--success); }
.markdown-body .markdown-alert-warning { border-left-color: var(--attention); }
.markdown-body .markdown-alert-caution { border-left-color: var(--danger); }
.markdown-body .markdown-alert-title { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; color: var(--accent); font-weight: 600; }
.markdown-body .markdown-alert-tip .markdown-alert-title { color: var(--success); }
.markdown-body .markdown-alert-warning .markdown-alert-title { color: var(--attention); }
.markdown-body .markdown-alert-caution .markdown-alert-title { color: var(--danger); }
.markdown-body pre { max-width: 100%; overflow: auto; padding: 14px 16px; border-radius: 6px; background: var(--canvas-inset); }
.markdown-body pre code { padding: 0; background: transparent; }
.markdown-body img { max-width: 100%; height: auto; }
.markdown-body table { display: block; max-width: 100%; overflow-x: auto; border-spacing: 0; }
.dashboard-markdown.markdown-body table { width: 100%; min-width: 0; }
.markdown-body table th, .markdown-body table td { padding: 6px 12px; border: 1px solid var(--border); }
.markdown-body .task-list-item { list-style: none; }
.markdown-body input[type="checkbox"] { margin-right: 6px; }
.outcome-meta section { padding: 14px 0; border-bottom: 1px solid var(--border); }
.outcome-meta section:first-child { padding-top: 0; }
.outcome-meta h2 { margin: 0 0 8px; color: var(--muted); font-size: .75rem; }
.outcome-meta p { margin: 0; overflow-wrap: anywhere; }
.outcome-meta a { display: inline-flex; align-items: center; gap: 5px; }
.problem-view { display: grid; gap: 24px; }
.problem-view-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 24px; padding-bottom: 24px; border-bottom: 1px solid var(--border); }
.problem-view-badges { display: flex; flex-wrap: wrap; gap: 8px; }
.problem-view-summary { max-width: 72ch; margin: 12px 0 0; color: var(--muted); overflow-wrap: anywhere; }
.problem-view-highlights { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); margin: 0; border: 1px solid var(--border); border-radius: 6px; background: var(--canvas-subtle); }
.problem-view-highlights > div { min-width: 0; padding: 16px; border-right: 1px solid var(--border); }
.problem-view-highlights > div:last-child { border-right: 0; }
.problem-view-highlights dt, .problem-view-section dt { color: var(--muted); font-size: .75rem; font-weight: 600; }
.problem-view-highlights dd { margin: 5px 0 0; overflow-wrap: anywhere; font-size: 1rem; font-weight: 600; }
.problem-view-sections { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; }
.problem-view-section { min-width: 0; padding: 20px; border: 1px solid var(--border); border-radius: 6px; }
.problem-view-section h2 { margin: 0 0 16px; font-size: 1rem; }
.problem-view-section dl { display: grid; gap: 14px; margin: 0; }
.problem-view-section dd { margin: 4px 0 0; overflow-wrap: anywhere; }
.problem-view-log { min-width: 0; padding: 20px; border: 1px solid var(--border); border-radius: 6px; }
.problem-view-log h2 { margin: 0 0 16px; font-size: 1rem; }
.problem-view-log p { margin: 0; color: var(--muted); }
.problem-view-log pre { max-height: 32rem; margin: 0; overflow: auto; padding: 16px; border: 1px solid var(--border); border-radius: 6px; background: var(--canvas-subtle); color: var(--fg); font: .75rem/1.5 var(--font-mono); white-space: pre-wrap; overflow-wrap: anywhere; }
.mode-indicator { min-height: 22px; display: inline-flex; flex: none; align-items: center; gap: 5px; padding: 1px 7px; border: 1px solid var(--border); border-radius: 2em; font-size: .6875rem; font-weight: 600; text-transform: none; white-space: nowrap; }
.mode-indicator[hidden] { display: none; }
.mode-indicator .octicon { width: 13px; height: 13px; flex-basis: 13px; }
.provenance-section { margin-top: 24px; padding-top: 16px; border-top: 1px solid var(--border-muted); }
.provenance-list { margin: 8px 0 0; padding-left: 20px; color: var(--muted); font-size: .8125rem; }
.provenance-list li + li { margin-top: 4px; }
code { padding: 2px 4px; border-radius: 4px; background: var(--neutral-muted); font: .75rem var(--font-mono); }
footer { min-height: 44px; display: flex; flex: none; align-items: center; justify-content: space-between; gap: 16px; padding: 7px var(--dashboard-page-padding-inline); border-top: 1px solid var(--border); color: var(--muted); font-size: .75rem; }
.report-footer-status { min-width: 0; display: flex; align-items: center; gap: 5px; }
.report-footer-status time { color: var(--fg); font-weight: 600; white-space: nowrap; }
.report-footer-version { white-space: nowrap; }
.empty, .page-placeholder { margin: 0; padding: 28px 16px; color: var(--muted); text-align: center; }
.page-load-error { display: flex; align-items: flex-start; gap: 12px; width: min(100% - 32px, 560px); margin: 32px auto; padding: 20px; border: 1px solid var(--border); border-radius: 6px; background: var(--canvas-subtle); color: var(--fg); }
.page-load-error > .octicon { flex: none; color: var(--attention); }
.page-load-error-body h2 { margin: 0 0 8px; font-size: 1.125rem; }
.page-load-error-body p { margin: 0 0 12px; color: var(--muted); }
.page-load-error-body .page-load-error-detail { font-family: var(--font-mono); overflow-wrap: anywhere; }
.browser-support-message { min-height: 100vh; display: grid; place-items: center; padding: 24px; background: var(--canvas); color: var(--fg); }
.browser-support-message-panel { width: min(100%, 520px); padding: 24px; border: 1px solid var(--border); border-radius: 6px; background: var(--canvas-subtle); text-align: center; }
.browser-support-message-panel h1 { margin: 0 0 8px; font-size: 1.5rem; }
.browser-support-message-panel p { margin: 0; color: var(--muted); }
.source-refresh-error { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin: 0 0 16px; padding: 12px 14px; border: 1px solid var(--attention); border-radius: 6px; background: var(--attention-muted); }
.source-refresh-error-message { min-width: 0; }
.source-refresh-error-message strong { display: block; color: var(--fg); }
.source-refresh-error-message p { margin: 2px 0 0; color: var(--muted); font-size: .8125rem; }
.source-refresh-actions { display: flex; flex: none; align-items: center; gap: 6px; }
.source-refresh-retry { flex: none; background: var(--canvas); }
.source-refresh-dismiss { width: 28px; height: 28px; display: grid; place-items: center; padding: 0; border: 0; border-radius: 6px; background: transparent; color: var(--muted); cursor: pointer; }
.source-refresh-dismiss:hover { background: var(--neutral-muted); color: var(--fg); }
.source-loading-warning { color: var(--attention); }
.dashboard-lazy-view { min-height: var(--dashboard-lazy-view-min-height); display: grid; align-content: stretch; }
.dashboard-lazy-view-skeleton { min-height: inherit; display: grid; align-content: start; gap: 12px; padding: 16px; border-radius: 6px; background: var(--canvas); }
.dashboard-lazy-view-skeleton > span { height: 16px; border-radius: 4px; background: linear-gradient(90deg, var(--canvas-subtle) 25%, var(--neutral-muted) 50%, var(--canvas-subtle) 75%); background-size: 200% 100%; animation: dashboard-skeleton-pulse 1.5s ease-in-out infinite; }
.dashboard-lazy-view-skeleton > span:first-child { width: 38%; height: 20px; }
.dashboard-lazy-view-skeleton > span:last-child { width: 72%; }
.dashboard-view-skeleton { min-height: 280px; display: grid; grid-template-columns: repeat(12, minmax(0, 1fr)); align-content: start; gap: 14px; padding: 20px; border-radius: 12px; background: var(--canvas); }
.dashboard-loading-status, .dashboard-snapshot-status { margin: 0; padding: 12px 16px; color: var(--muted); font-size: .875rem; }
.dashboard-snapshot-status { border-bottom: 1px solid var(--border); background: var(--canvas-subtle); }
.dashboard-view-skeleton-block { grid-column: span var(--dashboard-view-skeleton-span, 12); height: var(--dashboard-view-skeleton-height, 64px); border-radius: 8px; background: linear-gradient(90deg, var(--canvas-subtle) 25%, var(--neutral-muted) 50%, var(--canvas-subtle) 75%); background-size: 200% 100%; opacity: 0; animation: dashboard-skeleton-pulse 1.5s ease-in-out infinite, dashboard-skeleton-enter .5s ease-out forwards; animation-delay: 0s, var(--dashboard-view-skeleton-delay, 0ms); }
.skeleton-card { min-height: 104px; }
.skeleton-panel { min-height: 280px; grid-column: 1 / -1; }
.sr-only { width: 1px; height: 1px; position: absolute; overflow: hidden; margin: -1px; padding: 0; clip: rect(0 0 0 0); white-space: nowrap; }
@keyframes dashboard-skeleton-pulse {
  from { background-position: 200% 0; }
  to { background-position: -200% 0; }
}
@keyframes dashboard-skeleton-enter {
  from { opacity: 0; transform: translateY(8px) scale(.98); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}
`;
