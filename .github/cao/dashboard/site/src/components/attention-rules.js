/**
 * Renders overview "attention" callouts from data-driven rules instead of
 * hardcoded per-item strings, so new attention conditions can be added by
 * editing attention-rules.json rather than editing rendering logic.
 */

import attentionRules from './attention-rules.json' with { type: 'json' };

/**
 * @typedef {{ icon: string, tone: string, title: string, detail: string }} AttentionItem
 */

/**
 * @param {Record<string, Record<string, unknown> | undefined>} metricsByRule Metric values keyed by
 *   each rule's `metric` id (see attention-rules.json). Each value must include a `count` used to
 *   decide whether the rule fires, plus any other named values referenced by its templates.
 * @returns {AttentionItem[]}
 */
export function buildAttentionItems(metricsByRule) {
  return attentionRules
    .map((rule) => ({ rule, values: metricsByRule[rule.metric] }))
    .filter(({ values }) => values != null && Number(values.count) > 0)
    .map(({ rule, values }) => ({
      icon: rule.icon,
      tone: rule.tone,
      title: renderAttentionTemplate(rule.title, /** @type {Record<string, unknown>} */ (values)),
      detail: renderAttentionTemplate(rule.detail, /** @type {Record<string, unknown>} */ (values))
    }));
}

/**
 * Expands `{{key}}` and `{{key:suffix:singular:plural}}` placeholders against `values`.
 * The suffix form resolves to `singular` when `values[key]` is exactly `1`, otherwise `plural`.
 * @param {string} template
 * @param {Record<string, unknown>} values
 * @returns {string}
 */
function renderAttentionTemplate(template, values) {
  return template.replace(/\{\{([a-zA-Z-]+)(?::suffix:([^:{}]*):([^:{}]*))?\}\}/g, (match, key, singular, plural) => {
    if (singular !== undefined) {
      return Number(values[key]) === 1 ? singular : plural;
    }
    return values[key] != null ? String(values[key]) : '';
  });
}
