/**
 * GitHub Primer CSS tokens and element styles cloned from CAO dashboard.
 */

/**
 * @returns {string}
 */
export function primerStylesheet() {
  return `:root {
  --canvas: #0d1117;
  --canvas-subtle: #151b23;
  --canvas-inset: #010409;
  --header: #010409;
  --fg: #f0f6fc;
  --muted: #9198a1;
  --border: #3d444d;
  --border-muted: #21262d;
  --accent: #58a6ff;
  --accent-muted: #121d2f;
  --success: #3fb950;
  --success-muted: #12261e;
  --danger: #f85149;
  --cancelled: #8c959f;
  --purple: #a371f7;
  --pink: #db61a2;
  --coral: #f78166;
  --yellow: #e3b341;
  --cyan: #39c5cf;
  --lime: #56d364;
  --violet: #bc8cff;
  --attention: #d29922;
  --attention-muted: #272115;
  --neutral-muted: #6e768166;
  --focus: #58a6ff;
  --on-emphasis: #ffffff;
}
@media (prefers-color-scheme: light) {
  :root {
    --canvas: #ffffff;
    --canvas-subtle: #f6f8fa;
    --canvas-inset: #f6f8fa;
    --header: #f6f8fa;
    --fg: #1f2328;
    --muted: #59636e;
    --border: #d1d9e0;
    --border-muted: #d8dee4;
    --accent: #0969da;
    --accent-muted: #ddf4ff;
    --success: #1a7f37;
    --success-muted: #dafbe1;
    --danger: #cf222e;
    --cancelled: #656d76;
    --purple: #8250df;
    --pink: #bf3989;
    --coral: #bc4c00;
    --yellow: #7d4e00;
    --cyan: #007d8a;
    --lime: #2da44e;
    --violet: #6639ba;
    --attention: #9a6700;
    --attention-muted: #fff8c5;
    --neutral-muted: #afb8c133;
    --focus: #0969da;
  }
}
* { box-sizing: border-box; }
html { scroll-behavior: smooth; -webkit-text-size-adjust: 100%; text-size-adjust: 100%; }
body { margin: 0; background: var(--canvas); color: var(--fg); font: .875rem/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji"; letter-spacing: 0; }
.dashboard-copilot-prompt { --copilot-accent: var(--purple); --copilot-accent-muted: color-mix(in srgb, var(--purple) 14%, transparent); display: grid; gap: 8px; margin-top: auto; padding-top: 12px; border-top: 1px solid var(--border); color: var(--fg); }
.dashboard-copilot-header { display: flex; align-items: center; gap: 7px; color: var(--muted); }
.dashboard-copilot-header > .octicon { color: var(--copilot-accent); }
.dashboard-copilot-header h2 { margin: 0; font-size: .75rem; font-weight: 600; }
.dashboard-copilot-conversation { max-height: min(42vh, 360px); display: flex; flex-direction: column; gap: 8px; overflow: auto; scrollbar-width: thin; }
.dashboard-copilot-conversation:empty { display: none; }
.dashboard-copilot-message { display: grid; gap: 2px; padding: 7px 8px; border: 1px solid var(--border); border-radius: 8px; font-size: .75rem; line-height: 1.35; }
.dashboard-copilot-message-user > strong { color: var(--muted); font-size: .6875rem; }
.dashboard-copilot-message-user { align-self: flex-end; background: var(--copilot-accent-muted); border-color: color-mix(in srgb, var(--copilot-accent) 42%, var(--border)); }
.dashboard-copilot-message-assistant { align-self: stretch; background: var(--canvas); }
.dashboard-copilot-message-reasoning, .dashboard-copilot-message-update { border-style: dashed; background: transparent; color: var(--muted); font-style: italic; }
.dashboard-copilot-message-refusal { border-style: dashed; background: transparent; color: var(--muted); }
.dashboard-copilot-message-error { border-color: var(--danger); background: color-mix(in srgb, var(--danger) 8%, transparent); }
.dashboard-copilot-message-content { white-space: pre-wrap; overflow-wrap: anywhere; }
.dashboard-copilot-label { color: var(--muted); font-size: .6875rem; font-weight: 600; }
.dashboard-copilot-input { min-width: 0; display: flex; align-items: center; gap: 4px; padding: 3px; border: 1px solid var(--border); border-radius: 8px; background: var(--canvas); }
.dashboard-copilot-input:focus-within { border-color: var(--copilot-accent); outline: 2px solid color-mix(in srgb, var(--copilot-accent) 28%, transparent); }
.dashboard-copilot-input input { min-width: 0; width: 100%; padding: 4px 5px; border: 0; outline: 0; background: transparent; color: var(--fg); font: inherit; font-size: .75rem; }
.dashboard-copilot-action { width: 28px; height: 28px; display: grid; flex: 0 0 28px; place-items: center; padding: 0; border: 0; border-radius: 6px; background: var(--copilot-accent); color: var(--on-emphasis); cursor: pointer; }
.dashboard-copilot-action:hover { filter: brightness(1.14); }
.dashboard-copilot-action.dashboard-copilot-cancel { border: 1px solid var(--border); background: var(--canvas-subtle); color: var(--fg); }
.dashboard-copilot-action.dashboard-copilot-cancel:hover { background: var(--neutral-muted); filter: none; }
.dashboard-copilot-action:disabled { background: var(--neutral-muted); color: var(--muted); cursor: not-allowed; filter: none; }
.dashboard-copilot-prompt output { min-height: 1em; color: var(--muted); font-size: .6875rem; line-height: 1.25; }
.dashboard-root { min-height: 100vh; background: var(--canvas); color: var(--fg); font: .875rem/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji"; }
.octicon-sprite { width: 0; height: 0; position: absolute; overflow: hidden; }
.octicon { width: 16px; height: 16px; flex: 0 0 16px; fill: currentColor; vertical-align: text-bottom; }
a { color: var(--accent); text-decoration: none; text-underline-offset: 2px; transition: color 120ms ease; }
a:hover { text-decoration: underline; text-decoration-thickness: 2px; }
a[href^="https://"]:not(:has(.octicon))::after, .octicon-external-link { content: ""; width: 12px; height: 12px; display: inline-block; flex: 0 0 12px; margin-left: 4px; background: currentColor; vertical-align: -1px; -webkit-mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M3.75 2h3.5a.75.75 0 0 1 0 1.5h-3.5a.25.25 0 0 0-.25.25v8.5c0 .138.112.25.25.25h8.5a.25.25 0 0 0 .25-.25v-3.5a.75.75 0 0 1 1.5 0v3.5A1.75 1.75 0 0 1 12.25 14h-8.5A1.75 1.75 0 0 1 2 12.25v-8.5C2 2.784 2.784 2 3.75 2Zm6.854-1h4.146a.25.25 0 0 1 .25.25v4.146a.25.25 0 0 1-.427.177L13.03 4.03 9.28 7.78a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042l3.75-3.75-1.543-1.543A.25.25 0 0 1 10.604 1Z'/%3E%3C/svg%3E") no-repeat center / contain; mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M3.75 2h3.5a.75.75 0 0 1 0 1.5h-3.5a.25.25 0 0 0-.25.25v8.5c0 .138.112.25.25.25h8.5a.25.25 0 0 0 .25-.25v-3.5a.75.75 0 0 1 1.5 0v3.5A1.75 1.75 0 0 1 12.25 14h-8.5A1.75 1.75 0 0 1 2 12.25v-8.5C2 2.784 2.784 2 3.75 2Zm6.854-1h4.146a.25.25 0 0 1 .25.25v4.146a.25.25 0 0 1-.427.177L13.03 4.03 9.28 7.78a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042l3.75-3.75-1.543-1.543A.25.25 0 0 1 10.604 1Z'/%3E%3C/svg%3E") no-repeat center / contain; }
.octicon-external-link { margin-left: 4px; }
.octicon-external-link > use { display: none; }
a:focus-visible, [tabindex]:focus-visible, button:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
::view-transition-old(root), ::view-transition-new(root) { animation-duration: 180ms; animation-timing-function: ease-out; }
.skip-link { position: fixed; z-index: 10; top: -80px; left: 12px; padding: 7px 12px; border: 1px solid var(--focus); border-radius: 6px; background: var(--canvas); color: var(--accent); font-weight: 600; text-decoration: none; transition: top 120ms ease, color 120ms ease; }
.skip-link:focus { top: 8px; }
.app-shell { min-height: 100vh; display: grid; grid-template-columns: 232px minmax(0, 1fr); transition: grid-template-columns 120ms ease; }
.dashboard-copilot-enabled .app-shell { grid-template-columns: 420px minmax(0, 1fr); }
.org-sidebar { min-width: 0; display: flex; flex-direction: column; gap: 8px; padding: 24px 16px 16px; border-right: 1px solid var(--border); background: var(--canvas-subtle); }
.dashboard-copilot-enabled .org-sidebar { height: 100vh; position: sticky; top: 0; align-self: start; overflow: hidden; }
.dashboard-copilot-enabled .primary-nav { min-height: 0; flex: 1; overflow-y: auto; scrollbar-width: thin; }
.dashboard-copilot-enabled .sidebar-toggle { display: none; }
.sidebar-header { min-width: 0; display: flex; align-items: center; gap: 8px; margin: 0 0 10px 8px; }
.sidebar-brand { display: flex; align-items: center; gap: 6px; min-width: 0; flex: 1; overflow: hidden; color: var(--fg); font-size: 1rem; font-weight: 600; text-decoration: none; white-space: nowrap; }
.sidebar-brand-mark { width: 24px; height: 24px; flex: 0 0 24px; overflow: visible; }
.sidebar-brand > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.sidebar-toggle { width: 28px; height: 28px; display: grid; flex: 0 0 28px; place-items: center; padding: 0; border: 0; border-radius: 6px; background: transparent; color: var(--muted); cursor: pointer; }
.sidebar-toggle:hover { background: var(--neutral-muted); color: var(--fg); }
.sidebar-collapsed { grid-template-columns: 64px minmax(0, 1fr); }
.sidebar-collapsed .org-sidebar { padding-inline: 8px 7px; }
.sidebar-collapsed .sidebar-header { gap: 0; margin-left: 0; }
.sidebar-collapsed .sidebar-brand { display: none; }
.sidebar-collapsed .sidebar-toggle { width: 24px; flex-basis: 24px; }
.sidebar-collapsed .nav-label, .sidebar-collapsed .nav-section-toggle { display: none; }
.sidebar-collapsed .nav-section-items { display: flex !important; }
.sidebar-collapsed .primary-nav a { justify-content: center; gap: 0; padding-inline: 6px; }
.sidebar-collapsed .primary-nav a[aria-current="page"]::before { left: -8px; }
.primary-nav { display: flex; flex-direction: column; gap: 2px; }
.nav-section { display: flex; flex-direction: column; }
.nav-section-toggle { min-height: 28px; display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 8px; padding: 4px 8px; border-radius: 6px; color: var(--muted); cursor: pointer; list-style: none; }
.nav-section:first-child > .nav-section-toggle { margin-top: 0; }
.nav-section-toggle::-webkit-details-marker { display: none; }
.nav-section-toggle:hover { background: var(--neutral-muted); color: var(--fg); }
.nav-section-toggle > .octicon { width: 12px; height: 12px; flex-basis: 12px; transition: transform 120ms ease; }
.nav-section[open] > .nav-section-toggle > .octicon { transform: rotate(90deg); }
.nav-section-label { min-width: 0; overflow: hidden; font-size: .6875rem; font-weight: 700; letter-spacing: .08em; text-overflow: ellipsis; text-transform: uppercase; white-space: nowrap; }
.nav-section-items { display: flex; flex-direction: column; gap: 2px; }
.nav-section:not([open]) > .nav-section-items { display: none; }
.primary-nav a, .nav-parent { min-height: 32px; display: flex; align-items: center; gap: 10px; position: relative; padding: 6px 8px; border-radius: 6px; color: var(--fg); font-weight: 500; text-decoration: none; transition: background-color 120ms ease, color 120ms ease; }
.primary-nav :is(a, .nav-parent) > .octicon { color: var(--muted); }
.primary-nav a:hover { background: var(--neutral-muted); }
.primary-nav a[aria-current="page"] { background: var(--neutral-muted); font-weight: 600; }
.primary-nav a[aria-current="page"]::before { content: ""; width: 3px; position: absolute; top: 5px; bottom: 5px; left: -16px; border-radius: 0 4px 4px 0; background: var(--accent); }
.mobile-nav-menu { display: none; }
.app-main { min-width: 0; display: flex; flex-direction: column; }
.app-main > nav { border-bottom: 1px solid var(--border); }
.app-main > nav .shell { display: flex; align-items: center; gap: 8px; width: 100%; padding: 10px 24px; }
.app-main > nav .shell > a:not([hidden]) { min-height: 24px; display: inline-flex; align-items: center; }
.app-main > nav .shell > :not([hidden]) ~ :not([hidden], .report-actions)::before { content: "/"; margin-right: 8px; color: var(--muted); }
.report-actions { margin-left: auto; display: flex; align-items: center; gap: 10px; }
.site-callouts { display: grid; gap: 8px; padding: 16px 24px 0; }
.site-callout { min-width: 0; display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: start; gap: 10px; padding: 12px 14px; border: 1px solid var(--attention); border-radius: 6px; background: var(--attention-muted); color: var(--fg); }
.site-callout-icon { display: grid; place-items: center; padding-top: 2px; color: var(--attention); }
.site-callout-content { min-width: 0; display: grid; gap: 2px; }
.site-callout-content > span { color: var(--muted); }
.site-callout-dismiss { width: 28px; height: 28px; display: grid; place-items: center; padding: 0; border: 0; border-radius: 6px; background: transparent; color: var(--muted); cursor: pointer; }
.site-callout-dismiss:hover { background: var(--neutral-muted); color: var(--fg); }
.dashboard-horizon { max-width: none; flex: none; display: flex; align-items: center; gap: 8px; color: var(--muted); font-size: .75rem; white-space: nowrap; }
.dashboard-horizon { padding-right: 10px; border-right: 1px solid var(--border); font-weight: 600; }
.horizon-summary { display: grid; gap: 2px; }
.horizon-toggle { padding: 3px 6px; border: 0; border-radius: 6px; background: transparent; color: inherit; font: inherit; font-weight: inherit; cursor: pointer; }
.horizon-toggle:hover, .horizon-toggle[aria-expanded="true"] { background: var(--neutral-muted); color: var(--fg); }
.horizon-data-status, .horizon-data-status > span { display: flex; align-items: center; }
.horizon-data-status { gap: 10px; padding: 0 6px; font-weight: 500; }
.horizon-data-status > span { gap: 4px; }
.horizon-data-status .status { font-size: .6875rem; }
.dashboard-horizon-skeleton > span { width: 78px; height: 12px; border-radius: 4px; background: linear-gradient(90deg, var(--canvas-subtle) 25%, var(--neutral-muted) 50%, var(--canvas-subtle) 75%); background-size: 200% 100%; animation: dashboard-skeleton-pulse 1.5s ease-in-out infinite; }
.tooltip-help { position: relative; display: inline-flex; }
.tooltip-trigger { width: 22px; height: 22px; display: grid; place-items: center; padding: 0; border: 0; border-radius: 50%; background: transparent; color: var(--muted); cursor: help; }
.tooltip-trigger:hover { background: var(--neutral-muted); color: var(--fg); }
.tooltip-trigger .octicon { width: 14px; height: 14px; }
.tooltip-content { width: min(320px, calc(100vw - 28px)); position: absolute; z-index: 20; top: calc(100% + 8px); right: 0; display: grid; gap: 10px; padding: 12px; border: 1px solid var(--border); border-radius: 6px; background: var(--canvas); box-shadow: 0 8px 24px color-mix(in srgb, var(--canvas-inset) 45%, transparent); color: var(--fg); font-weight: 400; line-height: 1.4; white-space: normal; visibility: hidden; opacity: 0; pointer-events: none; transition: opacity 80ms linear, visibility 80ms linear; }
.tooltip-help:hover .tooltip-content, .tooltip-help:focus-within .tooltip-content { visibility: visible; opacity: 1; }
.tooltip-description { color: var(--muted); }
.horizon-tooltip-values { display: grid; gap: 6px; }
.horizon-tooltip-values > span { display: grid; grid-template-columns: 56px minmax(0, 1fr); gap: 8px; }
.horizon-tooltip-values strong { font-weight: 600; }
.refresh-button { display: inline-flex; align-items: center; gap: 6px; min-height: 28px; padding: 3px 12px; border: 1px solid var(--border); border-radius: 6px; background: var(--canvas-subtle); color: var(--fg); font: inherit; font-size: .75rem; font-weight: 500; text-decoration: none; cursor: pointer; transition: background-color 120ms ease; }
.refresh-button:hover { background: var(--neutral-muted); }
.refresh-button .octicon { width: 14px; height: 14px; }
.repository-link { width: 28px; height: 28px; display: grid; flex: 0 0 28px; place-items: center; border-radius: 6px; color: var(--muted); text-decoration: none; transition: background-color 120ms ease, color 120ms ease; }
.repository-link:hover { background: var(--neutral-muted); color: var(--fg); }
.repository-link .octicon { width: 18px; height: 18px; }
main.dashboard-prototype { width: 100%; flex: 1; padding: 0 24px 40px; }
.lede { color: var(--muted); }
.overview-header { min-height: 88px; display: flex; align-items: flex-start; justify-content: space-between; gap: 32px; padding: 18px 0 14px; }
.overview-header h1 { margin: 0; font-size: 1.5rem; line-height: 1.25; }
.overview-header .lede { margin: 3px 0 0; font-size: .875rem; }
.title-area { display: flex; align-items: center; gap: 8px; }
.title-link { flex: none; color: var(--muted); font-size: 1rem; font-weight: 400; text-decoration: none; white-space: nowrap; }
.title-link:hover { color: var(--accent); text-decoration: underline; }
.title-link[hidden] { display: none; }
.toolbar { display: flex; align-items: center; gap: 8px; margin-bottom: 16px; }
.report-actions > .filter-bar { position: relative; margin-bottom: 0; }
.filter-tuning-controls { display: none; }
.filter-bar-expanded .filter-tuning-controls { width: min(920px, calc(100vw - 48px)); display: flex; align-items: stretch; gap: 8px; position: absolute; z-index: 20; top: calc(100% + 9px); right: 0; padding: 10px; border: 1px solid var(--border); border-radius: 6px; background: var(--canvas); box-shadow: 0 8px 24px color-mix(in srgb, var(--canvas-inset) 45%, transparent); }
.filter-control { min-width: 240px; min-height: 30px; display: flex; flex: 1; align-items: stretch; position: relative; border: 1px solid var(--border); border-radius: 6px; background: var(--canvas); font-size: .75rem; }
.scope-label, .scope-period, .search-control { display: inline-flex; align-items: center; gap: 7px; padding: 4px 12px; }
.scope-label { border-right: 1px solid var(--border); }
.filter-toggle { border-block: 0; border-left: 0; background: transparent; color: inherit; font: inherit; cursor: pointer; }
.count-badge { min-width: 20px; padding: 0 6px; border-radius: 2em; background: var(--neutral-muted); font-size: .6875rem; text-align: center; }
.filter-control input { min-width: 0; flex: 1; padding: 5px 12px; border: 0; outline: 0; background: transparent; color: var(--accent); font: inherit; }
.search-control { padding-inline: 9px; border-left: 1px solid var(--border); color: var(--muted); }
.scope-period { min-height: 30px; border: 1px solid var(--border); border-radius: 6px; background: var(--canvas-subtle); color: var(--fg); font-size: .75rem; font-weight: 600; white-space: nowrap; }
.time-window-control { display: none; align-items: stretch; gap: 6px; }
.filter-bar-expanded .time-window-control { display: flex; }
.time-window-control label { display: inline-flex; align-items: center; gap: 7px; min-height: 30px; padding: 3px 8px; border: 1px solid var(--border); border-radius: 6px; background: var(--canvas-subtle); color: var(--muted); font-size: .6875rem; font-weight: 600; white-space: nowrap; }
.mode-filter-control { display: flex; align-items: stretch; gap: 2px; margin: 0; padding: 0; border: 0; }
.mode-filter-control legend { position: absolute; width: 1px; height: 1px; padding: 0; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
.mode-filter-control label { cursor: pointer; text-transform: capitalize; }
.mode-filter-control input { width: auto; accent-color: var(--accent); }
.time-window-control :is(select, input) { min-width: 0; border: 0; outline: 0; background: transparent; color: var(--fg); font: inherit; font-weight: 600; }
.time-window-control select { max-width: 132px; }
.time-window-control input { width: 132px; }
.time-window-control input[aria-invalid="true"] { color: var(--danger); }
.time-window-control > button { min-height: 30px; padding: 0 12px; border: 1px solid var(--border); border-radius: 6px; background: var(--canvas-subtle); color: var(--fg); font: inherit; font-size: .75rem; font-weight: 700; cursor: pointer; }
.time-window-control > button:hover { background: var(--border-muted); }
.dashboard-pages { display: flex; flex-direction: column; gap: 24px; }
.dashboard-page { padding: 0; }
.dashboard-page[hidden] { display: none; }
.dashboard-page > h2 { margin: 0 0 14px; font-size: 1.25rem; font-weight: 600; }
.page-layout-grid { display: grid; grid-template-columns: repeat(12, minmax(0, 1fr)); gap: 16px; align-items: start; }
.layout-section { min-width: 0; grid-column: span 12; padding: 16px; border: 1px solid var(--border); border-radius: 6px; background: var(--canvas); }
.layout-section[data-section-layout="wide"] { grid-column: span 7; }
.layout-section[data-section-layout="narrow"] { grid-column: span 5; }
.layout-section-header { margin-bottom: 12px; }
.layout-section-header h3 { margin: 0; font-size: 1rem; }
.layout-section-header p { margin: 3px 0 0; color: var(--muted); font-size: .8125rem; }
.layout-section .page-section { min-width: 0; }
.layout-section .page-section > h4 { margin: 12px 0 8px; font-size: .875rem; font-weight: 600; }
.view-description-section { position: relative; }
.view-description-tooltip { position: absolute; top: 4px; right: 0; }
.custom-view-grid { display: grid; grid-template-columns: repeat(12, minmax(0, 1fr)); gap: 16px; }
.custom-view { min-width: 0; grid-column: span 12; }
.custom-view[data-view-layout="half"] { grid-column: span 6; }
.custom-view[data-view-layout="third"] { grid-column: span 4; }
.view-metadata-summary { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 16px; margin: 0 0 12px; color: var(--fg); }
.view-metadata-summary > div { display: inline-flex; align-items: center; gap: 7px; }
.view-metadata-summary dt { display: inline-flex; align-items: center; gap: 5px; color: var(--muted); font-size: .75rem; font-weight: 500; }
.view-metadata-summary dt .octicon { width: 14px; height: 14px; flex-basis: 14px; }
.view-metadata-summary dd { margin: 0; font-size: .75rem; font-weight: 600; }
.view-disclosure { overflow: hidden; border: 1px solid var(--border); border-radius: 6px; background: var(--canvas-subtle); }
.view-disclosure > summary { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 12px 14px; color: var(--fg); font-weight: 600; cursor: pointer; transition: background-color 120ms ease; }
.view-disclosure > summary:hover { background: var(--neutral-muted); }
.view-disclosure > summary::marker { color: var(--muted); }
.view-disclosure[open] > summary { border-bottom: 1px solid var(--border); }
.view-disclosure-hint { color: var(--muted); font-size: .75rem; font-weight: 400; }
.view-disclosure[open] .view-disclosure-hint { font-size: 0; }
.view-disclosure[open] .view-disclosure-hint::after { content: "Hide details"; font-size: .75rem; }
.view-disclosure > .page-section { padding: 0 14px 14px; }
.chart-widget { min-height: 230px; display: grid; place-items: center; margin: 12px 0; border: 1px solid var(--border); border-radius: 6px; background: var(--canvas-subtle); }
.chart-clustering-progress { min-height: 230px; display: grid; place-content: center; justify-items: center; gap: 10px; margin: 12px 0; color: var(--muted); font-size: .8125rem; }
.chart-clustering-progress progress { width: min(240px, 70vw); }
.chart-widget svg { width: min(100%, 420px); max-height: 220px; overflow: visible; }
.line-chart-widget, .dot-chart-widget, .scatter-chart-widget { min-width: 0; overflow: hidden; }
.line-chart-widget svg, .dot-chart-widget svg, .scatter-chart-widget svg { width: 100%; max-height: none; }
.pie-chart-track { stroke: var(--border-muted); }
.pie-chart-segment { stroke: var(--accent); }
.pie-chart-total-value { fill: var(--fg); font-size: 5px; font-weight: 700; }
.pie-chart-total-label { fill: var(--muted); font-size: 2.75px; text-transform: uppercase; letter-spacing: .04em; }
.chart-legend { display: flex; flex-wrap: wrap; gap: 12px; margin: 8px 0 12px; padding: 0; list-style: none; color: var(--muted); font-size: .75rem; }
.chart-legend li { display: inline-flex; align-items: center; gap: 6px; }
.chart-legend i { width: 18px; height: 0; border-top-width: 2px; border-top-style: solid; }
.chart-legend-bar i, .chart-legend-pie i { height: 10px; border-top-width: 0; border-radius: 999px; background: currentColor; }
.chart-legend-pie strong { color: var(--fg); font-variant-numeric: tabular-nums; }
.chart-legend-pie small { color: var(--muted); }
.chart-axis { display: flex; justify-content: space-between; margin-top: 4px; color: var(--muted); font-size: .6875rem; }
.line-chart-widget .chart-axis, .dot-chart-widget .chart-axis, .scatter-chart-widget .chart-axis { width: 100%; }
.timeline-chart-axis { position: relative; width: 100%; margin: -12px 0 12px; padding-top: 9px; border-top: 1px solid var(--border); font-variant-numeric: tabular-nums; }
.timeline-chart-axis span { position: relative; white-space: nowrap; }
.timeline-chart-axis span::before { position: absolute; top: -10px; left: 50%; width: 1px; height: 5px; background: var(--border); content: ""; }
.timeline-chart-axis span:first-child::before { left: 0; }
.timeline-chart-axis span:last-child::before { right: 0; left: auto; }
.histogram-chart-widget { grid-template-rows: minmax(0, 1fr) auto; align-content: center; padding: 16px 18px 12px; background: var(--canvas-subtle); border-top: 1px solid var(--border-muted); }
.histogram-chart-widget svg, .histogram-chart-widget .chart-axis { width: min(100%, 420px); }
.histogram-chart-widget .chart-axis { box-sizing: border-box; margin-top: 0; padding: 6px 0 0 9%; border-top: 1px solid var(--border-muted); font-variant-numeric: tabular-nums; }
.histogram-chart-y-label { fill: var(--muted); font-size: 2.5px; font-variant-numeric: tabular-nums; }
.heatmap-chart-widget { min-width: 0; padding: 16px; place-items: stretch; }
.heatmap-scroll-region { overflow-x: auto; border-radius: 6px; }
.heatmap-scroll-region:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
.heatmap-chart { width: 100%; min-width: max-content; border-spacing: 3px; border-collapse: separate; font-size: .75rem; }
.heatmap-chart th { max-width: 150px; padding: 5px 8px; color: var(--muted); font-weight: 600; text-align: center; overflow-wrap: anywhere; }
.heatmap-chart tbody th { text-align: right; }
.heatmap-cell { min-width: 72px; height: 44px; padding: 6px 8px; border: 1px solid color-mix(in srgb, var(--accent) 42%, var(--border)); border-radius: 6px; background: color-mix(in srgb, var(--accent) var(--heatmap-intensity, 18%), var(--canvas)); color: var(--fg); font-weight: 600; text-align: center; font-variant-numeric: tabular-nums; }
.heatmap-cell-empty { border-color: var(--border-muted); background: var(--canvas-subtle); color: var(--muted); font-weight: 400; }
.heatmap-cell:focus-visible { outline: 2px solid var(--focus); outline-offset: 1px; }
.chart-series-1 { stroke: var(--success); }
.chart-series-2 { stroke: var(--attention); }
.chart-series-3 { stroke: var(--danger); }
.chart-series-4 { stroke: var(--accent); }
.chart-series-5 { stroke: var(--muted); }
.chart-series-6 { stroke: var(--purple); }
.chart-series-7 { stroke: var(--pink); }
.chart-series-8 { stroke: var(--coral); }
.chart-series-9 { stroke: var(--yellow); }
.chart-series-10 { stroke: var(--cyan); }
.chart-series-11 { stroke: var(--lime); }
.chart-series-12 { stroke: var(--violet); }
.line-chart-axis { stroke: var(--border); stroke-width: 1; }
.line-chart-grid { stroke: var(--border-muted); stroke-width: .5; stroke-dasharray: 2 2; }
.histogram-chart-grid { stroke: var(--border-muted); stroke-width: .5; stroke-dasharray: 1.5 2; }
.line-chart-series { stroke: var(--accent); stroke-width: 2; vector-effect: non-scaling-stroke; }
.line-chart-point { stroke-width: var(--chart-point-size, 4px); stroke-linecap: round; vector-effect: non-scaling-stroke; }
.dot-chart-point, .scatter-chart-point { fill: var(--canvas); stroke-width: 2; vector-effect: non-scaling-stroke; }
.dot-chart-reference { stroke-width: 1; stroke-dasharray: 4 3; opacity: .72; vector-effect: non-scaling-stroke; }
.line-chart-window-band { fill: var(--accent); opacity: .055; }
.line-chart-context { opacity: .3; stroke-width: 1.1; }
.chart-point-context { opacity: .35; }
.line-chart-current { opacity: 1; stroke-width: 2; }
.chart-window-key { display: flex; justify-content: flex-end; gap: 14px; margin-top: 5px; color: var(--fg); font-size: .6875rem; }
.chart-window-key span, .chart-window-key strong { display: inline-flex; align-items: center; gap: 5px; font-weight: 600; }
.chart-window-key span::before, .chart-window-key strong::before { width: 14px; border-top: 2px solid var(--accent); content: ''; }
.chart-window-key span { color: var(--muted); }
.chart-window-key span::before { border-color: var(--muted); opacity: .55; }
.chart-point { cursor: crosshair; }
.pie-chart-segment { animation: pie-chart-entry 420ms ease-out both; animation-delay: calc(var(--chart-entry-index, 0) * 45ms); }
.line-chart-series { animation: line-chart-entry 600ms ease-out both; animation-delay: calc(var(--chart-entry-index, 0) * 70ms); }
.line-chart-series.line-chart-context { animation-name: line-chart-context-entry; }
.line-chart-point, .dot-chart-point, .scatter-chart-point { transform-box: fill-box; transform-origin: center; animation: line-chart-point-entry 280ms ease-out both; animation-delay: calc(180ms + var(--chart-entry-index, 0) * 35ms); }
.bar-chart-bar, .histogram-chart-bar, .table-summary-histogram rect { transform-box: fill-box; transform-origin: center bottom; animation: histogram-chart-entry 360ms ease-out both; animation-delay: calc(var(--chart-entry-index, 0) * 35ms); }
.pie-chart-segment { transition: opacity 120ms ease, filter 120ms ease; }
.pie-chart-mark:hover .pie-chart-segment, .pie-chart-mark:focus-visible .pie-chart-segment { filter: brightness(1.08); opacity: .82; }
.point-tooltip { opacity: 0; pointer-events: none; transition: opacity 80ms linear; }
.point-tooltip rect { fill: var(--canvas-subtle); stroke: var(--border); vector-effect: non-scaling-stroke; }
.point-tooltip text { fill: var(--fg); font-size: 3px; font-weight: 600; }
.pie-chart-tooltip text { font-size: 2.25px; }
.chart-point:hover .point-tooltip, .chart-point:focus-visible .point-tooltip { opacity: 1; }
.chart-point:focus-visible .line-chart-point { stroke: var(--focus); stroke-width: calc(var(--chart-point-size, 4px) + 2px); }
.chart-point:focus-visible .dot-chart-point, .chart-point:focus-visible .scatter-chart-point { stroke: var(--focus); stroke-width: 3; }
.bar-chart-axis { stroke: var(--border); stroke-width: .75; vector-effect: non-scaling-stroke; }
.bar-chart-grid { stroke: var(--border-muted); stroke-width: .5; stroke-dasharray: 1.5 2; vector-effect: non-scaling-stroke; }
.bar-chart-y-axis text, .bar-chart-x-axis text { fill: var(--muted); font-size: 2.6px; font-variant-numeric: tabular-nums; }
.bar-chart-bar { fill: var(--accent); stroke: var(--canvas); stroke-width: .5; }
.histogram-chart-bar { fill: var(--accent); stroke: color-mix(in srgb, var(--success) 72%, var(--canvas)); stroke-width: .65; vector-effect: non-scaling-stroke; }
.chart-widget [tabindex]:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; stroke: var(--focus); stroke-width: 3; }
.chart-widget .chart-series-1 { stroke: var(--success); }
.chart-widget .chart-series-2 { stroke: var(--attention); }
.chart-widget .chart-series-3 { stroke: var(--danger); }
.chart-widget .chart-series-4 { stroke: var(--accent); }
.chart-widget .chart-series-5 { stroke: var(--muted); }
.chart-widget .chart-series-6 { stroke: var(--purple); }
.swimlane-chart-widget { display: block; min-height: 0; padding: 14px 16px 10px; }
.swimlane-empty-state { min-height: 180px; display: grid; place-content: center; text-align: center; }
.swimlane-empty-state p { margin: 4px 0 0; color: var(--muted); }
.swimlane-chart-widget svg { width: 100%; max-height: 300px; overflow: visible; }
.swimlane-summary { display: flex; flex-wrap: wrap; gap: 6px 18px; margin: 0 0 8px; padding: 0; color: var(--muted); font-size: .75rem; font-variant-numeric: tabular-nums; list-style: none; }
.swimlane-summary li:first-child { color: var(--fg); font-weight: 600; }
.swimlane-label, .swimlane-time-label { fill: var(--muted); font-size: 2.4px; }
.swimlane-label { font-weight: 600; }
.swimlane-separator { stroke: var(--border-muted); stroke-width: .45; }
.swimlane-axis, .swimlane-tick { stroke: var(--border); stroke-width: .55; }
.swimlane-run-mark { stroke-width: 3; stroke-linecap: round; vector-effect: non-scaling-stroke; transition: filter 120ms ease, stroke-width 120ms ease; }
.swimlane-mark-action-required { stroke: var(--accent); }
.swimlane-mark-failure { stroke: var(--danger); }
.swimlane-mark-cancelled { stroke: var(--attention); }
.swimlane-mark-skipped { stroke: var(--muted); }
.swimlane-mark-success { stroke: var(--accent); }
.swimlane-mark:hover, .swimlane-mark:focus-visible { filter: brightness(1.2); stroke-width: 4; }
.swimlane-mark:focus-visible { outline: none; }
.chart-widget .chart-series-7 { stroke: var(--pink); }
.chart-widget .chart-series-8 { stroke: var(--coral); }
.chart-widget .chart-series-9 { stroke: var(--yellow); }
.chart-widget .chart-series-10 { stroke: var(--cyan); }
.chart-widget .chart-series-11 { stroke: var(--lime); }
.chart-widget .chart-series-12 { stroke: var(--violet); }
.bar-chart-bar.chart-series-1 { fill: var(--success); }
.bar-chart-bar.chart-series-2 { fill: var(--attention); }
.bar-chart-bar.chart-series-3 { fill: var(--danger); }
.bar-chart-bar.chart-series-4 { fill: var(--accent); }
.bar-chart-bar.chart-series-5 { fill: var(--muted); }
.bar-chart-bar.chart-series-6 { fill: var(--purple); }
.bar-chart-bar.chart-series-7 { fill: var(--pink); }
.bar-chart-bar.chart-series-8 { fill: var(--coral); }
.bar-chart-bar.chart-series-9 { fill: var(--yellow); }
.bar-chart-bar.chart-series-10 { fill: var(--cyan); }
.bar-chart-bar.chart-series-11 { fill: var(--lime); }
.bar-chart-bar.chart-series-12 { fill: var(--violet); }
.histogram-chart-bar.chart-series-1 { fill: var(--success); }
.chart-legend i.chart-series-1 { border-color: var(--success); color: var(--success); }
.chart-legend i.chart-series-2 { border-color: var(--attention); color: var(--attention); }
.chart-legend i.chart-series-3 { border-color: var(--danger); color: var(--danger); }
.chart-legend i.chart-series-4 { border-color: var(--accent); color: var(--accent); }
.chart-legend i.chart-series-5 { border-color: var(--muted); color: var(--muted); }
.chart-legend i.chart-series-6 { border-color: var(--purple); color: var(--purple); }
.chart-legend i.chart-series-7 { border-color: var(--pink); color: var(--pink); }
.chart-legend i.chart-series-8 { border-color: var(--coral); color: var(--coral); }
.chart-legend i.chart-series-9 { border-color: var(--yellow); color: var(--yellow); }
.chart-legend i.chart-series-10 { border-color: var(--cyan); color: var(--cyan); }
.chart-legend i.chart-series-11 { border-color: var(--lime); color: var(--lime); }
.chart-legend i.chart-series-12 { border-color: var(--violet); color: var(--violet); }
.chart-widget .chart-series-semantic-failure { stroke: var(--danger); }
.chart-widget .chart-series-semantic-success, .chart-widget .chart-series-semantic-waiting { stroke: var(--accent); }
.chart-widget .chart-series-semantic-attention { stroke: var(--attention); }
.chart-widget .chart-series-semantic-neutral { stroke: var(--muted); }
.bar-chart-bar.chart-series-semantic-failure { fill: var(--danger); }
.bar-chart-bar.chart-series-semantic-success, .bar-chart-bar.chart-series-semantic-waiting { fill: var(--accent); }
.bar-chart-bar.chart-series-semantic-attention { fill: var(--attention); }
.bar-chart-bar.chart-series-semantic-neutral { fill: var(--muted); }
.chart-legend i.chart-series-semantic-failure { border-color: var(--danger); color: var(--danger); }
.chart-legend i.chart-series-semantic-success, .chart-legend i.chart-series-semantic-waiting { border-color: var(--accent); color: var(--accent); }
.chart-legend i.chart-series-semantic-attention { border-color: var(--attention); color: var(--attention); }
.chart-legend i.chart-series-semantic-neutral { border-color: var(--muted); color: var(--muted); }
@keyframes pie-chart-entry {
  from { opacity: 0; }
}
@keyframes line-chart-entry {
  from { opacity: 0; }
  to { opacity: 1; }
}
@keyframes line-chart-context-entry {
  from { opacity: 0; }
  to { opacity: .3; }
}
@keyframes line-chart-point-entry {
  from { opacity: 0; transform: scale(0); }
}
@keyframes histogram-chart-entry {
  from { opacity: 0; transform: scaleY(0); }
}
@media (prefers-reduced-motion: reduce) {
  .pie-chart-segment, .line-chart-series, .line-chart-point, .dot-chart-point, .scatter-chart-point, .bar-chart-bar, .histogram-chart-bar, .table-summary-histogram rect { animation: none; }
  .pie-chart-segment, .point-tooltip, .swimlane-run-mark { transition: none; }
}
.view-description { margin: 3px 0 0; color: var(--muted); }
.chart-view-pie { display: grid; gap: 16px; }
.pie-chart-card { display: grid; grid-template-columns: minmax(190px, .65fr) minmax(0, 1.35fr); align-items: center; gap: 4px 24px; padding: 20px 24px; border: 1px solid var(--border); border-radius: 6px; }
.layout-section .pie-chart-card { padding: 0; border: 0; }
#page-preview .pie-chart-card { padding: 0; border: 0; }
.pie-chart-card > h3, .pie-chart-card > h4 { align-self: end; margin: 0; font-size: 1.25rem; }
.pie-chart-card > .view-description { align-self: start; }
.pie-chart-card > .view-source, .pie-chart-card > .view-metadata, .pie-chart-card > .view-context { grid-column: 1; margin: 0; font-size: .6875rem; }
.pie-chart-layout { min-width: 0; display: grid; grid-column: 2; grid-row: 1 / span 6; grid-template-columns: minmax(120px, 180px) minmax(0, 1fr); align-items: center; gap: 20px; }
.pie-chart-layout .chart-widget { min-width: 0; min-height: 180px; margin: 0; border: 1px solid var(--border); background: var(--canvas-subtle); }
#page-preview .pie-chart-layout .chart-widget { border: 0; background: transparent; }
.pie-chart-layout .chart-widget svg { width: 100%; max-width: 180px; height: auto; max-height: none; }
.pie-chart-layout .chart-legend-pie { min-width: 0; width: 100%; display: block; margin: 0; }
.pie-chart-layout .chart-legend-pie li { min-height: 30px; display: grid; grid-template-columns: 10px minmax(0, 1fr) auto 54px; gap: 9px; border-bottom: 1px solid var(--border-muted); }
.pie-chart-layout .chart-legend-pie li:last-child { border-bottom: 0; }
.pie-chart-layout .chart-legend-pie i { width: 9px; height: 9px; border-radius: 2px; }
.pie-chart-layout .chart-legend-pie span { min-width: 0; overflow-wrap: anywhere; }
.pie-chart-layout .chart-legend-pie strong, .pie-chart-layout .chart-legend-pie small { font-variant-numeric: tabular-nums; text-align: right; }
.chart-view-pie > .table-region { margin: 0; }
.metric-link a, .custom-table a { display: inline-flex; align-items: center; gap: 4px; border-radius: 4px; transition: background-color 120ms ease, color 120ms ease; }
.metric-link a:hover, .custom-table a:hover { background: var(--neutral-muted); }
.metric-link .octicon, .custom-table a .octicon { width: 12px; height: 12px; }
.package-dispatches-page .table-status-detail, .dispatches-page .table-status-detail { min-width: 360px; max-width: 560px; padding: 14px 16px; font-size: .875rem; white-space: normal; line-height: 1.5; }
.package-dispatches-page .table-status-detail[data-status="failure"], .package-dispatches-page .table-status-detail[data-status="startup-failure"], .package-dispatches-page .table-status-detail[data-status="timed-out"],
.dispatches-page .table-status-detail[data-status="failure"], .dispatches-page .table-status-detail[data-status="startup-failure"], .dispatches-page .table-status-detail[data-status="timed-out"] { border-left: 3px solid var(--danger); background: var(--danger-muted, color-mix(in srgb, var(--danger) 10%, transparent)); color: var(--danger); font-weight: 600; }
.package-dispatches-page .table-status-detail[data-status="action-required"], .dispatches-page .table-status-detail[data-status="action-required"] { border-left: 3px solid var(--attention); background: var(--attention-muted); color: var(--attention); font-weight: 600; }
.package-dispatches-page .table-status-detail > a, .dispatches-page .table-status-detail > a { color: inherit; font-weight: inherit; text-decoration: underline; text-underline-offset: 2px; }
.package-dispatches-page .chart-view-pie:first-of-type .pie-chart-card { border-top: 3px solid var(--danger); }
.package-dispatches-page .chart-view-pie:first-of-type .pie-chart-total-value { fill: var(--danger); }
.table-intent-action { width: 1%; text-align: left; white-space: nowrap; }
.table-intent-control { display: inline-grid; place-items: center; }
.table-intent-button { min-height: 32px; display: inline-flex; align-items: center; gap: 7px; padding: 4px 10px; border: 1px solid var(--accent); border-radius: 6px; background: var(--accent-muted); color: var(--accent); font: inherit; font-size: .75rem; font-weight: 600; white-space: nowrap; cursor: pointer; }
.table-intent-button:hover { background: var(--accent); color: var(--canvas); }
.table-intent-button:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
.table-intent-button .octicon { width: 14px; height: 14px; }
.table-intent-dialog { width: min(680px, calc(100vw - 32px)); max-width: none; max-height: calc(100vh - 32px); margin: auto; padding: 0; overflow: hidden; border: 1px solid var(--border); border-radius: 8px; background: var(--canvas); box-shadow: 0 16px 48px color-mix(in srgb, var(--canvas-inset) 70%, transparent); color: var(--fg); }
.table-intent-dialog[open] { display: grid; grid-template-rows: auto minmax(0, 1fr) auto; }
.table-intent-dialog::backdrop { background: color-mix(in srgb, var(--canvas-inset) 72%, transparent); }
.table-intent-dialog-header { min-width: 0; display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 14px 16px; border-bottom: 1px solid var(--border); background: var(--canvas-subtle); text-align: left; }
.table-intent-dialog-header h2 { margin: 0; font-size: 1rem; }
.table-intent-dialog-close { width: 28px; height: 28px; display: grid; flex: 0 0 28px; place-items: center; padding: 0; border: 0; border-radius: 6px; background: transparent; color: var(--muted); cursor: pointer; }
.table-intent-dialog-close:hover { background: var(--neutral-muted); color: var(--fg); }
.table-intent-preview { max-height: min(60vh, 560px); margin: 0; padding: 18px; overflow: auto; background: var(--canvas); color: var(--fg); font: .8125rem/1.55 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; letter-spacing: 0; text-align: left; white-space: pre-wrap; overflow-wrap: anywhere; }
.table-intent-dialog-footer { min-height: 58px; display: flex; align-items: center; justify-content: flex-end; gap: 12px; padding: 10px 16px; border-top: 1px solid var(--border); background: var(--canvas-subtle); }
.table-intent-copy-status { min-width: 0; flex: 1; color: var(--muted); text-align: left; }
.table-intent-copy-button { min-height: 34px; display: inline-flex; align-items: center; gap: 7px; padding: 5px 12px; border: 1px solid var(--accent); border-radius: 6px; background: var(--accent); color: var(--canvas); font: inherit; font-weight: 600; cursor: pointer; }
.table-intent-copy-button:hover { filter: brightness(1.08); }
.table-intent-copy-button:disabled { cursor: progress; opacity: .65; }
.table-intent-copy-button[data-copy-state="success"] { border-color: var(--success); }
.table-intent-copy-button[data-copy-state="error"] { border-color: var(--danger); }
h3 { margin: 16px 0 8px; font-size: 1rem; font-weight: 600; }
.metrics { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; margin: 0 0 20px; overflow: visible; }
.metrics div, .data-state-summary > div { min-width: 0; min-height: 90px; padding: 14px 16px; border: 1px solid var(--border); border-radius: 6px; background: var(--canvas-subtle); }
.data-state-summary { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; margin: 0 0 20px; }
.data-state-summary[hidden] { display: none; }
.data-state-summary dt, .metrics dt { color: var(--muted); font-size: .75rem; font-weight: 600; text-transform: uppercase; margin: 0; }
.data-state-summary dd, .metrics dd { margin: 4px 0 0; font-size: 1.375rem; font-weight: 600; font-variant-numeric: tabular-nums; text-transform: capitalize; }
.data-state-summary dd[data-state-axis="availability"],
.data-state-summary dd[data-state-axis="completeness"],
.data-state-summary dd[data-state-axis="freshness"] { color: var(--fg); }
.summary-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 14px; margin-bottom: 20px; }
.summary-card { padding: 14px 16px; border: 1px solid var(--border); border-radius: 6px; background: var(--canvas-subtle); }
.summary-card h4 { margin: 0 0 8px; font-size: .875rem; color: var(--muted); font-weight: 600; text-transform: uppercase; }
.summary-list, .run-status-counts, .run-conclusion-counts, .run-outcome-counts { list-style: none; margin: 0 0 16px; padding: 0; display: flex; flex-wrap: wrap; gap: 8px; }
.summary-list li, .run-status-counts li, .run-conclusion-counts li, .run-outcome-counts li { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border: 1px solid var(--border); border-radius: 2em; background: var(--canvas-subtle); font-size: .75rem; font-weight: 600; }
.repository-tabs { display: flex; gap: 4px; margin-bottom: 24px; border-bottom: 1px solid var(--border); }
.repository-tabs a { display: inline-flex; align-items: center; gap: 8px; position: relative; padding: 10px 14px 12px; color: var(--fg); font-weight: 600; text-decoration: none; }
.repository-tabs a > .octicon { color: var(--muted); }
.repository-tabs a:hover { background: var(--canvas-subtle); }
.repository-tabs a[aria-current="page"]::after { content: ""; height: 2px; position: absolute; right: 8px; bottom: -1px; left: 8px; background: var(--danger); }
.workflow-badge-operation, .workflow-badge-orchestrator { border-color: var(--accent); color: var(--accent); }
.workflow-identity { display: flex; align-items: center; justify-content: space-between; gap: 24px; margin-bottom: 24px; }
.workflow-identity p { margin: 7px 0 0; }
.workflow-identity > a { display: inline-flex; align-items: center; gap: 5px; flex: none; }
.workflow-badges { display: flex; flex-wrap: wrap; gap: 5px; }
.workflow-badge-package { border-color: var(--accent); background: var(--accent-muted); color: var(--accent); text-decoration: none; }
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
.value-history-panel > header h3 { margin: 0; font-size: .9375rem; }
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
.context-summary { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); margin: 0 0 24px; overflow: hidden; border: 1px solid var(--border); border-radius: 6px; background: var(--canvas-subtle); }
.context-summary > div { min-width: 0; padding: 10px 14px; border-top: 1px solid var(--border); border-left: 1px solid var(--border); }
.context-summary > div:first-child { grid-column: 1 / -1; border-top: 0; border-left: 0; }
.context-summary > div:nth-child(2) { border-left: 0; }
.context-summary dt { overflow: hidden; color: var(--muted); font-size: .75rem; font-weight: 600; text-overflow: ellipsis; text-transform: uppercase; white-space: nowrap; }
.context-summary dd { margin: 2px 0 0; overflow: hidden; font-size: .8125rem; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
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
.attention-domain-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); overflow: hidden; border: 1px solid var(--border); border-radius: 6px; background: var(--border); gap: 1px; }
.attention-domain-card { min-width: 0; min-height: 184px; display: grid; grid-template-rows: auto auto 1fr auto; gap: 12px; padding: 16px; border-top: 3px solid var(--muted); background: var(--canvas); color: var(--fg); text-decoration: none; }
.attention-domain-card:hover { background: var(--canvas-subtle); text-decoration: none; }
.attention-domain-card:focus-visible { z-index: 1; outline: 2px solid var(--focus); outline-offset: -2px; }
.attention-domain-card > header { min-width: 0; display: grid; grid-template-columns: 22px minmax(0, 1fr) auto; align-items: center; gap: 8px; }
.attention-domain-icon { width: 22px; height: 22px; display: grid; place-items: center; border-radius: 4px; background: var(--neutral-muted); color: var(--muted); }
.attention-domain-icon .octicon { width: 14px; height: 14px; }
.attention-domain-card > header > strong { overflow: hidden; font-size: .8125rem; text-overflow: ellipsis; white-space: nowrap; }
.attention-domain-state { padding: 2px 6px; border: 1px solid currentColor; border-radius: 999px; color: var(--muted); font-size: .625rem; font-weight: 600; white-space: nowrap; }
.attention-domain-value { font-size: 1.375rem; font-weight: 600; font-variant-numeric: tabular-nums; line-height: 1.2; }
.attention-domain-card > p { margin: 0; color: var(--muted); font-size: .75rem; line-height: 1.45; }
.attention-domain-card > footer { display: flex; align-items: center; justify-content: space-between; padding: 10px 0 0; border-top: 1px solid var(--border); color: var(--accent); font-size: .6875rem; font-weight: 600; }
.attention-domain-critical { border-top-color: var(--danger); }
.attention-domain-critical .attention-domain-icon, .attention-domain-critical .attention-domain-state { color: var(--danger); }
.attention-domain-investigate { border-top-color: var(--attention); }
.attention-domain-investigate .attention-domain-icon, .attention-domain-investigate .attention-domain-state { color: var(--attention); }
.attention-domain-monitor { border-top-color: var(--success); }
.attention-domain-monitor .attention-domain-icon, .attention-domain-monitor .attention-domain-state { color: var(--success); }
.attention-domain-unavailable { border-top-color: var(--muted); }
.overview-method-note { margin: 10px 0 0; color: var(--muted); font-size: .6875rem; }
.overview-method-note strong { color: var(--fg); }
.overview-package-status { margin-bottom: 24px; }
.package-status-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); overflow: hidden; border: 1px solid var(--border); border-radius: 6px; background: var(--border); gap: 1px; }
.package-status-card { min-width: 0; display: grid; grid-template-rows: auto auto 1fr auto; gap: 12px; padding: 16px; border-top: 3px solid var(--muted); background: var(--canvas); color: var(--fg); }
.package-status-card > header { min-width: 0; display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.package-status-card > header > strong { min-width: 0; font-size: .8125rem; }
.package-status-identity { min-width: 0; display: inline-flex; align-items: center; gap: 6px; color: inherit; text-decoration: none; }
.package-status-identity:hover { text-decoration: underline; }
.package-status-identity > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.package-status-state { padding: 2px 6px; border: 1px solid currentColor; border-radius: 999px; color: var(--muted); font-size: .625rem; font-weight: 600; white-space: nowrap; }
.package-status-card .mode-badge { flex: none; }
.package-status-card .mode-badge .octicon { width: 8px; height: 8px; margin-right: 3px; }
.package-status-live-coverage { display: grid; gap: 7px; }
.package-status-live-coverage-heading { display: flex; align-items: end; justify-content: space-between; gap: 12px; }
.package-status-live-coverage-heading > div { display: grid; gap: 2px; }
.package-status-live-coverage-heading span { color: var(--muted); font-size: .625rem; font-weight: 600; }
.package-status-live-coverage-heading strong { font-size: .75rem; }
.package-status-live-coverage-heading > strong { flex: none; font-size: .875rem; font-variant-numeric: tabular-nums; }
.package-status-live-coverage progress { width: 100%; height: 6px; overflow: hidden; appearance: none; border: 0; border-radius: 999px; background: var(--neutral-muted); }
.package-status-live-coverage progress::-webkit-progress-bar { border-radius: 999px; background: var(--neutral-muted); }
.package-status-live-coverage progress::-webkit-progress-value { border-radius: 999px; background: var(--success); }
.package-status-live-coverage progress::-moz-progress-bar { border-radius: 999px; background: var(--success); }
.package-status-runtime { min-width: 0; }
.package-status-repository-heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 0 0 5px; border-bottom: 1px solid var(--border); color: var(--muted); font-size: .625rem; font-weight: 600; }
.package-status-repositories { display: grid; margin: 0; padding: 0; list-style: none; font-size: .6875rem; }
.package-status-repositories li { min-width: 0; display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 6px 0; border-bottom: 1px solid var(--border-muted); }
.package-status-repositories li:last-child { border-bottom: 0; }
.package-status-repository-name { min-width: 0; display: flex; align-items: center; gap: 6px; }
.package-status-repository-name > .octicon { width: 12px; height: 12px; flex: 0 0 12px; color: var(--muted); }
.package-status-repository-name > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.package-status-repositories-empty { margin: 8px 0 0; color: var(--muted); font-size: .6875rem; }
.package-status-activity { min-width: 0; display: grid; grid-template-columns: auto auto minmax(0, 1fr); align-items: center; gap: 8px 12px; padding-top: 10px; border-top: 1px solid var(--border); color: var(--muted); font-size: .625rem; text-decoration: none; }
.package-status-activity:hover strong { text-decoration: underline; }
.package-status-identity:focus-visible, .package-status-activity:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
.package-status-activity > span { min-width: 0; display: flex; align-items: center; gap: 5px; }
.package-status-activity-heading { flex-wrap: wrap; }
.package-status-activity-state { display: inline-flex; align-items: center; gap: 3px; padding: 1px 5px; border: 1px solid currentColor; border-radius: 999px; font-weight: 600; white-space: nowrap; }
.package-status-activity-state-failed { color: var(--danger); }
.package-status-activity-state-attention { color: var(--attention); }
.package-status-activity-state-success { color: var(--success); }
.package-status-activity-state-unknown { color: var(--muted); }
.package-status-activity > span:last-child { justify-self: end; }
.package-status-activity .octicon { width: 11px; height: 11px; flex: 0 0 11px; }
.package-status-activity .octicon-paper-airplane { color: var(--accent); }
.package-status-activity .octicon-shield-check { color: var(--success); }
.package-status-activity.package-status-activity-warning { color: var(--attention); }
.package-status-activity .octicon-alert { color: var(--attention); }
.package-status-activity strong { overflow: hidden; color: var(--fg); font-size: .6875rem; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.package-status-activity-warning strong { color: var(--attention); }
.package-status-activity-label { font-weight: 600; }
.package-status-attention { border-top-color: var(--attention); }
.package-status-attention .package-status-state { color: var(--attention); }
.section-heading h3 { margin: 1px 0 3px; font-size: 1.25rem; }
.workflow-attention { margin-bottom: 32px; }
.workflow-attention > .section-heading { align-items: end; }
.workflow-attention > .section-heading > strong { flex: none; font-variant-numeric: tabular-nums; }
.runtime-page [data-section-id="runtime-triage"] .custom-view-grid { gap: 0; }
.anomaly-readiness { display: flex; align-items: center; justify-content: space-between; gap: 20px; padding: 10px 14px; border: 1px solid var(--border); border-radius: 6px 6px 0 0; background: var(--canvas-subtle); }
.anomaly-readiness > span { display: inline-flex; flex: none; align-items: center; gap: 7px; font-size: .75rem; }
.anomaly-readiness .octicon { color: var(--muted); }
.anomaly-readiness p { margin: 0; color: var(--muted); font-size: .75rem; text-align: right; }
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
.control-plane-vitals dd { margin: 2px 0 0; font-size: 1.625rem; font-weight: 600; font-variant-numeric: tabular-nums; }
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
.package-aic-utilization > header { padding: 4px 0 12px; }
.package-aic-utilization > header h3 { margin: 2px 0 0; font-size: 1.125rem; }
.package-aic-utilization > header p { margin: 2px 0 0; color: var(--muted); font-size: .8125rem; }
.utilization-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 14px; }
.utilization-item { min-width: 0; padding: 14px 16px; border: 1px solid var(--border); border-radius: 6px; background: var(--canvas); }
.utilization-item > header { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
.utilization-item > header span { overflow: hidden; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.utilization-item > header strong { font-size: 1.25rem; font-variant-numeric: tabular-nums; }
.utilization-track { height: 8px; margin: 12px 0 8px; overflow: hidden; border-radius: 4px; background: var(--canvas-subtle); box-shadow: inset 0 0 0 1px var(--border); }
.utilization-track span { display: block; height: 100%; border-radius: inherit; background: var(--success); }
.utilization-medium .utilization-track span { background: var(--attention); }
.utilization-high .utilization-track span { background: var(--danger); }
.utilization-empty .utilization-track span { background: var(--muted); }
.utilization-item p { min-height: 18px; margin: 0; color: var(--muted); font-size: .75rem; }
.packages-view { min-width: 0; display: grid; grid-template-columns: minmax(0, 1fr); gap: 28px; margin-top: 36px; }
.package-mode-tabs { width: min(100%, 264px); display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); padding: 2px; border: 1px solid var(--border); border-radius: 6px; background: var(--canvas-subtle); }
.package-mode-tabs button { min-height: 34px; padding: 5px 12px; border: 0; border-radius: 5px; background: transparent; color: var(--muted); font: inherit; font-size: .75rem; font-weight: 600; cursor: pointer; }
.package-mode-tabs button:hover { color: var(--fg); background: var(--neutral-muted); }
.package-mode-tabs button[aria-selected="true"] { color: var(--fg); background: var(--canvas); box-shadow: inset 0 0 0 1px var(--border); }
.packages-mode-content { min-width: 0; display: grid; grid-template-columns: minmax(0, 1fr); gap: 28px; }
.package-utilization-heading { margin-bottom: 10px; }
.package-utilization-heading h3 { margin: 0 0 2px; font-size: 1.25rem; }
.package-utilization-heading p { margin: 0; color: var(--muted); }
.package-utilization-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
.package-utilization-card { min-width: 0; padding: 14px 16px; border: 1px solid var(--border); border-radius: 6px; background: var(--canvas); }
.package-utilization-card > header { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
.package-utilization-identity, .package-utilization-identity > a, .package-summary-table tbody th a { min-width: 0; display: inline-flex; align-items: center; gap: 6px; }
.package-utilization-identity strong { display: block; }
.package-utilization-card > header strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.package-utilization-value { flex: none; font-size: 1.25rem; font-weight: 600; font-variant-numeric: tabular-nums; }
.package-utilization-card p { min-height: 18px; margin: 0; color: var(--muted); font-size: .75rem; }
.package-utilization-card small { display: block; margin-top: 4px; color: var(--muted); font-size: .6875rem; }
.package-summary-heading { margin-bottom: 10px; }
.package-summary-heading h3 { margin: 0 0 2px; font-size: 1.25rem; }
.package-summary-heading p { margin: 0; color: var(--muted); }
.package-summary .table-region { margin-bottom: 0; }
.package-summary-table { min-width: 920px; }
.package-summary-table tbody th { font-weight: 600; white-space: nowrap; }
.package-tabs { display: flex; gap: 4px; margin-bottom: 20px; border-bottom: 1px solid var(--border); }
.package-tabs a { display: inline-flex; align-items: center; gap: 8px; position: relative; padding: 10px 14px 12px; color: var(--fg); font-weight: 600; text-decoration: none; }
.package-tabs a > .octicon { color: var(--muted); }
.package-tabs a:hover { background: var(--canvas-subtle); }
.package-tabs a[aria-current="page"]::after { content: ""; height: 2px; position: absolute; right: 8px; bottom: -1px; left: 8px; background: var(--danger); }
.workflow-badge-orchestrator { border-color: var(--accent); color: var(--accent); }
.workflow-badge-worker { border-color: var(--success); color: var(--success); }
.package-trend-panel { overflow: hidden; border: 1px solid var(--border); border-radius: 6px; background: var(--canvas); }
.package-trend-panel > header { min-height: 72px; display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; padding: 14px 16px; border-bottom: 1px solid var(--border); }
.package-trend-panel > header h3 { margin: 0; font-size: 1rem; }
.package-trend-panel > header p { margin: 2px 0 0; color: var(--muted); font-size: .75rem; }
.package-trend-panel > header p strong { margin-right: 8px; color: var(--fg); font-size: 1.375rem; font-variant-numeric: tabular-nums; }
.package-trend-group { display: inline-flex; align-items: center; gap: 6px; color: var(--muted); font-size: .75rem; }
.package-trend-legend { display: flex; gap: 20px; padding: 10px 16px 0; color: var(--muted); font-size: .6875rem; }
.package-trend-legend span { display: inline-flex; align-items: center; gap: 6px; }
.package-trend-legend i { width: 18px; height: 0; border-top-width: 2px; border-top-style: solid; }
.package-legend-successful { border-color: var(--success); }
.package-legend-failed { border-color: var(--danger); border-top-style: dashed !important; }
.package-legend-cancelled { border-color: var(--cancelled); border-top-style: dotted !important; }
.package-trend-chart { overflow-x: auto; padding: 6px 18px 0; }
.package-trend-chart svg { width: 100%; min-width: 760px; height: auto; overflow: visible; }
.package-trend-chart line { stroke: var(--border-muted); stroke-width: 1; vector-effect: non-scaling-stroke; }
.package-trend-chart .vertical-grid { stroke-dasharray: 2 2; }
.package-trend-chart text { fill: var(--muted); font-size: .6875rem; }
.package-trend-chart polyline { fill: none; stroke-width: 2; vector-effect: non-scaling-stroke; }
.package-chart-successful { stroke: var(--success); }
.package-chart-failed { stroke: var(--danger); stroke-dasharray: 8 5; }
.package-chart-cancelled { stroke: var(--cancelled); stroke-dasharray: 8 4 2 4; }
.package-chart-point { cursor: crosshair; outline: none; }
.package-point-hit { fill: transparent; pointer-events: all; }
.package-point-marker { fill: var(--canvas); stroke-width: 3; opacity: 0; pointer-events: none; vector-effect: non-scaling-stroke; }
.package-point-marker-successful { stroke: var(--success); }
.package-point-marker-failed { stroke: var(--danger); }
.package-point-marker-cancelled { stroke: var(--cancelled); }
.package-point-tooltip { opacity: 0; pointer-events: none; transition: opacity 80ms linear; }
.package-point-tooltip rect { fill: var(--canvas-subtle); stroke: var(--border); vector-effect: non-scaling-stroke; }
.package-trend-chart .package-point-tooltip .tooltip-date { fill: var(--muted); font-weight: 600; }
.package-trend-chart .package-point-tooltip :is(.tooltip-label, .tooltip-value) { fill: var(--fg); font-weight: 600; }
.package-trend-chart .tooltip-swatch-successful { fill: var(--success); }
.package-trend-chart .tooltip-swatch-failed { fill: var(--danger); }
.package-trend-chart .tooltip-swatch-cancelled { fill: var(--cancelled); }
.package-chart-point:hover :is(.package-point-marker, .package-point-tooltip), .package-chart-point:focus-visible :is(.package-point-marker, .package-point-tooltip) { opacity: 1; }
.package-chart-point:focus-visible .package-point-hit { fill: color-mix(in srgb, var(--focus) 18%, transparent); stroke: var(--focus); stroke-width: 2; vector-effect: non-scaling-stroke; }
.package-trend-axis { display: flex; justify-content: space-between; padding: 0 30px 8px; color: var(--muted); font-size: .6875rem; }
.package-trend-coverage { margin: 0; padding: 0 16px 12px; color: var(--muted); font-size: .75rem; }
.attention-panel { overflow: hidden; border: 1px solid var(--border); border-radius: 6px; background: var(--canvas); }
.attention-panel > header { min-height: 72px; display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 14px 16px; border-bottom: 1px solid var(--border); background: var(--canvas-subtle); }
.attention-panel > header h3, .managed-packages > header h3 { margin: 2px 0 0; font-size: 1.125rem; }
.attention-count { min-width: 28px; min-height: 24px; display: inline-grid; place-items: center; padding: 1px 8px; border-radius: 2em; background: var(--neutral-muted); font-weight: 600; font-variant-numeric: tabular-nums; }
.attention-list { margin: 0; padding: 0; list-style: none; }
.attention-item { min-height: 64px; display: grid; grid-template-columns: 28px minmax(0, 1fr); align-items: center; gap: 10px; padding: 10px 16px; }
.attention-item + .attention-item { border-top: 1px solid var(--border-muted); }
.attention-icon { width: 20px; height: 20px; display: grid; place-items: center; color: var(--attention); }
.attention-danger .attention-icon { color: var(--danger); }
.attention-success .attention-icon { color: var(--success); }
.attention-item strong { font-size: .875rem; }
.attention-item p { margin: 2px 0 0; color: var(--muted); font-size: .8125rem; }
.configuration-view { display: grid; gap: 20px; }
.configuration-diagnostics { display: grid; gap: 8px; }
.configuration-diagnostic { display: grid; grid-template-columns: 20px minmax(0, 1fr); gap: 10px; padding: 12px 14px; border: 1px solid var(--border); border-left-width: 4px; border-radius: 6px; background: var(--canvas-subtle); }
.configuration-diagnostic > .octicon { margin-top: 2px; color: var(--attention); }
.configuration-diagnostic-valid { border-left-color: var(--success); }
.configuration-diagnostic-valid > .octicon { color: var(--success); }
.configuration-diagnostic-error { border-left-color: var(--danger); }
.configuration-diagnostic-error > .octicon { color: var(--danger); }
.configuration-diagnostic-warning, .configuration-diagnostic-guidance { border-left-color: var(--attention); }
.configuration-diagnostic strong, .configuration-diagnostic code { display: block; }
.configuration-diagnostic code { margin-top: 2px; color: var(--muted); font-size: .75rem; overflow-wrap: anywhere; }
.configuration-diagnostic p { margin: 3px 0 0; color: var(--muted); }
.configuration-entries > summary { cursor: pointer; font-size: 1rem; font-weight: 600; }
.configuration-entries[open] > summary { margin-bottom: 10px; }
.configuration-entry { min-width: 0; border-top: 1px solid var(--border-muted); }
.configuration-entry:first-of-type { border: 1px solid var(--border); border-radius: 6px; }
.configuration-entry > summary, .configuration-entry:not(details) { padding: 10px 12px; }
.configuration-entry > summary { cursor: pointer; list-style-position: inside; }
.configuration-entry > summary::marker { color: var(--muted); }
.configuration-entry-heading { min-width: 0; display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
.configuration-entry-heading code { color: var(--fg); font-weight: 600; overflow-wrap: anywhere; }
.configuration-entry-value { flex: none; color: var(--muted); font-size: .75rem; }
.configuration-entry p { margin: 3px 0 0; color: var(--muted); font-size: .8125rem; }
.configuration-entry-children { margin-left: 18px; border-left: 1px solid var(--border-muted); }
.configuration-entry-children > .configuration-entry { padding-left: 8px; }
.configuration-raw { overflow: hidden; border: 1px solid var(--border); border-radius: 6px; background: var(--canvas-inset); }
.configuration-raw > summary { padding: 10px 14px; border-bottom: 1px solid transparent; background: var(--canvas-subtle); cursor: pointer; font-weight: 600; }
.configuration-raw[open] > summary { border-bottom-color: var(--border); }
.configuration-raw-actions { min-height: 42px; display: flex; align-items: center; gap: 10px; padding: 7px 12px; border-bottom: 1px solid var(--border-muted); }
.configuration-copy-button { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border: 1px solid var(--border); border-radius: 6px; background: var(--canvas-subtle); color: var(--fg); font: inherit; cursor: pointer; }
.configuration-copy-button:hover { background: var(--neutral-muted); }
.configuration-copy-status { color: var(--muted); font-size: .75rem; }
.configuration-raw pre { max-height: 520px; margin: 0; padding: 16px; overflow: auto; color: var(--fg); font-size: .75rem; line-height: 1.5; tab-size: 2; }
.configuration-unavailable { padding: 16px; border: 1px dashed var(--danger); border-radius: 6px; color: var(--muted); }
.configuration-actions { display: grid; gap: 12px; }
.configuration-action-list { margin: 0; padding: 0; overflow: hidden; border: 1px solid var(--border); border-radius: 6px; background: var(--canvas); list-style: none; }
.configuration-action + .configuration-action { border-top: 1px solid var(--border); }
.configuration-action { display: grid; gap: 10px; padding: 14px 16px; }
.configuration-action-summary { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 16px; }
.configuration-action-details { display: flex; flex-wrap: wrap; gap: 8px 24px; margin: 0; }
.configuration-action-details > div { display: grid; gap: 2px; }
.configuration-action-details dt { color: var(--muted); font-size: .6875rem; font-weight: 600; }
.configuration-action-details dd { margin: 0; overflow-wrap: anywhere; font-size: .8125rem; }
.configuration-actions-empty { margin: 0; padding: 16px; border: 1px dashed var(--border); border-radius: 6px; color: var(--muted); }
:is(.readiness-page, .runtime-page, .security-page, .firewall-page, .value-page, .cost-page) .layout-section { padding: 0; border: 0; background: transparent; }
:is(.readiness-page, .runtime-page, .security-page, .firewall-page, .value-page, .cost-page) .layout-section-header { display: flex; align-items: end; justify-content: space-between; gap: 24px; }
:is(.readiness-page, .runtime-page, .security-page, .firewall-page, .value-page, .cost-page) .layout-section-header h3 { margin: 2px 0 0; font-size: 1.25rem; }
:is(.readiness-page, .runtime-page, .security-page, .firewall-page, .value-page, .cost-page) .layout-section-header > strong { flex: none; color: var(--muted); font-size: .75rem; }
:is(.runtime-page, .security-page, .firewall-page, .value-page) .layout-section .page-section > h4,
:is(.runtime-page, .security-page, .firewall-page, .value-page) .layout-section .view-source,
:is(.runtime-page, .security-page, .firewall-page, .value-page) .layout-section .view-metadata { position: absolute; width: 1px; height: 1px; padding: 0; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
:is(.runtime-page, .security-page, .firewall-page, .value-page) .layout-section .table-region { margin-top: 0; }
.summary-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 1px; margin: 0; overflow: hidden; border: 1px solid var(--border); border-radius: 6px 6px 0 0; background: var(--border); }
.summary-grid > div { min-width: 0; padding: 13px 15px; background: var(--canvas-subtle); }
.summary-grid dt { color: var(--muted); font-size: .6875rem; font-weight: 600; text-transform: uppercase; }
.summary-grid dd { margin: 2px 0 0; font-size: 1.25rem; font-weight: 600; font-variant-numeric: tabular-nums; }
.readiness-verdict { display: grid; overflow: hidden; border: 1px solid var(--border); border-left-width: 4px; border-radius: 6px; background: var(--canvas-subtle); }
.readiness-verdict-blocked { border-left-color: var(--danger); }
.readiness-verdict-ready { border-left-color: var(--success); }
.readiness-verdict-unknown { border-left-color: var(--attention); }
.readiness-verdict-primary { display: flex; align-items: flex-start; justify-content: space-between; gap: 24px; padding: 22px 24px; }
.readiness-hero { min-width: 0; display: grid; gap: 8px; }
.readiness-hero > small, .readiness-block h3 { color: var(--muted); font-size: .6875rem; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
.readiness-hero > small { display: block; }
.readiness-state { display: flex; align-items: center; gap: 10px; }
.readiness-state strong { font-size: 1.5rem; letter-spacing: .02em; }
.readiness-hero p { max-width: 58rem; margin: 0; color: var(--muted); }
.readiness-snapshot-meta { display: flex; flex-wrap: wrap; gap: 24px; margin-top: 8px; color: var(--muted); font-size: .75rem; }
.readiness-snapshot-meta strong { color: var(--fg); }
.readiness-verdict-summary { min-width: 180px; display: grid; align-content: center; justify-items: end; gap: 4px; color: var(--muted); text-align: right; }
.readiness-verdict-summary strong { color: var(--fg); }
.readiness-verdict-legacy { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
.readiness-verdict-icon { display: grid; color: var(--attention); }
.readiness-verdict-icon .octicon { width: 24px; height: 24px; }
.readiness-verdict-blocked .readiness-verdict-icon { color: var(--danger); }
.readiness-verdict-ready .readiness-verdict-icon { color: var(--success); }
.readiness-verdict-details { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); border-top: 1px solid var(--border); }
.readiness-block { min-width: 0; padding: 18px 20px 20px; }
.readiness-block + .readiness-block { border-left: 1px solid var(--border); }
.readiness-block h3 { margin: 0 0 12px; }
.readiness-block-content { display: grid; gap: 10px; }
.readiness-block-content > p { margin: 0; color: var(--muted); }
.readiness-blocker, .readiness-observation { display: grid; gap: 3px; }
.readiness-blocker strong, .readiness-observation strong { font-size: .8125rem; }
.readiness-blocker p, .readiness-observation span { margin: 0; color: var(--muted); font-size: .75rem; }
.readiness-blocker small { color: var(--muted); font-size: .6875rem; }
.readiness-gate { display: grid; grid-template-columns: 18px minmax(0, 1fr); gap: 8px; align-items: start; }
.readiness-gate > .octicon { margin-top: 2px; color: var(--success); }
.readiness-gate-blocked > .octicon { color: var(--danger); }
.readiness-gate-unknown > .octicon { color: var(--attention); }
.readiness-gate span { display: grid; gap: 2px; }
.readiness-gate small { color: var(--muted); font-size: .6875rem; }
.readiness-evidence-row { display: flex; justify-content: space-between; gap: 12px; color: var(--muted); font-size: .75rem; }
.readiness-evidence-row strong { color: var(--fg); text-align: right; }
.readiness-clear { padding: 8px 0; }
.dashboard-callout { display: grid; grid-template-columns: minmax(240px, .55fr) minmax(0, 1fr); align-items: center; gap: 24px; padding: 16px; overflow: hidden; border: 1px solid var(--border); border-left: 4px solid var(--attention); border-radius: 6px; background: color-mix(in srgb, var(--attention) 5%, var(--canvas)); }
.dashboard-callout-heading { display: flex; align-items: center; gap: 12px; }
.dashboard-callout-heading > .octicon { width: 28px; height: 28px; flex: none; color: var(--attention); }
.dashboard-callout h3, .dashboard-callout h4 { margin: 1px 0 0; font-size: 1rem; }
.dashboard-callout p { margin: 0; color: var(--muted); font-size: .8125rem; }
.signal-boundary-note { margin: 0; padding: 8px 15px; border: 1px solid var(--border); border-top: 0; color: var(--muted); font-size: .6875rem; }
.signal-list { margin: 0; padding: 0; overflow: hidden; border: 1px solid var(--border); border-top: 0; border-radius: 0 0 6px 6px; list-style: none; }
.signal-list > li + li { border-top: 1px solid var(--border-muted); }
.signal-item > :is(a, div) { min-height: 68px; display: grid; grid-template-columns: 24px 20px minmax(0, 1fr) minmax(150px, auto); align-items: center; gap: 10px; padding: 9px 14px; color: var(--fg); text-decoration: none; }
.signal-item > a:hover { background: var(--canvas-subtle); }
.signal-item > a:focus-visible { outline: 2px solid var(--focus); outline-offset: -2px; }
.signal-rank { color: var(--muted); font-size: .6875rem; font-variant-numeric: tabular-nums; text-align: center; }
.signal-icon { width: 20px; display: grid; place-items: center; color: var(--attention); }
.signal-critical .signal-icon { color: var(--danger); }
.signal-informational .signal-icon { color: var(--accent); }
.signal-copy { min-width: 0; display: grid; }
.signal-copy > span { color: var(--muted); font-size: .625rem; font-weight: 600; text-transform: uppercase; }
.signal-copy > strong, .signal-copy > small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.signal-copy > strong { font-size: .8125rem; }
.signal-copy > small { color: var(--muted); font-size: .75rem; }
.signal-evidence { min-width: 0; display: grid; justify-items: end; text-align: right; }
.signal-evidence strong { font-size: .75rem; }
.signal-evidence small { display: inline-flex; align-items: center; gap: 4px; color: var(--muted); font-size: .6875rem; }
.signal-evidence .octicon { width: 12px; height: 12px; }
.dashboard-next-home-page .canonical-attention-list .signal-list { border-top: 1px solid var(--border); border-radius: 6px; }
.dashboard-next-home-page .canonical-attention-item > :is(a, div) { min-height: 76px; grid-template-columns: 54px 20px minmax(0, 1fr) minmax(180px, .55fr); border-left: 3px solid var(--attention); background: color-mix(in srgb, var(--attention) 4%, var(--canvas)); }
.dashboard-next-home-page .canonical-attention-item.signal-critical > :is(a, div) { border-left-color: var(--danger); background: color-mix(in srgb, var(--danger) 4%, var(--canvas)); }
.dashboard-next-home-page .canonical-attention-item.signal-informational > :is(a, div) { border-left-color: var(--accent); background: color-mix(in srgb, var(--accent) 4%, var(--canvas)); }
.dashboard-next-home-page .signal-priority-rank { display: grid; justify-items: center; color: var(--fg); line-height: 1; }
.dashboard-next-home-page .signal-priority-rank strong { font-size: 1.5rem; font-variant-numeric: tabular-nums; }
.dashboard-next-home-page .signal-priority-rank small { margin-top: 3px; color: var(--muted); font-size: .5625rem; font-weight: 700; text-transform: uppercase; }
.dashboard-next-home-page .custom-view[data-view-layout="half"].chart-view-pie .pie-chart-card { grid-template-columns: minmax(0, 1fr); padding: 16px; }
.dashboard-next-home-page .custom-view[data-view-layout="half"].chart-view-pie .pie-chart-layout { grid-column: 1; grid-row: auto; grid-template-columns: minmax(120px, 160px) minmax(0, 1fr); gap: 12px; }
.dashboard-next-home-page .custom-view[data-view-layout="half"].chart-view-pie .pie-chart-card > :is(.view-source, .view-metadata, .view-context) { grid-column: 1; }
.signal-clear { min-height: 68px; display: grid; grid-template-columns: 20px minmax(0, 1fr); align-items: center; gap: 10px; padding: 9px 14px; }
.signal-clear .signal-icon { color: var(--success); }
.managed-packages > header { min-height: 72px; padding: 10px 0; }
.managed-package-list { display: grid; gap: 10px; }
.managed-package-card { overflow: hidden; border: 1px solid var(--border); border-radius: 6px; background: var(--canvas); }
.managed-package-card > header { min-height: 48px; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 14px; }
.managed-package-card > header > div { min-width: 0; display: flex; align-items: center; gap: 9px; }
.managed-package-card h4 { margin: 0; overflow: hidden; font-size: .9375rem; text-overflow: ellipsis; white-space: nowrap; }
.managed-package-icon { display: grid; color: var(--fg); }
.managed-package-card .mode-badge { gap: 4px; padding-inline: 10px; font-size: .75rem; }
.managed-package-card dl { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; margin: 0; padding: 8px 14px 14px; }
.managed-package-card dt { color: var(--muted); font-size: .75rem; }
.managed-package-card dd { margin: 2px 0 0; overflow: hidden; font-size: .875rem; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.managed-package-card .inventory-ready { color: var(--success); }
.managed-package-card .inventory-attention { color: var(--attention); }
.overview-content > .layout-section { padding: 0; border: 0; background: transparent; }
.overview-content > .layout-section > .layout-section-header { margin: 0 0 12px; padding-top: 20px; border-top: 1px solid var(--border); }
.table-region { overflow-x: auto; border: 1px solid var(--border); border-radius: 6px; margin: 12px 0 20px; background: var(--canvas); }
.table-scroll { max-height: 60vh; overflow: auto; overscroll-behavior: contain; }
.table-region-static .table-scroll, .table-region-expanded .table-scroll { max-height: none; overflow: visible; overscroll-behavior: auto; }
.table-scroll:focus-visible { outline: 2px solid var(--focus); outline-offset: -2px; }
.table-scroll thead th { position: sticky; top: 0; z-index: 1; }
.table-sort { display: inline-flex; align-items: center; gap: 4px; width: 100%; padding: 0; border: 0; background: none; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.table-sort::after { content: "↕"; color: var(--muted); font-size: .6875rem; opacity: .5; }
.table-sort:hover { color: var(--fg); }
th[aria-sort="ascending"] .table-sort::after { content: "↑"; opacity: 1; }
th[aria-sort="descending"] .table-sort::after { content: "↓"; opacity: 1; }
.table-filter { min-width: 600px; display: flex; flex-wrap: wrap; align-items: end; gap: 10px 16px; padding: 10px 14px; border-bottom: 1px solid var(--border); background: var(--canvas-subtle); }
.table-filter label { min-width: 160px; flex: 0 1 220px; }
.table-filter label:first-child { min-width: 240px; flex-grow: 1; }
.table-filter label > span { display: block; margin-bottom: 4px; color: var(--muted); font-size: .6875rem; font-weight: 600; }
.table-filter :is(input, select) { width: 100%; min-height: 34px; padding: 5px 9px; border: 1px solid var(--border); border-radius: 6px; background: var(--canvas); color: var(--fg); font: inherit; }
.table-filter :is(input, select):focus-visible { outline: 2px solid var(--focus); outline-offset: -1px; }
.table-filter-result { flex: none; padding-bottom: 7px; color: var(--muted); font-size: .75rem; }
.table-filter-more { min-height: 32px; margin: 10px 14px; padding: 5px 12px; border: 1px solid var(--border); border-radius: 6px; background: var(--canvas-subtle); color: var(--fg); font: inherit; font-size: .75rem; font-weight: 600; cursor: pointer; }
.table-filter-more:hover { background: var(--neutral-muted); }
table { width: 100%; min-width: 600px; border-collapse: collapse; font-size: .875rem; }
caption { padding: 10px 14px; border-bottom: 1px solid var(--border); background: var(--canvas-subtle); color: var(--muted); text-align: left; font-weight: 600; font-size: .8125rem; }
th, td { padding: 10px 14px; border-bottom: 1px solid var(--border-muted); text-align: left; font-variant-numeric: tabular-nums; }
thead th { background: var(--canvas-subtle); color: var(--muted); font-size: .75rem; font-weight: 600; border-bottom: 1px solid var(--border); white-space: nowrap; }
.table-summary-row th { min-width: 150px; padding-block: 8px; vertical-align: top; white-space: normal; }
.table-summary-skeleton { display: grid; gap: 6px; padding-block: 2px; }
.table-summary-skeleton span { height: 10px; border-radius: 4px; background: linear-gradient(90deg, var(--canvas-subtle) 25%, var(--neutral-muted) 50%, var(--canvas-subtle) 75%); background-size: 200% 100%; animation: dashboard-skeleton-pulse 1.5s ease-in-out infinite; }
.table-summary-skeleton span:first-child { height: 32px; }
.table-summary-skeleton span:last-child { width: 72%; }
.table-summary-categories { display: grid; gap: 2px; margin: 0; padding: 0; list-style: none; font-weight: 400; }
.table-summary-categories li { display: flex; min-width: 0; justify-content: space-between; gap: 8px; }
.table-summary-categories li span { overflow: hidden; color: var(--fg); text-overflow: ellipsis; white-space: nowrap; }
.table-summary-categories strong, .table-summary-boolean strong, .table-summary-count strong { color: var(--fg); font-weight: 600; }
.table-summary-count { font-weight: 400; }
.table-summary-quantitative { display: grid; gap: 6px; }
.table-summary-histogram { width: 100%; height: 32px; overflow: visible; }
.table-summary-histogram rect { fill: var(--accent); opacity: .75; }
.table-output-evidence { display: block; max-width: 80ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tree-table-cell { display: block; padding-inline-start: calc(var(--tree-depth) * 1.25rem); }
:is(.table-summary-quantitative dl, .table-summary-temporal) { display: grid; gap: 2px; margin: 0; }
:is(.table-summary-quantitative dl, .table-summary-temporal) div { display: flex; justify-content: space-between; gap: 8px; }
:is(.table-summary-quantitative dl, .table-summary-temporal) dt { font-weight: 400; }
:is(.table-summary-quantitative dl, .table-summary-temporal) dd { margin: 0; color: var(--fg); font-weight: 600; }
.table-summary-empty { font-weight: 400; font-style: italic; }
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
.markdown-body h3 { margin: 20px 0 10px; font-size: 1.0625rem; }
.markdown-body p, .markdown-body ul, .markdown-body ol, .markdown-body blockquote, .markdown-body pre, .markdown-body table { margin-block: 0 16px; }
.markdown-body li + li { margin-top: 4px; }
.markdown-body blockquote { margin-inline: 0; padding: 0 16px; border-left: 4px solid var(--border); color: var(--muted); }
.markdown-body pre { max-width: 100%; overflow: auto; padding: 14px 16px; border-radius: 6px; background: var(--canvas-inset); }
.markdown-body pre code { padding: 0; background: transparent; }
.markdown-body img { max-width: 100%; height: auto; }
.markdown-body table { display: block; max-width: 100%; overflow-x: auto; border-spacing: 0; }
.markdown-body table th, .markdown-body table td { padding: 6px 12px; border: 1px solid var(--border); }
.markdown-body .task-list-item { list-style: none; }
.markdown-body input[type="checkbox"] { margin-right: 6px; }
.outcome-meta section { padding: 14px 0; border-bottom: 1px solid var(--border); }
.outcome-meta section:first-child { padding-top: 0; }
.outcome-meta h2 { margin: 0 0 8px; color: var(--muted); font-size: .75rem; }
.outcome-meta p { margin: 0; overflow-wrap: anywhere; }
.outcome-meta a { display: inline-flex; align-items: center; gap: 5px; }
.mode-indicator { min-height: 22px; display: inline-flex; flex: none; align-items: center; gap: 5px; padding: 1px 7px; border: 1px solid var(--border); border-radius: 2em; font-size: .6875rem; font-weight: 600; text-transform: none; white-space: nowrap; }
.mode-indicator[hidden] { display: none; }
.mode-indicator .octicon { width: 13px; height: 13px; flex-basis: 13px; }
.provenance-section { margin-top: 24px; padding-top: 16px; border-top: 1px solid var(--border-muted); }
.provenance-list { margin: 8px 0 0; padding-left: 20px; color: var(--muted); font-size: .8125rem; }
.provenance-list li + li { margin-top: 4px; }
code { padding: 2px 4px; border-radius: 4px; background: var(--neutral-muted); font: .75rem ui-monospace, SFMono-Regular, Consolas, monospace; }
footer { padding: 20px 24px; border-top: 1px solid var(--border); color: var(--muted); font-size: .75rem; }
.empty, .page-placeholder { margin: 0; padding: 28px 16px; color: var(--muted); text-align: center; }
.source-loading-status { margin: 0 0 16px; color: var(--muted); font-size: .8125rem; }
.source-loading-warning { color: var(--attention); }
.dashboard-loading .dashboard-pages { display: none; }
.dashboard-loading-skeleton { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; }
.dashboard-loading-skeleton > div { border: 1px solid var(--border-muted); border-radius: 6px; background: linear-gradient(90deg, var(--canvas-subtle) 25%, var(--neutral-muted) 50%, var(--canvas-subtle) 75%); background-size: 200% 100%; animation: dashboard-skeleton-pulse 1.5s ease-in-out infinite; }
.dashboard-view-skeleton { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; }
.dashboard-view-skeleton > div { border: 1px solid var(--border-muted); border-radius: 6px; background: linear-gradient(90deg, var(--canvas-subtle) 25%, var(--neutral-muted) 50%, var(--canvas-subtle) 75%); background-size: 200% 100%; animation: dashboard-skeleton-pulse 1.5s ease-in-out infinite; }
.skeleton-card { min-height: 104px; }
.skeleton-panel { min-height: 280px; grid-column: 1 / -1; }
.experiments-evaluation { display: grid; gap: 24px; }
.experiment-filters { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; padding: 14px; border: 1px solid var(--border); border-radius: 6px; background: var(--canvas-subtle); }
.experiment-filters label { min-width: 0; color: var(--muted); font-size: .6875rem; font-weight: 600; }
.experiment-filters label > span { display: block; margin-bottom: 4px; }
.experiment-filters select { width: 100%; min-height: 34px; padding: 5px 8px; border: 1px solid var(--border); border-radius: 6px; background: var(--canvas); color: var(--fg); font: inherit; }
.experiment-filters select:focus-visible { outline: 2px solid var(--focus); outline-offset: -1px; }
.experiment-overview { display: grid; grid-template-columns: minmax(260px, .8fr) minmax(0, 2fr); gap: 18px; }
.experiment-readiness-chart { min-width: 0; display: grid; grid-template-columns: 112px minmax(0, 1fr); align-items: center; gap: 18px; padding: 18px; border: 1px solid var(--border); border-radius: 6px; background: var(--canvas-subtle); }
.experiment-readiness-chart h2 { margin: 0; font-size: 1rem; }
.experiment-readiness-chart p { margin: 3px 0 8px; color: var(--muted); font-size: .75rem; }
.experiment-readiness-donut { width: 108px; height: 108px; display: grid; place-items: center; position: relative; border-radius: 50%; background: conic-gradient(var(--success) 0 var(--ready), var(--accent) var(--ready) var(--collecting), var(--cancelled) var(--collecting) 360deg); }
.experiment-readiness-donut::after { content: ""; width: 68px; height: 68px; position: absolute; border-radius: 50%; background: var(--canvas-subtle); }
.experiment-readiness-donut > span { z-index: 1; font-size: 1.5rem; font-weight: 600; }
.experiment-state-legend { display: flex; flex-wrap: wrap; gap: 5px 12px; margin: 0; padding: 0; color: var(--muted); font-size: .6875rem; list-style: none; }
.experiment-state-legend li { display: inline-flex; align-items: center; gap: 5px; }
.state-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--cancelled); }
.state-ready { background: var(--success); }
.state-collecting { background: var(--accent); }
.experiment-summary { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); margin: 0; border: 1px solid var(--border); border-radius: 6px; background: var(--canvas-subtle); }
.experiment-summary > div { min-width: 0; padding: 18px 14px; }
.experiment-summary > div + div { border-left: 1px solid var(--border); }
.experiment-summary dt { min-height: 36px; color: var(--muted); font-size: .6875rem; font-weight: 600; text-transform: uppercase; }
.experiment-summary dd { margin: 4px 0 0; font-size: 1.375rem; font-weight: 600; font-variant-numeric: tabular-nums; }
.experiment-section { min-width: 0; }
.experiment-section-heading, .experiment-selection-heading { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; margin-bottom: 10px; }
.experiment-section-heading h2, .experiment-selection-heading h2 { margin: 0; font-size: 1.125rem; }
.experiment-section-heading p { margin: 2px 0 0; color: var(--muted); font-size: .8125rem; }
.experiment-selection-heading { padding-bottom: 12px; border-bottom: 1px solid var(--border); }
.experiment-selection-heading span:first-child { color: var(--muted); font-size: .6875rem; font-weight: 600; text-transform: uppercase; }
.experiment-decision-table { min-width: 1180px; }
.experiment-decision-table tbody tr { cursor: pointer; }
.experiment-decision-table tbody tr.selected { background: var(--accent-muted); box-shadow: inset 3px 0 var(--accent); }
.experiment-decision-table tbody th button { padding: 0; border: 0; background: transparent; color: var(--accent); font: inherit; font-weight: 600; cursor: pointer; }
.experiment-decision-table td small { display: block; color: var(--muted); }
.experiment-detail { display: grid; gap: 24px; padding-top: 4px; }
.experiment-metric-table { min-width: 980px; }
.experiment-badge { display: inline-flex; align-items: center; gap: 4px; padding: 1px 7px; border: 1px solid var(--border); border-radius: 2em; color: var(--muted); font-size: .6875rem; font-weight: 600; white-space: nowrap; }
.experiment-badge .octicon { width: 12px; height: 12px; }
.experiment-badge-success { border-color: color-mix(in srgb, var(--success) 45%, var(--border)); background: var(--success-muted); color: var(--success); }
.experiment-badge-danger { border-color: color-mix(in srgb, var(--danger) 45%, var(--border)); background: color-mix(in srgb, var(--danger) 10%, transparent); color: var(--danger); }
.experiment-badge-attention { border-color: color-mix(in srgb, var(--attention) 45%, var(--border)); background: var(--attention-muted); color: var(--attention); }
.effect { font-weight: 600; font-variant-numeric: tabular-nums; white-space: nowrap; }
.effect-positive { color: var(--success); }
.effect-negative { color: var(--danger); }
.effect-neutral, .effect-unknown, .muted { color: var(--muted); }
.eval-outcome-list { display: grid; gap: 10px; }
.eval-outcome { padding: 14px 16px; border: 1px solid var(--border); border-radius: 6px; background: var(--canvas-subtle); }
.eval-outcome > header { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 10px; }
.eval-outcome > header span { display: block; color: var(--muted); font-size: .75rem; }
.eval-bar-row { display: grid; grid-template-columns: minmax(90px, .25fr) minmax(0, 1fr); align-items: center; gap: 10px; margin-top: 6px; }
.eval-stacked-bar { min-height: 28px; display: flex; overflow: hidden; border: 1px solid var(--border); border-radius: 4px; background: var(--neutral-muted); }
.eval-stacked-bar span { min-width: 0; display: grid; place-items: center; overflow: hidden; color: var(--on-emphasis); font-size: .6875rem; font-weight: 600; white-space: nowrap; }
.eval-stacked-bar .yes { background: var(--success); }
.eval-stacked-bar .no { background: var(--danger); }
.eval-stacked-bar .unknown { background: var(--cancelled); }
.grader-ranking { margin: 0; padding: 0; border: 1px solid var(--border); border-radius: 6px; list-style: none; }
.grader-ranking li { min-height: 44px; display: grid; grid-template-columns: 20px minmax(220px, 1fr) 100px 80px auto; align-items: center; gap: 10px; padding: 8px 14px; }
.grader-ranking li + li { border-top: 1px solid var(--border-muted); }
.grader-rank-icon { color: var(--muted); }
.observation-quality { padding: 18px; border: 1px solid var(--border); border-radius: 6px; background: var(--canvas-subtle); }
.experiment-warning, .experiment-partial { display: flex; align-items: flex-start; gap: 8px; margin-bottom: 12px; padding: 10px 12px; border: 1px solid color-mix(in srgb, var(--attention) 45%, var(--border)); border-radius: 6px; background: var(--attention-muted); color: var(--attention); }
.exclusion-flow { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); border: 1px solid var(--border); border-radius: 6px; background: var(--canvas); }
.exclusion-flow > div { padding: 14px; }
.exclusion-flow > div + div { border-left: 1px solid var(--border); }
.exclusion-flow span, .exclusion-flow small { display: block; color: var(--muted); }
.exclusion-flow strong { font-size: 1.25rem; font-variant-numeric: tabular-nums; }
.exclusion-flow ul { grid-column: 1 / -1; margin: 0; padding: 10px 14px; border-top: 1px solid var(--border); list-style: none; }
.exclusion-flow li { display: flex; justify-content: space-between; gap: 12px; padding: 3px 0; }
.exclusion-flow li strong { font-size: inherit; }
.run-evidence-table { min-width: 900px; }
.evidence-menu { position: relative; }
.evidence-menu summary { color: var(--accent); cursor: pointer; white-space: nowrap; }
.evidence-menu ul { min-width: 170px; display: grid; gap: 5px; position: absolute; z-index: 2; right: 0; margin: 4px 0 0; padding: 10px 12px; border: 1px solid var(--border); border-radius: 6px; background: var(--canvas); box-shadow: 0 8px 24px color-mix(in srgb, var(--canvas-inset) 45%, transparent); list-style: none; }
.experiment-empty { display: grid; justify-items: center; gap: 6px; padding: 40px 20px; border: 1px dashed var(--border); border-radius: 6px; color: var(--muted); text-align: center; }
.experiment-empty strong { color: var(--fg); font-size: 1rem; }
.experiment-empty p { margin: 0; }
.sr-only { width: 1px; height: 1px; position: absolute; overflow: hidden; margin: -1px; padding: 0; clip: rect(0 0 0 0); white-space: nowrap; }
@keyframes dashboard-skeleton-pulse {
  from { background-position: 200% 0; }
  to { background-position: -200% 0; }
}
@media (min-width: 701px) and (max-width: 900px) {
  .pie-chart-card { grid-template-columns: 1fr; }
  .pie-chart-layout { grid-column: 1; grid-row: auto; }
  .pie-chart-card > .view-source, .pie-chart-card > .view-metadata, .pie-chart-card > .view-context { grid-column: 1; }
}
@media (max-width: 700px) {
  .timeline-chart-axis span:not(:first-child):not(:last-child):nth-child(even) { display: none; }
  :is(.mode-badge, .mode-indicator) .octicon { display: none; }
  .app-shell { display: block; }
  .org-sidebar { display: block; padding: 14px 12px 10px; border-right: 0; border-bottom: 1px solid var(--border); }
  .dashboard-copilot-enabled .org-sidebar { height: auto; position: static; overflow: visible; }
  .dashboard-copilot-enabled .primary-nav { overflow: visible; }
  .sidebar-header { margin: 0 0 8px; }
  .sidebar-brand { font-size: 1rem; }
  .sidebar-toggle { display: none; }
  .sidebar-collapsed .org-sidebar { padding: 14px 12px 10px; }
  .sidebar-collapsed .sidebar-brand > span, .sidebar-collapsed .nav-label { display: initial; }
  .dashboard-copilot-prompt { margin-top: 12px; }
  .primary-nav { width: 100%; flex-direction: row; gap: 4px; }
  .nav-section { display: flex; flex: 0 0 auto; flex-direction: row; }
  .nav-section-toggle { display: none; }
  .nav-section-items, .nav-section:not([open]) > .nav-section-items { display: flex; flex-direction: row; gap: 4px; }
  .primary-nav .nav-item, .sidebar-collapsed .primary-nav .nav-item { width: 44px; min-height: 44px; flex: 0 0 44px; justify-content: center; gap: 0; padding: 0; }
  .primary-nav .nav-item.mobile-nav-overflow { display: none; }
  .primary-nav .nav-item .nav-label { display: none; }
  .primary-nav a[aria-current="page"]::before { content: none; }
  .mobile-nav-menu { display: block; position: relative; margin-left: auto; }
  .mobile-nav-menu > summary { width: 44px; height: 44px; display: grid; place-items: center; border-radius: 6px; color: var(--fg); cursor: pointer; list-style: none; }
  .mobile-nav-menu > summary::-webkit-details-marker { display: none; }
  .mobile-nav-menu > summary:hover, .mobile-nav-menu[open] > summary { background: var(--neutral-muted); }
  .mobile-nav-menu-list { width: min(280px, calc(100vw - 24px)); max-height: min(520px, calc(100vh - 140px)); display: flex; flex-direction: column; gap: 2px; overflow-y: auto; position: absolute; z-index: 30; top: calc(100% + 4px); right: 0; padding: 8px; border: 1px solid var(--border); border-radius: 6px; background: var(--canvas); box-shadow: 0 8px 24px color-mix(in srgb, var(--canvas-inset) 45%, transparent); }
  .mobile-nav-menu-list a { width: 100%; min-height: 40px; flex: none; justify-content: flex-start; gap: 10px; padding: 8px; }
  .mobile-nav-menu-list a[aria-current="page"] { background: var(--neutral-muted); }
  .mobile-nav-section-label { margin: 8px 8px 2px; color: var(--muted); font-size: .6875rem; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
  .mobile-nav-section-label:first-child { margin-top: 2px; }
  .app-main > nav .shell { flex-wrap: wrap; padding-inline: 14px; }
  .site-callouts { padding-inline: 14px; }
  .breadcrumb .shell > :is([data-breadcrumb-root], [data-breadcrumb-dashboard]) { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .report-actions { width: 100%; position: relative; margin-left: 0; }
  .horizon-data-status .status { min-height: 0; padding: 0; border: 0; background: transparent; }
  .report-actions .tooltip-help { position: static; }
  .report-actions .tooltip-content { width: min(320px, 100%); right: auto; left: 0; }
  .refresh-button > span { display: none; }
  .overview-header { min-height: 0; padding: 24px 0 20px; flex-direction: column; gap: 12px; }
  .toolbar { align-items: stretch; flex-wrap: wrap; }
  .filter-control { min-width: 0; flex-basis: 100%; }
  .filter-toggle[aria-expanded="true"] { background: var(--neutral-muted); }
  .scope-period { min-height: 44px; }
  .scope-period { flex: 1; justify-content: center; }
  .report-actions > .filter-bar { position: static; }
  .filter-bar-expanded .filter-tuning-controls { width: calc(100vw - 28px); display: grid; grid-template-columns: minmax(0, 1fr); right: 0; }
  .filter-bar-expanded .time-window-control { display: grid; flex: 1 1 100%; grid-template-columns: minmax(0, 1fr); min-width: 0; }
  .time-window-control label { min-height: 44px; }
  .mode-filter-control { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .time-window-control :is(select, input) { width: 100%; }
  .mode-filter-control input { width: auto; }
  .time-window-control > button { min-height: 44px; }
  main.dashboard-prototype { padding: 0 14px 28px; }
  .data-state-summary, .metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .layout-section[data-section-layout="wide"], .layout-section[data-section-layout="narrow"] { grid-column: span 12; }
  .custom-view[data-view-layout="half"], .custom-view[data-view-layout="third"] { grid-column: span 12; }
  .workflow-runtime-metrics { grid-template-columns: 1fr; }
  .workflow-identity { align-items: flex-start; flex-direction: column; gap: 10px; }
  .value-chart > dl { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .context-summary { grid-template-columns: 1fr; }
  .context-summary > div { border-top: 1px solid var(--border); border-left: 0; }
  .context-summary > div:first-child { border-top: 0; }
  .repository-health .section-heading { align-items: flex-start; flex-direction: column; }
  .outcome-view { grid-template-columns: 1fr; }
  .outcome-meta { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 20px; }
  .pie-chart-card { grid-template-columns: 1fr; }
  .pie-chart-layout { grid-column: 1; grid-row: auto; }
  .pie-chart-card > .view-source, .pie-chart-card > .view-metadata, .pie-chart-card > .view-context { grid-column: 1; }
  .control-plane-status > header { min-height: 0; padding: 14px; }
  .control-plane-heading { align-items: flex-start; }
  .control-plane-heading .scope-kicker { display: none; }
  .control-plane-heading p { font-size: .75rem; }
  .control-plane-vitals { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .summary-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .readiness-verdict-primary { display: grid; gap: 16px; padding: 18px 16px; }
  .readiness-verdict-summary { justify-items: start; text-align: left; }
  .readiness-verdict-details { grid-template-columns: 1fr; }
  .readiness-block { padding: 16px; }
  .readiness-block + .readiness-block { border-top: 1px solid var(--border); border-left: 0; }
  .readiness-snapshot-meta { gap: 8px 16px; }
  .dashboard-callout { grid-template-columns: 1fr; gap: 10px; }
  .signal-item > :is(a, div) { grid-template-columns: 20px minmax(0, 1fr); }
  .signal-rank { display: none; }
  .signal-copy { grid-column: 2; }
  .signal-evidence { grid-column: 2; justify-items: start; text-align: left; }
  .control-plane-vitals > div { padding: 10px 12px; }
  .control-plane-vitals p { min-height: 0; }
  .execution-health-heading { align-items: flex-start; flex-direction: column; gap: 2px; }
  .execution-legend { display: none; }
  .managed-package-card dl { gap: 8px; }
  .package-utilization-grid { grid-template-columns: 1fr; }
  .package-trend-panel > header { align-items: flex-start; flex-direction: column; }
  .overview-observability > .section-heading { align-items: flex-start; flex-direction: column; }
  .attention-domain-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .package-status-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .dashboard-loading-skeleton, .dashboard-view-skeleton { grid-template-columns: 1fr; }
  .skeleton-panel { grid-column: auto; }
  .workflow-attention > .section-heading, .anomaly-readiness { align-items: flex-start; flex-direction: column; }
  .anomaly-readiness { gap: 4px; }
  .anomaly-readiness p { text-align: left; }
  .workflow-attention-list a, .workflow-attention-static { grid-template-columns: 20px minmax(0, 1fr); }
  .signal-rank, .signal-evidence { display: none; }
  .dashboard-next-home-page .canonical-attention-item > :is(a, div) { grid-template-columns: 44px minmax(0, 1fr); }
  .dashboard-next-home-page .canonical-attention-item .signal-priority-rank { display: grid; grid-column: 1; grid-row: 1 / span 2; }
  .dashboard-next-home-page .canonical-attention-item .signal-icon { display: none; }
  .dashboard-next-home-page .canonical-attention-item .signal-copy > :is(strong, small) { overflow: visible; text-overflow: clip; white-space: normal; }
  .dashboard-next-home-page .canonical-attention-item .signal-evidence { display: grid; grid-column: 2; justify-items: start; text-align: left; }
  .workflow-identity { align-items: flex-start; flex-direction: column; }
  .experiment-filters { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .experiment-overview { grid-template-columns: 1fr; }
  .experiment-summary { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .experiment-summary > div + div { border-left: 0; }
  .experiment-summary > div:nth-child(even) { border-left: 1px solid var(--border); }
  .experiment-summary > div:nth-child(n + 3) { border-top: 1px solid var(--border); }
  .experiment-decision-table :is(th, td):nth-child(2),
  .experiment-decision-table :is(th, td):nth-child(3),
  .experiment-decision-table :is(th, td):nth-child(4),
  .experiment-decision-table :is(th, td):nth-child(5),
  .experiment-decision-table :is(th, td):nth-child(6),
  .experiment-decision-table :is(th, td):nth-child(7),
  .experiment-decision-table :is(th, td):nth-child(11) { display: none; }
  .experiment-decision-table { min-width: 640px; }
  .grader-ranking li { grid-template-columns: 20px minmax(150px, 1fr) auto; }
  .grader-ranking li > :nth-child(4), .grader-ranking li > :nth-child(5) { display: none; }
  .exclusion-flow { grid-template-columns: 1fr; }
  .exclusion-flow > div + div { border-top: 1px solid var(--border); border-left: 0; }
}
@media (max-width: 420px) {
  .primary-nav .nav-item.narrow-mobile-nav-overflow { display: none; }
  .report-actions .repository-link { display: none; }
  .data-state-summary, .metrics { grid-template-columns: 1fr; }
  .workflow-run-health > .chart-legend, .value-chart > dl { grid-template-columns: 1fr; }
  .summary-grid { grid-template-columns: 1fr; }
  .readiness-verdict-details { grid-template-columns: 1fr; }
  .readiness-verdict-details > div + div { border-top: 1px solid var(--border); border-left: 0; }
  .pie-chart-layout { grid-template-columns: 1fr; }
  .attention-domain-grid { grid-template-columns: minmax(0, 1fr); }
  .attention-domain-card { min-height: 164px; }
  .package-status-grid { grid-template-columns: minmax(0, 1fr); }
  .outcome-meta { grid-template-columns: 1fr; }
  .configuration-entry-heading { align-items: flex-start; flex-direction: column; gap: 2px; }
  .configuration-entry-value { flex: initial; }
  .configuration-entry-children { margin-left: 8px; }
  .experiment-filters { grid-template-columns: 1fr; }
  .experiment-readiness-chart { grid-template-columns: 88px minmax(0, 1fr); }
  .experiment-readiness-donut { width: 84px; height: 84px; }
  .experiment-readiness-donut::after { width: 52px; height: 52px; }
  .experiment-summary { grid-template-columns: 1fr; }
  .experiment-summary > div:nth-child(even) { border-left: 0; }
  .experiment-summary > div + div { border-top: 1px solid var(--border); }
  .eval-bar-row { grid-template-columns: 1fr; }
  .markdown-body { padding: 20px 16px 24px; }
}
@media (max-width: 340px) {
  .primary-nav, .nav-section-items { gap: 2px; }
}
@media (max-width: 350px) {
  .report-actions { flex-wrap: wrap; }
  .dashboard-horizon { max-width: 100%; gap: 2px; padding-right: 4px; }
  .horizon-data-status { gap: 6px; padding-inline: 2px; font-size: .6875rem; }
}
@media (prefers-reduced-motion: reduce) {
  html { scroll-behavior: auto; }
  *, *::before, *::after { scroll-behavior: auto !important; transition-duration: 0.01ms !important; }
  ::view-transition-old(root), ::view-transition-new(root) { animation: none; }
  .dashboard-loading-skeleton > div, .dashboard-view-skeleton > div, .dashboard-horizon-skeleton > span, .table-summary-skeleton span { animation: none; }
}
@media (prefers-contrast: more) {
  :root {
    --border: var(--fg);
    --border-muted: var(--muted);
  }
  a:focus-visible, [tabindex]:focus-visible { outline-width: 3px; }
}
@media (forced-colors: active) {
  :root {
    --canvas: Canvas;
    --canvas-subtle: Canvas;
    --canvas-inset: Canvas;
    --header: Canvas;
    --fg: CanvasText;
    --muted: CanvasText;
    --border: ButtonBorder;
    --border-muted: ButtonBorder;
    --accent: LinkText;
    --accent-muted: Canvas;
    --success: CanvasText;
    --success-muted: Canvas;
    --danger: CanvasText;
    --cancelled: CanvasText;
    --attention: CanvasText;
    --attention-muted: Canvas;
    --neutral-muted: Canvas;
    --focus: Highlight;
  }
}
@media print {
  .org-sidebar, .app-main > nav, .skip-link { display: none; }
  .app-shell { display: block; }
  main.dashboard-prototype { width: 100%; padding: 0; }
  a { color: inherit; text-decoration: underline; }
}`;
}

export const getPrimerStyles = primerStylesheet;
