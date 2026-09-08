import { h } from '../dom.js';
import { slugify } from './count-formatters.js';
import { rowsFor } from './source-rows.js';

/**
 * Renders source-backed text as safe, scrollable code regions.
 * @param {{
 *   pageId: string,
 *   viewId?: string,
 *   sourceNames: string[],
 *   sources: Record<string, import('../presenter.js').LogicalSourceInput>,
 *   elementConfig?: Record<string, unknown>
 * }} context
 * @returns {HTMLElement | null}
 */
export function renderCodeRegion(context) {
  const sourceName = context.sourceNames[0];
  const codeField = stringConfig(context.elementConfig?.['code-field']);
  if (!sourceName || !codeField) return null;

  const labelField = stringConfig(context.elementConfig?.['label-field']);
  const language = codeLanguage(context.elementConfig?.language);
  const rows = rowsFor(context.sources, sourceName);

  return h(
    'div',
    { className: 'code-region-list', 'data-code-language': language },
    ...rows.map((row, index) => {
      const label = labelField && row[labelField] != null
        ? String(row[labelField])
        : `Code preview ${index + 1}`;
      const headingId = `${context.pageId}-${slugify(context.viewId ?? 'code-region', 'code-region')}-${index}-label`;
      const content = row[codeField] == null ? '' : String(row[codeField]);
      return h(
        'article',
        { className: 'code-region' },
        h(
          'header',
          { className: 'code-region-header' },
          h('strong', { id: headingId }, label),
          h('span', { className: 'code-region-language' }, language)
        ),
        h(
          'pre',
          { className: 'code-region-pre', tabIndex: 0, 'aria-labelledby': headingId },
          h('code', { className: `language-${language}` }, content)
        )
      );
    })
  );
}

/** @param {unknown} value */
function stringConfig(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** @param {unknown} value */
function codeLanguage(value) {
  return typeof value === 'string' && /^[a-z][a-z0-9-]*$/.test(value) ? value : 'text';
}
