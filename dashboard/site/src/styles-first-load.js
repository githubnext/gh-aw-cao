export const firstLoadStyles = `
.factory-intro-importing { grid-template-columns: minmax(0, 1fr); background: linear-gradient(115deg, var(--accent-muted), var(--canvas)); }
.factory-intro-copy > p { max-width: 640px; color: var(--muted); line-height: 1.6; }
.first-load-overlay { position: fixed; inset: 0; box-sizing: border-box; width: 100%; max-width: none; height: 100%; height: 100dvh; max-height: none; margin: 0; padding: 32px 20px; border: 0; overflow-y: auto; background: radial-gradient(ellipse at top, var(--accent-muted), var(--canvas) 70%); color: var(--fg); font-family: var(--font-sans); }
.first-load-overlay[open] { display: grid; align-items: center; }
.first-load-overlay::backdrop { background: var(--canvas); }
.first-load-background { position: fixed; inset: 0; overflow: hidden; pointer-events: none; }
.first-load-background::before { content: ""; position: absolute; inset: -32px; background-image: linear-gradient(color-mix(in srgb, var(--border) 50%, transparent) 1px, transparent 1px), linear-gradient(90deg, color-mix(in srgb, var(--border) 50%, transparent) 1px, transparent 1px); background-size: 32px 32px; mask-image: radial-gradient(ellipse at center, transparent 20%, black 80%); animation: first-load-grid-drift 24s ease-in-out infinite; }
.first-load-background-graph { position: absolute; inset: auto 5vw 8vh; height: min(55vh, 420px); display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: clamp(12px, 3vw, 48px); animation: first-load-graph-drift 28s ease-in-out infinite; }
.first-load-background-bar { position: relative; --bar-height: 48%; --baseline-height: 65%; }
.first-load-background-bar::before, .first-load-background-bar::after { content: ""; position: absolute; bottom: 0; width: 42%; border-radius: 6px 6px 0 0; }
.first-load-background-bar::before { left: 0; height: var(--baseline-height); border: 1px solid var(--border); background: var(--neutral-muted); }
.first-load-background-bar::after { right: 0; height: var(--bar-height); background: linear-gradient(to top, var(--accent-muted), var(--success)); }
.first-load-background-bar:nth-child(2) { --bar-height: 72%; --baseline-height: 48%; }
.first-load-background-bar:nth-child(3) { --bar-height: 58%; --baseline-height: 82%; }
.first-load-background-bar:nth-child(4) { --bar-height: 88%; --baseline-height: 62%; }
.first-load-background-bar:nth-child(5) { --bar-height: 68%; --baseline-height: 44%; }
.first-load-background-bar:nth-child(6) { --bar-height: 42%; --baseline-height: 68%; }
.first-load-background-bar:nth-child(7) { --bar-height: 76%; --baseline-height: 54%; }
@keyframes first-load-grid-drift { 0%, 100% { transform: translate3d(0, 0, 0); opacity: .45; } 50% { transform: translate3d(16px, 16px, 0); opacity: .65; } }
@keyframes first-load-graph-drift { 0%, 100% { transform: translate3d(0, 8px, 0); opacity: .16; } 50% { transform: translate3d(0, -8px, 0); opacity: .24; } }
.first-load-card { position: relative; z-index: 1; box-sizing: border-box; width: min(100%, 640px); margin: auto; padding: 40px; border: 1px solid var(--border-muted); border-radius: 12px; background: var(--canvas); box-shadow: 0 16px 48px color-mix(in srgb, var(--canvas-inset) 30%, transparent); }
.first-load-compact-copy { display: none; }
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
  .first-load-overlay { padding: 12px; }
  .first-load-card { padding: 20px; }
  .first-load-wide-copy, .first-load-steps, .first-load-eyebrow { display: none; }
  .first-load-compact-copy { display: inline; }
  .first-load-symbol { width: 40px; height: 40px; border-radius: 12px; }
  .first-load-symbol .octicon { width: 20px; height: 20px; }
  .first-load-card h2 { margin-top: 16px; font-size: 1.5rem; }
  .first-load-description { margin: 12px 0 16px; font-size: .875rem; line-height: 1.5; }
  .first-load-message { margin-top: 12px; font-size: .8125rem; }
  .first-load-status { margin: 8px 0 16px; font-size: .75rem; }
  .first-load-browse { width: 100%; }
  .first-load-note { margin-bottom: 0; }
}
@media (prefers-reduced-motion: reduce) {
  .first-load-background::before, .first-load-background-graph { animation: none; }
  .first-load-background::before { opacity: .5; }
  .first-load-background-graph { opacity: .2; }
}
`;
