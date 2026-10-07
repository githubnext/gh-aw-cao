export const componentStyles = `.metric-link a, .custom-table a { display: inline-flex; align-items: center; gap: 4px; border-radius: 4px; transition: background-color 120ms ease, color 120ms ease; }
.metric-link a:hover, .custom-table a:hover { background: var(--neutral-muted); }
.metric-link .octicon, .custom-table a .octicon { width: 12px; height: 12px; }
.campaign-runs-page .table-status-detail, .dispatches-page .table-status-detail { min-width: 360px; max-width: 560px; padding: 14px 16px; font-size: .875rem; white-space: normal; line-height: 1.5; }
.campaign-runs-page .table-status-detail[data-status="failure"], .campaign-runs-page .table-status-detail[data-status="startup-failure"], .campaign-runs-page .table-status-detail[data-status="timed-out"],
.dispatches-page .table-status-detail[data-status="failure"], .dispatches-page .table-status-detail[data-status="startup-failure"], .dispatches-page .table-status-detail[data-status="timed-out"] { border-left: 3px solid var(--danger); background: var(--danger-muted, color-mix(in srgb, var(--danger) 10%, transparent)); color: var(--danger); font-weight: 600; }
.campaign-runs-page .table-status-detail[data-status="action-required"], .dispatches-page .table-status-detail[data-status="action-required"] { border-left: 3px solid var(--attention); background: var(--attention-muted); color: var(--attention); font-weight: 600; }
.campaign-runs-page .table-status-detail > a, .dispatches-page .table-status-detail > a { color: inherit; font-weight: inherit; text-decoration: underline; text-underline-offset: 2px; }
.campaign-runs-page .chart-view-pie:first-of-type .pie-chart-total-value { fill: var(--danger); }
.table-intent-action { width: 1%; text-align: left; white-space: nowrap; }
.custom-table :is(th.table-compact-column, td.table-cli-action-cell) { width: 44px; min-width: 44px; max-width: 44px; padding-right: 6px; padding-left: 6px; text-align: center; }
.table-intent-control { display: inline-grid; place-items: center; }
.table-intent-button { min-height: 32px; display: inline-flex; align-items: center; gap: 7px; padding: 4px 10px; border: 1px solid var(--accent); border-radius: 6px; background: var(--accent-muted); color: var(--accent); font: inherit; font-size: .75rem; font-weight: 600; white-space: nowrap; cursor: pointer; }
.table-intent-button:hover { background: var(--accent); color: var(--canvas); }
.problem-view-header .table-intent-button { border-color: var(--accent); background: var(--accent); color: var(--canvas); }
.table-intent-button:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
.table-intent-button .octicon { width: 14px; height: 14px; }
.table-cli-action-control { display: inline-grid; place-items: center; }
.table-cli-action-button { width: 32px; height: 32px; display: grid; place-items: center; padding: 0; border: 1px solid var(--border); border-radius: 6px; background: var(--canvas-subtle); color: var(--fg); cursor: pointer; }
.table-cli-action-button:hover { border-color: var(--accent); background: var(--accent-muted); color: var(--accent); }
.table-cli-action-button .octicon { width: 16px; height: 16px; margin: 0; }
.table-intent-dialog { width: min(680px, calc(100vw - 32px)); height: fit-content; max-width: none; max-height: calc(100dvh - 32px); margin: auto; padding: 0; overflow: hidden; border: 1px solid var(--border); border-radius: 8px; background: var(--canvas); box-shadow: 0 16px 48px color-mix(in srgb, var(--canvas-inset) 70%, transparent); color: var(--fg); }
.table-intent-dialog[open] { display: grid; grid-template-rows: auto minmax(0, 1fr) auto; align-content: start; }
.table-intent-dialog::backdrop { background: color-mix(in srgb, var(--canvas-inset) 72%, transparent); }
.table-intent-dialog-header { min-width: 0; display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 14px 16px; border-bottom: 1px solid var(--border); background: var(--canvas-subtle); text-align: left; }
.table-intent-dialog-header h2 { margin: 0; font-size: 1rem; }
.table-intent-dialog-close { width: 28px; height: 28px; display: grid; flex: 0 0 28px; place-items: center; padding: 0; border: 0; border-radius: 6px; background: transparent; color: var(--muted); cursor: pointer; }
.table-intent-dialog-close:hover { background: var(--neutral-muted); color: var(--fg); }
.table-intent-preview { max-height: min(60vh, 560px); margin: 0; padding: 18px; overflow: auto; background: var(--canvas); color: var(--fg); font: .8125rem/1.55 var(--font-mono); letter-spacing: 0; text-align: left; white-space: pre-wrap; overflow-wrap: anywhere; }
.table-intent-dialog-footer { min-height: 58px; display: flex; align-items: center; justify-content: flex-end; gap: 12px; padding: 10px 16px; border-top: 1px solid var(--border); background: var(--canvas-subtle); }
.table-intent-copy-status { min-width: 0; flex: 1; color: var(--muted); text-align: left; }
.table-intent-copy-button { min-height: 34px; display: inline-flex; align-items: center; gap: 7px; padding: 5px 12px; border: 1px solid var(--accent); border-radius: 6px; background: var(--accent); color: var(--canvas); font: inherit; font-weight: 600; cursor: pointer; }
.table-intent-copy-button:hover { filter: brightness(1.08); }
.table-intent-copy-button:disabled { cursor: progress; opacity: .65; }
.table-intent-copy-button[data-copy-state="success"] { border-color: var(--success); }
.table-intent-copy-button[data-copy-state="error"] { border-color: var(--danger); }
h3 { margin: 16px 0 8px; font-size: 1rem; font-weight: 600; }
.metrics { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; margin: 0 0 20px; overflow: visible; }
.metrics div, .data-state-summary > div { min-width: 0; min-height: 90px; padding: 14px 16px; border: 1px solid var(--border); border-radius: 0; background: var(--canvas-subtle); }
.data-state-summary { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; margin: 0 0 20px; }
.data-state-summary[hidden] { display: none; }
.data-state-summary dt, .metrics dt { color: var(--muted); font-size: .75rem; font-weight: 600; text-transform: uppercase; margin: 0; }
.data-state-summary dd, .metrics dd { margin: 4px 0 0; font-size: 1.375rem; font-weight: 600; font-variant-numeric: tabular-nums; text-transform: capitalize; }
.data-state-summary dd[data-state-axis="availability"] { color: var(--fg); }
.summary-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 14px; margin-bottom: 20px; }
.summary-card { padding: 14px 16px; border: 1px solid var(--border); border-radius: 0; background: var(--canvas-subtle); }
.summary-card h4 { margin: 0 0 8px; font-size: .875rem; color: var(--muted); font-weight: 600; text-transform: uppercase; }
.summary-list, .run-status-counts, .run-conclusion-counts, .run-outcome-counts { list-style: none; margin: 0 0 16px; padding: 0; display: flex; flex-wrap: wrap; gap: 8px; }
.summary-list li, .run-status-counts li, .run-conclusion-counts li, .run-outcome-counts li { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border: 1px solid var(--border); border-radius: 2em; background: var(--canvas-subtle); font-size: .75rem; font-weight: 600; }
.route-tabs, .repository-tabs { max-width: 100%; display: flex; gap: 4px; margin-bottom: 24px; overflow-x: auto; border-bottom: 1px solid var(--border); }
.route-tabs a, .repository-tabs a { display: inline-flex; align-items: center; gap: 8px; position: relative; padding: 10px 14px 12px; color: var(--fg); font-weight: 600; white-space: nowrap; text-decoration: none; }
.route-tabs a > .octicon, .repository-tabs a > .octicon { color: var(--muted); }
.route-tabs a:hover, .repository-tabs a:hover { background: var(--canvas-subtle); }
.route-tabs a[aria-current="page"]::after, .repository-tabs a[aria-current="page"]::after { content: ""; height: 2px; position: absolute; right: 8px; bottom: -1px; left: 8px; background: var(--danger); }
.workflow-badge-operation, .workflow-badge-orchestrator { border-color: var(--accent); color: var(--accent); }
.workflow-identity { display: flex; align-items: center; justify-content: space-between; gap: 24px; margin-bottom: 24px; }
.workflow-identity p { margin: 7px 0 0; }
.workflow-identity > a { display: inline-flex; align-items: center; gap: 5px; flex: none; }
.workflow-badges { display: flex; flex-wrap: wrap; gap: 5px; }
.workflow-badge-campaign { border-color: var(--accent); background: var(--accent-muted); color: var(--accent); text-decoration: none; }
.workflow-reports { overflow: hidden; border: 1px solid var(--border); border-radius: 6px; background: var(--canvas); }
.workflow-reports-search { min-height: 56px; display: flex; align-items: center; gap: 8px; margin: 12px 20px; padding: 6px 14px; border: 1px solid var(--border); border-radius: 6px; color: var(--muted); }
.workflow-reports-search:focus-within { outline: 2px solid var(--focus); outline-offset: -2px; }
.workflow-reports-search input { min-width: 0; flex: 1; border: 0; outline: 0; background: transparent; color: var(--fg); font: inherit; }
.workflow-reports-search input::placeholder { color: var(--muted); opacity: 1; }
.workflow-reports-header { min-height: 64px; display: flex; align-items: center; justify-content: space-between; padding: 10px 22px; border-top: 1px solid var(--border); background: var(--canvas-subtle); }
.workflow-reports-header h2 { margin: 0; font-size: 1.25rem; }
.workflow-reports-header > div { color: var(--muted); }
.workflow-reports-header > div span { margin-left: 20px; }
.workflow-filter-announcement { width: 1px; height: 1px; position: absolute; overflow: hidden; margin: -1px; padding: 0; border: 0; clip: rect(0 0 0 0); white-space: nowrap; }
.workflow-report-table-region { overflow-x: auto; border-top: 1px solid var(--border); }
.workflow-report-table { min-width: 760px; }
.workflow-report-table thead th { background: var(--canvas); }
.workflow-report-table :is(th, td) { padding: 10px 14px; }
.workflow-report-table th:first-child { width: 100%; }
.workflow-report-table tbody th { min-width: 280px; font-weight: 400; }
.workflow-report-table tbody td { white-space: nowrap; }
.workflow-report-primary { min-width: 0; display: grid; grid-template-columns: 40px minmax(0, 1fr); align-items: center; gap: 12px; }
.workflow-report-icon { width: 40px; height: 40px; display: grid; place-items: center; border: 1px solid var(--border); border-radius: 6px; color: var(--muted); }
.workflow-report-icon .octicon { width: 18px; height: 18px; }
.workflow-report-copy { min-width: 0; display: grid; }
.workflow-report-title { overflow: hidden; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.workflow-report-title a { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.workflow-report-summary { margin-top: 3px; overflow: hidden; color: var(--muted); text-overflow: ellipsis; white-space: nowrap; }
.workflow-report-table time, .workflow-report-time { color: var(--muted); }
.workflow-runtime-content { max-width: 100%; }
.workflow-runtime-summary { max-width: 920px; margin-bottom: 24px; }
.workflow-runtime-metrics { display: grid; grid-template-columns: minmax(360px, 1.7fr) repeat(2, minmax(180px, 1fr)); gap: 14px; margin: 0; }
.workflow-runtime-metrics > div { min-width: 0; min-height: 184px; padding: 20px 22px; border: 1px solid var(--border); border-radius: 6px; }
.workflow-runtime-metrics dt { font-size: 1rem; font-weight: 600; }
.workflow-runtime-metrics dd { margin: 8px 0 0; font-size: 1.75rem; font-weight: 600; font-variant-numeric: tabular-nums; }
.workflow-runtime-metrics p { margin: 5px 0 0; color: var(--muted); }
.workflow-run-health > dd { display: flex; align-items: center; gap: 14px; }
.workflow-health-chart > .chart-widget { width: 84px; min-height: 84px; margin: 0; border: 0; background: transparent; }
.workflow-health-chart > .chart-widget svg { width: 84px; height: 84px; }
.workflow-health-chart .pie-chart-total-value, .workflow-health-chart .pie-chart-total-label { opacity: 0; }
.workflow-health-chart .chart-widget .chart-series-1 { stroke: var(--success); }
.workflow-health-chart .chart-widget .chart-series-2 { stroke: var(--danger); }
.workflow-health-chart .chart-widget .chart-series-3 { stroke: var(--attention); }
.workflow-health-chart .chart-widget .chart-series-4 { stroke: var(--accent); }
.workflow-health-chart .chart-widget .chart-series-5 { stroke: var(--muted); }
.workflow-health-total { display: flex; flex-direction: column; line-height: 1.1; text-transform: uppercase; }
.workflow-health-total strong { font-size: 1.75rem; }
.workflow-health-total small { color: var(--muted); font-size: .6875rem; letter-spacing: .04em; }
.workflow-run-health > .chart-legend { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 5px 16px; margin: 10px 0 0; }
.workflow-run-health > .chart-legend li { display: grid; grid-template-columns: 9px minmax(0, 1fr) auto auto; }
.workflow-run-health > .chart-legend i { width: 9px; height: 9px; border: 0; border-radius: 50%; }
.workflow-run-health > .chart-legend li:nth-child(1) i { background: var(--success); }
.workflow-run-health > .chart-legend li:nth-child(2) i { background: var(--danger); }
.workflow-run-health > .chart-legend li:nth-child(3) i { background: var(--attention); }
.workflow-run-health > .chart-legend li:nth-child(4) i { background: var(--accent); }
.workflow-run-health > .chart-legend li:nth-child(5) i { background: var(--muted); }
.workflow-run-health > .chart-legend small { display: none; }
.value-report { overflow: hidden; border: 1px solid var(--border); border-radius: 6px; background: var(--canvas); }
.value-report > header { min-height: 76px; display: flex; align-items: flex-start; justify-content: space-between; gap: 24px; padding: 16px; border-bottom: 1px solid var(--border); }
.value-report > header h2 { margin: 0; font-size: 1.125rem; }
.value-report > header p { max-width: 760px; margin: 3px 0 0; color: var(--muted); font-size: .75rem; }
.value-score { flex: none; text-align: right; }
.value-score strong, .value-score span { display: block; }
.value-score strong { font-size: 1.5rem; font-variant-numeric: tabular-nums; }
.value-score span { color: var(--muted); font-size: .6875rem; }
.value-chart { min-height: 180px; padding: 18px 16px 24px; border-bottom: 1px solid var(--border); background: var(--canvas-subtle); }
.value-history { display: grid; gap: 16px; margin-bottom: 16px; }
.value-history-panel { min-width: 0; padding: 16px; border: 1px solid var(--border); border-radius: 6px; background: var(--canvas); }
.value-history-panel > header { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; margin-bottom: 8px; }
.value-history-panel > header h3 { margin: 0; font-size: 1rem; }
.value-history-panel > header p { margin: 0; color: var(--muted); font-size: .75rem; text-align: right; }
.value-history-panel > .chart-widget { min-height: 220px; margin: 0; border: 0; background: transparent; }
.value-history-panel > .chart-widget svg { width: 100%; max-width: none; }
.diagnostic-chart svg { width: 100%; min-height: 220px; overflow: visible; }
.diagnostic-gain-zone { fill: var(--success-muted); }
.diagnostic-loss-zone { fill: var(--danger-muted); }
.diagnostic-baseline { stroke: var(--fg); stroke-width: 1; stroke-dasharray: 3 2; vector-effect: non-scaling-stroke; }
.diagnostic-axis-label { fill: var(--muted); font-size: 2.5px; }
.diagnostic-series { stroke-width: 2.5; stroke-linecap: round; stroke-linejoin: round; vector-effect: non-scaling-stroke; }
.diagnostic-point { fill: var(--canvas); stroke-width: 1.5; vector-effect: non-scaling-stroke; }
.value-diagnostic-legend { margin-bottom: 0; }
.value-diagnostic-legend li { flex: 1 1 220px; }
.value-diagnostic-legend strong { margin-left: auto; color: var(--muted); font-variant-numeric: tabular-nums; }
.value-diagnostic-legend .value-gain { color: var(--success); }
.value-diagnostic-legend .value-loss { color: var(--danger); }
.value-attainment .primary-weekly { stroke: var(--attention); opacity: .42; }
.value-attainment .line-chart-point.primary-weekly { r: .55px; }
.value-attainment .primary-rolling { stroke: var(--attention); stroke-width: 4; }
.value-attainment .line-chart-point.primary-rolling { fill: var(--attention); opacity: 0; }
.value-attainment .chart-legend { margin-bottom: 0; }
.value-attainment .chart-legend .primary-weekly { border-color: var(--attention); opacity: .42; }
.value-attainment .chart-legend .primary-rolling { border-color: var(--attention); border-top-width: 4px; }
.value-chart > dl { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 1px; margin: 0; overflow: hidden; border: 1px solid var(--border); border-radius: 6px; background: var(--border); }
.value-chart > dl > div { min-width: 0; padding: 18px; background: var(--canvas); }
.value-chart dt { color: var(--muted); font-size: .75rem; font-weight: 600; text-transform: uppercase; }
.value-chart dd { margin: 4px 0 0; overflow: hidden; font-size: 1.375rem; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.value-chart dd code { font-size: .875rem; }
.value-details-disclosure > summary, .value-details-unavailable { min-height: 44px; display: flex; align-items: center; padding: 10px 16px; color: var(--fg); font-size: .75rem; font-weight: 600; }
.value-details-disclosure > summary { cursor: pointer; }
.value-details-disclosure > summary:hover { background: var(--canvas-subtle); }
.value-details-disclosure[open] > summary { border-bottom: 1px solid var(--border); }
.value-details-unavailable { color: var(--muted); }
.value-details { padding: 16px; }
.value-details h3 { margin: 0 0 4px; }
.value-details h3 + p { margin: 0 0 12px; color: var(--muted); font-size: .75rem; }
.value-details .table-region { margin-bottom: 0; }
.value-report-empty > header { align-items: center; }
.value-empty { min-height: 360px; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 36px 24px; border-bottom: 1px solid var(--border); text-align: center; }
.value-empty > .octicon { width: 30px; height: 30px; color: var(--muted); }
.value-empty h3 { margin: 16px 0 5px; font-size: 1.125rem; }
.value-empty p { max-width: 620px; margin: 0; color: var(--muted); }
.repositories-page .custom-view-grid { display: block; }
.repository-health { margin-bottom: 24px; }
.repository-health .section-heading { align-items: end; }
.repository-health .section-heading > span { flex: none; color: var(--muted); font-size: .75rem; }
.repository-health-table { min-width: 850px; }
.repository-health-table th:first-child { font-weight: 600; }
.repository-health-table td { white-space: nowrap; }
.failure-rate { display: flex; flex-direction: column; }
.failure-rate span { color: var(--muted); font-size: .6875rem; }
.overview-content { display: grid; gap: 24px; }
.scope-kicker { color: var(--muted); font-size: .75rem; font-weight: 600; text-transform: uppercase; }
.section-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 24px; margin-bottom: 12px; }
.section-heading h2 { margin: 0 0 3px; font-size: 1.25rem; }
.section-heading p { margin: 0; color: var(--muted); }
.overview-observability { margin-bottom: 24px; }
.overview-observability > .section-heading { align-items: end; }
.overview-method-note { margin: 10px 0 0; color: var(--muted); font-size: .6875rem; }
.overview-method-note strong { color: var(--fg); }
.overview-campaign-status { margin-bottom: 24px; }
.section-heading h3 { margin: 1px 0 3px; font-size: 1.25rem; }
.workflow-attention { margin-bottom: 32px; }
.workflow-attention > .section-heading { align-items: end; }
.workflow-attention > .section-heading > strong { flex: none; font-variant-numeric: tabular-nums; }
.runtime-page [data-section-id="runtime-triage"] .custom-view-grid { gap: 0; }
.workflow-attention-list { margin: 0; padding: 0; border: 1px solid var(--border); border-top: 0; border-radius: 0 0 6px 6px; list-style: none; }
.workflow-attention-list li { min-width: 0; border-top: 1px solid var(--border-muted); }
.workflow-attention-list li:first-child { border-top: 0; }
.workflow-attention-list a, .workflow-attention-static { min-height: 68px; display: grid; grid-template-columns: 24px 20px minmax(0, 1fr) minmax(150px, auto); align-items: center; gap: 10px; padding: 9px 14px; color: var(--fg); text-decoration: none; }
.workflow-attention-list a:hover { background: var(--canvas-subtle); }
.workflow-attention-note { margin: 7px 0 0; color: var(--muted); font-size: .6875rem; }
.control-plane-status { overflow: hidden; border-radius: 6px; }
.control-plane-status > header { min-height: 104px; display: flex; align-items: center; padding: 18px 20px; border: 1px solid var(--border); border-left-width: 4px; border-radius: 6px 6px 0 0; background: var(--canvas-subtle); }
.control-plane-critical > header { border-left-color: var(--danger); background: color-mix(in srgb, var(--danger) 7%, var(--canvas)); }
.control-plane-monitoring > header { border-left-color: var(--attention); background: color-mix(in srgb, var(--attention) 7%, var(--canvas)); }
.control-plane-healthy > header { border-left-color: var(--success); background: color-mix(in srgb, var(--success) 7%, var(--canvas)); }
.control-plane-heading { min-width: 0; display: flex; align-items: center; gap: 16px; }
.control-plane-state-icon { width: 40px; height: 40px; display: grid; flex: 0 0 40px; place-items: center; border-radius: 50%; background: var(--canvas); box-shadow: 0 0 0 1px var(--border); }
.control-plane-state-icon .octicon { width: 20px; height: 20px; }
.control-plane-critical .control-plane-state-icon { color: var(--danger); }
.control-plane-monitoring .control-plane-state-icon { color: var(--attention); }
.control-plane-healthy .control-plane-state-icon { color: var(--success); }
.control-plane-heading h3 { margin: 2px 0; font-size: 1.375rem; }
.control-plane-heading p { max-width: 760px; margin: 0; color: var(--muted); font-size: .875rem; }
.control-plane-vitals { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 1px; margin: 0; padding: 0 1px 1px; border-right: 1px solid var(--border); border-left: 1px solid var(--border); background: var(--border); }
.control-plane-vitals > div { min-width: 0; padding: 14px 16px; background: var(--canvas); }
.control-plane-vitals dt { color: var(--muted); font-size: .75rem; font-weight: 600; text-transform: uppercase; }
.control-plane-vitals dd { margin: 2px 0 0; font-size: 1.75rem; font-weight: 600; font-variant-numeric: tabular-nums; }
.control-plane-vitals p { min-height: 2.6em; margin: 0; color: var(--muted); font-size: .75rem; line-height: 1.3; }
.control-plane-vitals .vital-failures dd { color: var(--danger); }
.execution-health { padding: 10px 16px 12px; border: 1px solid var(--border); border-top: 0; border-radius: 0 0 6px 6px; background: var(--canvas); }
.execution-health-heading { display: flex; align-items: center; justify-content: space-between; gap: 16px; font-size: .8125rem; }
.execution-health-heading span { overflow: hidden; color: var(--muted); text-overflow: ellipsis; white-space: nowrap; }
.execution-track { height: 8px; display: flex; margin-top: 8px; overflow: hidden; border-radius: 4px; background: var(--neutral-muted); }
.execution-track span { height: 100%; display: block; }
.execution-success { background: var(--success); }
.execution-failed { background: var(--danger); }
.execution-approval { background: var(--attention); }
.execution-other { background: var(--muted); }
.execution-legend { display: flex; flex-wrap: wrap; gap: 5px 18px; margin: 8px 0 0; padding: 0; color: var(--muted); font-size: .75rem; list-style: none; }
.execution-legend li { display: flex; align-items: center; gap: 6px; }
.execution-legend li > span { width: 8px; height: 8px; border-radius: 2px; }
.execution-legend strong { color: var(--fg); font-variant-numeric: tabular-nums; }
.legend-success { background: var(--success); }
.legend-failed { background: var(--danger); }
.legend-approval { background: var(--attention); }
.legend-other { background: var(--muted); }
.campaign-tabs { max-width: 100%; min-height: 48px; display: flex; gap: 8px; margin-bottom: 20px; padding-top: 8px; overflow: visible; border-bottom: 1px solid var(--border); }
.campaign-tabs a { min-height: 40px; display: inline-flex; align-items: center; gap: 8px; position: relative; padding: 0 8px; border-radius: 6px 6px 0 0; color: var(--fg); font-size: .875rem; text-decoration: none; white-space: nowrap; }
.campaign-tabs a > .octicon { color: var(--muted); }
.campaign-tabs a:hover { background: var(--neutral-muted); }
.campaign-tabs a[aria-current="page"] { font-weight: 600; }
.campaign-tabs a[aria-current="page"]::after { content: ""; height: 2px; position: absolute; right: 0; bottom: -1px; left: 0; border-radius: 2px 2px 0 0; background: var(--accent); }
.campaign-tabs .tab-trailing-icon { display: none; }
.memory-page .custom-view-grid, .memory-page .custom-view[data-view-layout="full-view"] { height: 100%; }
.dashboard-full-view main.dashboard-prototype:has(.memory-page:not([hidden])) { padding: 0; }
.dashboard-full-view .memory-page .custom-view-grid > .custom-view[data-view-layout="full-view"] { padding: 0; }
.cao-memory-browser { height: 100%; min-height: 28rem; overflow: hidden; background: var(--canvas); }
.cao-memory-layout { height: 100%; min-height: 0; display: grid; grid-template-columns: minmax(15rem, 24%) minmax(0, 1fr); overflow: hidden; }
.cao-memory-tree { min-width: 0; padding: 12px; overflow: auto; border-right: 1px solid var(--border); background: var(--canvas); }
.cao-memory-tree h2 { margin: 4px 8px 12px; color: var(--muted); font-size: .75rem; text-transform: uppercase; }
.cao-memory-tree ul { margin: 0; padding: 0; list-style: none; }
.cao-memory-campaign-branch > summary, .campaign-memory-directory > summary { min-width: 0; min-height: 32px; display: flex; align-items: center; gap: 8px; padding: 5px 8px; border-radius: 6px; font-size: .875rem; cursor: pointer; list-style: none; }
.cao-memory-campaign-branch > summary::-webkit-details-marker, .campaign-memory-directory > summary::-webkit-details-marker { display: none; }
.cao-memory-campaign-branch > summary > span, .campaign-memory-directory > summary > span, .cao-memory-campaign-disabled > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.memory-tree-chevron { color: var(--muted); }
:is(.cao-memory-campaign-branch, .campaign-memory-directory)[open] > summary > .memory-tree-chevron { transform: rotate(90deg); }
.cao-memory-campaign-branch > summary:focus-visible, .campaign-memory-directory > summary:focus-visible, .campaign-memory-file:focus-visible { outline: 2px solid var(--focus); outline-offset: -2px; }
.cao-memory-campaign-branch > summary:hover, .campaign-memory-directory > summary:hover { background: var(--neutral-muted); }
.cao-memory-campaign-disabled { min-width: 0; min-height: 32px; display: flex; align-items: center; gap: 8px; padding: 5px 8px; color: var(--muted); font-size: .875rem; }
.cao-memory-campaign-disabled > .octicon { color: var(--muted); }
.cao-memory-tree-status > ul, .campaign-memory-directory > ul { padding-inline-start: 16px; }
.cao-memory-tree-status > .empty-message { margin: 4px 8px 8px 16px; }
.cao-memory-file-content { min-width: 0; min-height: 0; display: flex; flex-direction: column; padding: 20px; overflow: hidden; }
.cao-memory-file-content > .memory-file-body { min-width: 0; min-height: 0; flex: 1; overflow: auto; }
.memory-file-header { margin: 0 0 16px; }
.memory-file-header h2 { margin: 0; font-size: 1rem; overflow-wrap: anywhere; }
.cao-memory-file-content pre { width: 100%; min-width: 0; min-height: 0; margin: 0; padding: 16px; overflow: visible; border-radius: 6px; background: var(--canvas-inset); color: var(--fg); font: .75rem/1.5 var(--font-mono, ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace); white-space: pre-wrap; overflow-wrap: anywhere; }
.cao-memory-file-content pre > code, .campaign-memory-content pre > code { display: block; min-width: 0; overflow-wrap: anywhere; }
.campaign-memory-browser { min-width: 0; }
.campaign-memory-warning { margin: 0 0 12px; padding: 10px 12px; border: 1px solid color-mix(in srgb, var(--attention) 45%, var(--border)); border-radius: 6px; background: var(--attention-muted); color: var(--fg); }
.campaign-memory-layout { min-height: 28rem; display: grid; grid-template-columns: minmax(14rem, 28%) minmax(0, 1fr); overflow: hidden; border: 1px solid var(--border); border-radius: 6px; background: var(--canvas); }
.campaign-memory-files { min-width: 0; padding: 12px; overflow: auto; border-right: 1px solid var(--border); background: var(--canvas); }
.campaign-memory-branch { margin: 0 4px 12px; color: var(--muted); font-size: .75rem; overflow-wrap: anywhere; }
.campaign-memory-files ul { margin: 0; padding: 0; list-style: none; }
.campaign-memory-file { width: 100%; min-width: 0; min-height: 32px; display: flex; align-items: center; gap: 8px; padding: 5px 8px; border: 0; border-radius: 6px; background: transparent; color: var(--fg); font: inherit; font-size: .875rem; text-align: start; cursor: pointer; }
.campaign-memory-file:hover { background: var(--neutral-muted); }
.campaign-memory-file[aria-current="true"] { background: var(--accent-muted); color: var(--accent); font-weight: 600; }
.campaign-memory-file > .octicon { flex: 0 0 16px; color: var(--muted); }
.campaign-memory-file .memory-file-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.campaign-memory-content { min-width: 0; min-height: 0; display: flex; flex-direction: column; padding: 20px; overflow: hidden; }
.campaign-memory-content pre { width: 100%; min-width: 0; min-height: 0; flex: 1; margin: 0; padding: 16px; overflow: auto; border-radius: 6px; background: var(--canvas-inset); color: var(--fg); font: .75rem/1.5 var(--font-mono, ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace); white-space: pre-wrap; overflow-wrap: anywhere; }
.campaign-detail-page .custom-view-grid, .campaign-detail-page .custom-view-grid > * { min-width: 0; }
.dashboard-markdown { min-width: 0; padding: 24px 28px 32px; border: 1px solid var(--border); border-radius: 6px; background: var(--canvas); }
.workflow-badge-orchestrator { border-color: var(--accent); color: var(--accent); }
.workflow-badge-worker { border-color: var(--success); color: var(--success); }
.configuration-view { display: grid; gap: 20px; }
.configuration-view.show-server-logs > :not(.configuration-server-logs-view) { display: none; }
.configuration-server-logs-view { min-width: 0; }
.configuration-server-logs-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; margin-bottom: 16px; }
.configuration-server-logs-toolbar h2 { margin: 0; font-size: 1.125rem; }
.configuration-server-logs-view pre { min-width: 0; margin: 0; padding: 16px; border-radius: 6px; background: var(--canvas-inset); color: var(--fg); font: .75rem/1.5 var(--font-mono, ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace); white-space: pre-wrap; overflow-wrap: anywhere; }
.configuration-server-logs-view pre > code { display: block; }
.configuration-browser-settings { overflow: hidden; border: 1px solid var(--border); border-radius: 6px; background: var(--canvas); }
.configuration-browser-settings-heading { padding: 10px 12px; border-bottom: 1px solid var(--border); background: var(--canvas-subtle); }
.configuration-browser-settings-heading h3 { margin: 0; font-size: .875rem; }
.configuration-browser-settings-heading p, .configuration-browser-setting-status { margin: 2px 0 0; color: var(--muted); font-size: .75rem; }
.configuration-browser-setting-status { padding: 0 12px 10px; }
.configuration-local-data-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 12px; }
.configuration-debug-copy { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 8px; }
.configuration-transactions-button, .reset-dashboard-trigger { min-height: 34px; display: inline-flex; align-items: center; gap: 7px; padding: 6px 10px; border: 1px solid; border-radius: 6px; background: var(--canvas); font: inherit; font-size: .8125rem; font-weight: 600; cursor: pointer; }
.configuration-transactions-button { border-color: var(--border); color: var(--fg); text-decoration: none; }
.configuration-transactions-button:hover { background: var(--neutral-muted); }
.reset-dashboard-trigger { border-color: var(--danger); color: var(--danger); }
.reset-dashboard-trigger:hover { background: var(--danger-muted, color-mix(in srgb, var(--danger) 10%, transparent)); }
.reset-dashboard-trigger .octicon { width: 15px; height: 15px; }
.configuration-editor { overflow: hidden; border: 1px solid var(--border); border-radius: 6px; background: var(--canvas); }
.configuration-editor-toolbar { min-height: 46px; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 7px 12px; border-bottom: 1px solid var(--border); background: var(--canvas-subtle); }
.configuration-editor-toolbar > div { display: flex; align-items: center; gap: 10px; }
.configuration-editor-toolbar strong { font-size: .875rem; }
.configuration-edit-status { padding-left: 10px; border-left: 1px solid var(--border); color: var(--muted); font-size: .75rem; }
.configuration-edit-status[data-state="modified"] { color: var(--attention); font-weight: 600; }
.configuration-editor-actions { justify-content: flex-end; flex-wrap: wrap; }
.configuration-copy-button, .configuration-reset-button, .configuration-diagnostics-button { min-height: 28px; display: inline-flex; align-items: center; gap: 5px; padding: 3px 9px; border: 1px solid var(--border); border-radius: 6px; background: var(--canvas-subtle); color: var(--fg); font: inherit; font-size: .75rem; font-weight: 600; cursor: pointer; }
.configuration-copy-button { border-color: var(--success); color: var(--success); }
.configuration-reset-button:hover, .configuration-diagnostics-button:hover { background: var(--neutral-muted); }
.configuration-copy-button:hover { filter: brightness(.94); }
.configuration-copy-status { color: var(--muted); font-size: .75rem; }
.configuration-settings { display: grid; }
.configuration-setting-group { border-bottom: 1px solid var(--border); }
.configuration-setting-group .configuration-setting-group { margin: 0 10px 10px; border: 1px solid var(--border); border-radius: 6px; }
.configuration-setting-group > summary { min-height: 38px; display: flex; align-items: center; gap: 8px; padding: 6px 12px; background: var(--canvas-subtle); cursor: pointer; font-size: .8125rem; font-weight: 600; list-style-position: inside; }
.configuration-setting-group > summary small { margin-left: auto; color: var(--muted); font-size: .75rem; font-weight: 400; }
.configuration-setting-description { margin: 0; padding: 7px 12px; border-top: 1px solid var(--border-muted); color: var(--muted); font-size: .75rem; }
.configuration-setting-row { min-height: 70px; display: grid; grid-template-columns: minmax(0, 1fr) minmax(220px, 38%); align-items: center; gap: 18px; padding: 9px 12px; border-top: 1px solid var(--border-muted); }
.configuration-setting-copy { min-width: 0; }
.configuration-setting-copy label { display: block; font-size: .875rem; font-weight: 600; }
.configuration-setting-label { display: block; font-size: .875rem; font-weight: 600; }
.configuration-setting-copy code { display: block; margin-top: 2px; color: var(--muted); font-size: .6875rem; overflow-wrap: anywhere; }
.configuration-setting-copy p { margin: 3px 0 0; color: var(--muted); font-size: .75rem; line-height: 1.35; }
.configuration-setting-row :is(input:not([type="checkbox"]), select, textarea) { width: 100%; min-height: 34px; padding: 6px 10px; border: 1px solid var(--border); border-radius: 6px; background: var(--canvas); color: var(--fg); font: inherit; font-size: .8125rem; }
.configuration-setting-row textarea { resize: vertical; line-height: 1.45; }
.configuration-setting-toggle { width: 32px; height: 18px; justify-self: end; accent-color: var(--accent); }
.configuration-save-note { margin: 0; padding: 8px 12px; background: var(--canvas-subtle); color: var(--muted); font-size: .6875rem; }
.configuration-unavailable { padding: 16px; border: 1px dashed var(--danger); border-radius: 6px; color: var(--muted); }
:is(.readiness-page, .runtime-page, .security-page, .firewall-page, .value-page, .cost-page, .github-api-page) .layout-section { padding: 0; border: 0; background: transparent; }
:is(.readiness-page, .runtime-page, .security-page, .firewall-page, .value-page, .cost-page, .github-api-page) .layout-section-header { display: flex; align-items: end; justify-content: space-between; gap: 24px; }
:is(.readiness-page, .runtime-page, .security-page, .firewall-page, .value-page, .cost-page, .github-api-page) .layout-section-header h3 { margin: 2px 0 0; font-size: 1.25rem; }
:is(.readiness-page, .runtime-page, .security-page, .firewall-page, .value-page, .cost-page, .github-api-page) .layout-section-header > strong { flex: none; color: var(--muted); font-size: .75rem; }
:is(.runtime-page, .security-page, .firewall-page, .value-page) .layout-section .page-section > h4,
:is(.runtime-page, .security-page, .firewall-page, .value-page) .layout-section .page-section > .chart-prompt-heading > h4,
:is(.runtime-page, .security-page, .firewall-page, .value-page) .layout-section .view-source,
:is(.runtime-page, .security-page, .firewall-page, .value-page) .layout-section .view-metadata { position: absolute; width: 1px; height: 1px; padding: 0; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
:is(.runtime-page, .security-page, .firewall-page, .value-page) .layout-section .table-region { margin-top: 0; }
.dashboard-callout { display: grid; grid-template-columns: minmax(240px, .55fr) minmax(0, 1fr); align-items: center; gap: 24px; padding: 16px; overflow: hidden; border: 1px solid var(--border); border-left: 4px solid var(--attention); border-radius: 6px; background: color-mix(in srgb, var(--attention) 5%, var(--canvas)); }
.dashboard-callout-heading { display: flex; align-items: center; gap: 12px; }
.dashboard-callout-heading > .octicon { width: 28px; height: 28px; flex: none; color: var(--attention); }
.dashboard-callout h3, .dashboard-callout h4 { margin: 1px 0 0; font-size: 1rem; }
.dashboard-callout p { margin: 0; color: var(--muted); font-size: .8125rem; }
.table-external-action { min-height: 24px; display: inline-flex; align-items: center; gap: 5px; font-weight: 600; }
.signal-evidence .octicon { width: 12px; height: 12px; }
`;
