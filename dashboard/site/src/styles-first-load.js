export const firstLoadStyles = `
.factory-intro-importing { grid-template-columns: minmax(0, 1fr); background: linear-gradient(115deg, var(--accent-muted), var(--canvas)); }
.factory-intro-copy > p { max-width: 640px; color: var(--muted); line-height: 1.6; }
.first-load-overlay { position: fixed; inset: 0; box-sizing: border-box; width: 100%; max-width: none; height: 100%; height: 100dvh; max-height: none; margin: 0; padding: 24px 32px; border: 0; overflow-y: auto; background: var(--canvas-subtle); color: var(--fg); font-family: var(--font-sans); }
.first-load-overlay[open] { display: grid; grid-template-rows: auto 1fr; gap: 24px; align-items: center; }
.first-load-overlay [hidden] { display: none; }
.first-load-overlay::backdrop { background: var(--canvas); }
.first-load-background { position: fixed; inset: 0; overflow: hidden; pointer-events: none; }
.first-load-background::before { animation: first-load-grid-breathe 24s ease-in-out infinite; }
@keyframes first-load-grid-breathe { 0%, 100% { opacity: .65; } 50% { opacity: .85; } }
.first-load-header { position: relative; z-index: 1; }
.first-load-brand { display: flex; align-items: center; gap: 10px; color: var(--fg); font-size: 1rem; font-weight: 600; line-height: 1.5; }
.first-load-brand .sidebar-brand-mark { width: 28px; height: 28px; flex: 0 0 auto; }
.first-load-card { position: relative; z-index: 1; box-sizing: border-box; width: min(100%, 600px); margin: auto; padding: 36px; border: 1px solid var(--border-muted); border-radius: 12px; background: var(--canvas); box-shadow: 0 4px 24px color-mix(in srgb, var(--canvas-inset) 15%, transparent); }
.first-load-compact-copy { display: none; }
.first-load-eyebrow { margin: 0 0 12px; color: var(--accent); font-size: .8125rem; font-weight: 600; }
.first-load-card h2 { margin: 0; font-size: clamp(1.75rem, 5vw, 2.5rem); line-height: 1.15; font-weight: 600; }
.first-load-description { margin: 16px 0 24px; color: var(--muted); line-height: 1.6; text-wrap: pretty; }
.first-load-progress progress { display: block; width: 100%; height: 6px; accent-color: var(--accent); }
.first-load-message { display: flex; align-items: center; min-height: 3em; margin: 20px 0; padding: 12px 16px; border-radius: 6px; background: var(--canvas-subtle); color: var(--muted); font-size: .875rem; line-height: 1.5; }
.first-load-status { margin: 8px 0 0; color: var(--muted); font-size: .75rem; line-height: 1.5; }
.first-load-about { margin-top: 24px; padding-top: 12px; border-top: 1px solid var(--border-muted); }
.first-load-about summary { display: list-item; width: fit-content; padding: 8px 0; color: var(--muted); font-size: .75rem; line-height: 1.5; cursor: pointer; }
.first-load-about summary:hover { color: var(--fg); }
.first-load-about summary:focus-visible { outline: 2px solid var(--focus); outline-offset: 3px; border-radius: 3px; }
.first-load-steps { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 20px; margin: 16px 0; padding: 0; list-style: none; }
.first-load-steps strong, .first-load-steps span { display: block; font-size: .8125rem; line-height: 1.5; }
.first-load-steps span { margin-top: 6px; color: var(--muted); }
.first-load-note { margin: 12px 0; color: var(--muted); font-size: .75rem; line-height: 1.6; }
.first-load-copy-status { display: block; margin-top: 8px; color: var(--muted); font-size: .75rem; }
.first-load-server-option a { text-decoration: underline; }
.first-load-details-link { border: 0; padding: 0; background: none; color: var(--accent); font: inherit; text-decoration: underline; cursor: pointer; }
.first-load-details-link:hover { color: var(--fg); }
.first-load-details-link:focus-visible { outline: 2px solid var(--focus); outline-offset: 3px; border-radius: 3px; }
.first-load-browse, .first-load-details { min-height: 44px; padding: 8px 16px; border: 1px solid var(--border); border-radius: 6px; background: var(--canvas-subtle); color: var(--fg); font: inherit; font-size: .875rem; font-weight: 600; cursor: pointer; }
.first-load-browse { display: inline-flex; align-items: center; justify-content: center; gap: 8px; margin-top: 8px; border-color: var(--accent); background: var(--accent); color: var(--canvas); }
.first-load-browse .octicon { width: 16px; height: 16px; }
.first-load-browse:hover { filter: brightness(.95); }
.first-load-details:hover { background: var(--accent-muted); }
.first-load-browse:focus-visible, .first-load-details:focus-visible { outline: 2px solid var(--focus); outline-offset: 3px; }
@media (max-width: 700px) {
  .first-load-overlay { padding: 12px; }
  .first-load-overlay[open] { gap: 16px; }
  .first-load-brand { font-size: .875rem; }
  .first-load-brand .sidebar-brand-mark { width: 24px; height: 24px; }
  .first-load-card { padding: 20px; }
  .first-load-wide-copy, .first-load-steps { display: none; }
  .first-load-compact-copy { display: inline; }
  .first-load-eyebrow { margin-bottom: 8px; font-size: .75rem; }
  .first-load-card h2 { font-size: 1.5rem; }
  .first-load-description { margin: 12px 0 16px; font-size: .875rem; line-height: 1.5; }
  .first-load-message { margin: 16px 0; padding: 10px 12px; font-size: .8125rem; }
  .first-load-status { font-size: .75rem; }
  .first-load-about { margin-top: 16px; }
  .first-load-browse { width: 100%; }
  .first-load-note { margin-bottom: 0; }
}
@media (prefers-reduced-motion: reduce) {
  .first-load-background::before { animation: none; opacity: .75; }
}
`;
