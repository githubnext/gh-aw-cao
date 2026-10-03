export const firstLoadStyles = `
.factory-intro-importing { grid-template-columns: minmax(0, 1fr); background: linear-gradient(115deg, var(--accent-muted), var(--canvas)); }
.factory-intro-copy > p { max-width: 640px; color: var(--muted); line-height: 1.6; }
.first-load-overlay { position: fixed; inset: 0; box-sizing: border-box; width: 100%; max-width: none; height: 100%; height: 100dvh; max-height: none; margin: 0; padding: 32px 20px; border: 0; overflow-y: auto; background: radial-gradient(ellipse at top, var(--accent-muted), var(--canvas) 70%); color: var(--fg); font-family: var(--font-sans); }
.first-load-overlay[open] { display: grid; align-items: center; }
.first-load-overlay::backdrop { background: var(--canvas); }
.first-load-card { position: relative; box-sizing: border-box; width: min(100%, 640px); margin: auto; padding: 40px; border: 1px solid var(--border-muted); border-radius: 12px; background: var(--canvas); box-shadow: 0 16px 48px color-mix(in srgb, var(--canvas-inset) 30%, transparent); }
.first-load-close { position: absolute; top: 12px; right: 12px; display: grid; place-items: center; width: 44px; height: 44px; border: 0; border-radius: 6px; background: transparent; color: var(--muted); cursor: pointer; }
.first-load-symbol { display: grid; place-items: center; width: 64px; height: 64px; border: 1px solid var(--border); border-radius: 16px; background: var(--accent-muted); color: var(--accent); }
.first-load-symbol .octicon { width: 28px; height: 28px; }
.first-load-eyebrow { margin: 24px 0 8px; color: var(--accent); font-size: .8125rem; font-weight: 600; }
.first-load-card h2 { margin: 0; font-size: clamp(1.75rem, 5vw, 2.5rem); line-height: 1.15; font-weight: 600; }
.first-load-description { margin: 16px 0 24px; color: var(--muted); line-height: 1.6; }
.first-load-progress progress { display: block; width: 100%; height: 8px; accent-color: var(--accent); }
.first-load-message { min-height: 3em; margin: 16px 0 0; color: var(--accent); font-size: .875rem; line-height: 1.5; }
.first-load-status { margin: 12px 0 24px; color: var(--muted); font-size: .8125rem; line-height: 1.5; }
.first-load-steps { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 20px; margin: 0 0 24px; padding: 20px 0; border-block: 1px solid var(--border-muted); list-style: none; }
.first-load-steps strong, .first-load-steps span { display: block; font-size: .8125rem; line-height: 1.5; }
.first-load-steps span { margin-top: 6px; color: var(--muted); }
.first-load-note { margin: 12px 0; color: var(--muted); font-size: .75rem; line-height: 1.6; }
.first-load-browse, .first-load-details { min-height: 44px; padding: 8px 16px; border: 1px solid var(--border); border-radius: 6px; background: var(--canvas-subtle); color: var(--fg); font: inherit; font-size: .875rem; font-weight: 600; cursor: pointer; }
.first-load-browse { margin-top: 12px; }
.first-load-close:hover, .first-load-browse:hover, .first-load-details:hover { background: var(--accent-muted); }
.first-load-close:focus-visible, .first-load-browse:focus-visible, .first-load-details:focus-visible { outline: 2px solid var(--focus); outline-offset: 3px; }
@media (max-width: 700px) {
  .first-load-overlay { padding: 16px; }
  .first-load-card { padding: 28px 24px; }
  .first-load-steps { grid-template-columns: minmax(0, 1fr); gap: 14px; }
  .first-load-steps span { margin-top: 2px; }
  .first-load-browse { width: 100%; }
}
`;
