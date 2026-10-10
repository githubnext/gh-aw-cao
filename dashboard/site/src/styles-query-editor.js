export const queryEditorStyles = `
.query-editor { min-width: 0; display: grid; gap: 12px; padding: 16px; }
.query-editor-form { display: grid; gap: 12px; grid-template-columns: repeat(2, minmax(0, 1fr)); }
.query-editor-field { min-width: 0; display: grid; gap: 6px; font-weight: 600; }
.query-editor-field textarea { box-sizing: border-box; width: 100%; min-height: 64px; resize: vertical; padding: 8px 12px; border: 1px solid var(--border); border-radius: 6px; background: var(--canvas); color: var(--fg); font: inherit; font-weight: 400; }
.query-editor-field textarea:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.query-editor-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; grid-column: 1 / -1; }
.query-editor-actions button { min-height: 44px; padding: 6px 12px; border: 1px solid var(--border); border-radius: 6px; color: var(--fg); background: var(--canvas-subtle); font: inherit; cursor: pointer; }
.query-editor-actions button:disabled { opacity: .6; cursor: wait; }
.query-editor-actions .button-primary { background: var(--accent); color: var(--canvas); }
.query-editor-actions .query-editor-improve { min-width: 44px; display: inline-flex; align-items: center; justify-content: center; }
.query-editor-semantic-limit { grid-column: 1 / -1; margin: 0; color: var(--muted); font-size: .8125rem; }
.query-editor-semantic-limit-invalid { color: var(--danger); }
.query-editor-errors { margin: 0; padding: 12px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; background: var(--canvas-subtle); border: 1px solid var(--danger); border-radius: 6px; }
.query-editor-preview { min-width: 0; }
.query-editor-preview > .dashboard-page { padding: 0; }
@media (max-width: 700px) {
  .query-editor { padding: 12px; }
  .query-editor-form { grid-template-columns: minmax(0, 1fr); }
}
`;
