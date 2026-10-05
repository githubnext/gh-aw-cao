export const notificationStyles = `
.dashboard-notifications { width: min(480px, calc(100vw - 32px)); display: flex; flex-direction: column; gap: 8px; position: fixed; z-index: 1001; right: 16px; bottom: 16px; pointer-events: none; }
.dashboard-notifications[hidden] { display: none; }
.dashboard-notification { display: flex; align-items: flex-start; gap: 12px; padding: 10px 12px; border: 1px solid var(--border, ButtonBorder); border-left: 3px solid var(--accent, Highlight); border-radius: 6px; background: var(--canvas, Canvas); box-shadow: 0 8px 24px color-mix(in srgb, var(--canvas-inset, CanvasText) 45%, transparent); color: var(--fg, CanvasText); font: .8125rem/1.5 var(--font-sans, -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif); pointer-events: auto; transition: transform 180ms ease-out, opacity 180ms ease-out; }
.dashboard-notification-success { border-left-color: var(--success); }
.dashboard-notification-warning { border-left-color: var(--attention); }
.dashboard-notification-error { border-left-color: var(--danger); }
.dashboard-notification-enter, .dashboard-notification-exit { transform: translateY(16px); opacity: 0; }
.dashboard-notification-content { min-width: 0; flex: 1; }
.dashboard-notification-summary { min-width: 0; display: flex; align-items: center; gap: 8px; }
.dashboard-notification-icon { width: 16px; height: 16px; flex: 0 0 16px; color: var(--muted, GrayText); }
.dashboard-notification-icon .octicon { width: 16px; height: 16px; }
.dashboard-notification-message { min-width: 0; flex: 1; overflow-wrap: anywhere; text-align: left; }
.dashboard-notification-toggle { width: 100%; display: flex; align-items: center; gap: 8px; padding: 0; border: 0; background: transparent; color: inherit; font: inherit; cursor: pointer; }
.dashboard-notification-toggle:focus-visible { outline: 2px solid var(--focus, Highlight); outline-offset: 3px; border-radius: 3px; }
.dashboard-notification-chevron { width: 7px; height: 7px; flex: 0 0 auto; border-right: 1.5px solid currentColor; border-bottom: 1.5px solid currentColor; transform: rotate(45deg); transition: transform 120ms ease; }
.dashboard-notification-toggle[aria-expanded="true"] .dashboard-notification-chevron { transform: rotate(225deg); }
.dashboard-notification-details-subtitle { margin: 10px 0 0; padding-top: 8px; border-top: 1px solid var(--border, ButtonBorder); color: var(--muted, GrayText); font-size: .75rem; line-height: 1.4; }
.dashboard-notification-details { max-height: min(320px, 45vh); margin: 10px 0 0; padding: 8px; overflow-y: auto; overscroll-behavior: contain; border-top: 1px solid var(--border, ButtonBorder); color: var(--muted, GrayText); font: .6875rem/1.5 var(--font-mono, ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace); list-style: none; }
.dashboard-notification-details li + li { margin-top: 4px; }
.dashboard-notification-actions { display: flex; flex: 0 0 auto; gap: 8px; }
.dashboard-notification-content > .dashboard-notification-actions { justify-content: flex-end; margin-top: 10px; }
.dashboard-notification-action { flex: 0 0 auto; padding: 4px 10px; border: 1px solid var(--border, ButtonBorder); border-radius: 6px; background: transparent; color: inherit; font: inherit; font-weight: 600; cursor: pointer; }
.dashboard-notification-action:hover { border-color: var(--accent, Highlight); background: var(--neutral-muted, color-mix(in srgb, CanvasText 12%, transparent)); }
.dashboard-notification-action:focus-visible { outline: 2px solid var(--focus, Highlight); outline-offset: 2px; }
@media (max-width: 700px) {
  .dashboard-notifications { right: auto; left: 50%; transform: translateX(-50%); }
}
@media (prefers-reduced-motion: reduce) {
  .dashboard-notification { transition: none; }
}`;
