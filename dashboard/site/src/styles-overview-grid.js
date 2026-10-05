export const overviewGridStyles = `
.factory-floor::before, .first-load-background::before { content: ""; width: round(down, 100%, 32px); height: round(down, 100%, 32px); position: absolute; top: 50%; left: 50%; border-right: 1px solid color-mix(in srgb, var(--border) 50%, transparent); border-bottom: 1px solid color-mix(in srgb, var(--border) 50%, transparent); background-image: linear-gradient(color-mix(in srgb, var(--border) 50%, transparent) 1px, transparent 1px), linear-gradient(90deg, color-mix(in srgb, var(--border) 50%, transparent) 1px, transparent 1px); background-size: 32px 32px; transform: translate(-50%, -50%); }
.custom-view-grid:has(> .factory-intro:first-child + .factory-floor) { --factory-grid-line: color-mix(in srgb, var(--border) 50%, transparent); --factory-grid-glow: transparent; position: relative; isolation: isolate; gap: 0; padding: 0; }
/* One background spans the two summary rows, stopping before the campaign list. */
.custom-view-grid:has(> .factory-intro:first-child + .factory-floor)::before { content: ""; position: absolute; grid-row: 1 / 3; grid-column: 1 / -1; inset: 0; z-index: 0; pointer-events: none; background-color: var(--canvas-subtle); background-image: linear-gradient(var(--factory-grid-line) 1px, transparent 1px), linear-gradient(90deg, var(--factory-grid-line) 1px, transparent 1px), radial-gradient(ellipse at center, var(--factory-grid-glow), transparent 72%); background-size: 32px 32px, 32px 32px, 100% 100%; }
.custom-view-grid:has(> .factory-intro:first-child + .factory-floor) > .factory-intro { position: relative; z-index: 1; padding: 48px 32px 32px; }
.custom-view-grid:has(> .factory-intro:first-child + .factory-floor) > .factory-floor { z-index: 1; min-height: 0; padding: 0 32px 32px; border-radius: 0; background: transparent; }
.custom-view-grid:has(> .factory-intro:first-child + .factory-floor) > .factory-floor::before { content: none; }
.custom-view-grid:has(> .factory-intro:first-child + .factory-floor) > .link-button-list-view { position: relative; padding: 32px; }
.custom-view-grid:has(> .factory-intro:first-child + .factory-floor-active) { --factory-grid-line: color-mix(in srgb, var(--success) 22%, transparent); --factory-grid-glow: color-mix(in srgb, var(--success) 10%, transparent); }
.dashboard-root[data-theme="light"] .custom-view-grid:has(> .factory-intro:first-child + .factory-floor-active) { --factory-grid-line: color-mix(in srgb, var(--success) 34%, transparent); --factory-grid-glow: color-mix(in srgb, var(--success) 18%, transparent); }
@media (prefers-color-scheme: light) {
  .dashboard-root:not([data-theme]) .custom-view-grid:has(> .factory-intro:first-child + .factory-floor-active) { --factory-grid-line: color-mix(in srgb, var(--success) 34%, transparent); --factory-grid-glow: color-mix(in srgb, var(--success) 18%, transparent); }
}
@media (max-width: 700px) {
  .custom-view-grid:has(> .factory-intro:first-child + .factory-floor) > .factory-intro { padding: 28px 16px 24px; }
  .custom-view-grid:has(> .factory-intro:first-child + .factory-floor) > .factory-floor { padding: 0 16px 24px; }
  .custom-view-grid:has(> .factory-intro:first-child + .factory-floor) > .link-button-list-view { padding: 24px 16px; }
}
`;
