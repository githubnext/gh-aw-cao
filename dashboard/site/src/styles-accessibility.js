export const accessibilityStyles = `@media (prefers-reduced-motion: reduce) {
  html { scroll-behavior: auto; }
  *, *::before, *::after { scroll-behavior: auto !important; transition-duration: 0.01ms !important; }
  ::view-transition-old(root), ::view-transition-new(root) { animation: none; }
  .dashboard-lazy-view-skeleton > span, .dashboard-view-skeleton-block, .dashboard-horizon-skeleton > span, .table-summary-skeleton span, .home-catchup-mobile-card, .factory-heading-pending, .factory-rhythm-pending .factory-rhythm-bars { animation: none; }
  .dashboard-view-skeleton-block { opacity: 1; }
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
  .org-sidebar, .app-main > .top-nav, .skip-link { display: none; }
  .dashboard-root, .app-shell, .app-main { height: auto; overflow: visible; }
  .app-shell { display: block; }
  main.dashboard-prototype { width: 100%; overflow: visible; padding: 0; }
  a { color: inherit; text-decoration: underline; }
}
`;
