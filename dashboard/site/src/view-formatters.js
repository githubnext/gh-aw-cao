/**
 * Shared presentation-only formatting and aggregation helpers for custom dashboard views.
 */

/**
 * @param {Array<Record<string, unknown>>} rows
 * @param {string | null} fieldName
 * @param {string} aggregate
 * @param {(value: unknown) => string} toText
 * @param {{ name: string, symbol: string, significant: number, format?: string } | null} [unit]
 * @returns {string}
 */
export function formatAggregateValue(rows, fieldName, aggregate, toText, unit = null) {
  if (!fieldName) {
    return 'Unavailable';
  }

  if (aggregate === 'count') {
    return formatNumber(rows.filter((row) => row[fieldName] != null && row[fieldName] !== '').length, unit);
  }
  if (aggregate === 'distinct-count') {
    return formatNumber(new Set(rows.map((row) => toText(row[fieldName]))).size, unit);
  }
  if (aggregate === 'sum') {
    return formatNumber(rows.reduce((total, row) => total + toNumber(row[fieldName]), 0), unit);
  }
  if (aggregate === 'mean') {
    const numericValues = rows.map((row) => toNumber(row[fieldName])).filter((value) => Number.isFinite(value));
    return numericValues.length > 0
      ? formatNumber(numericValues.reduce((total, value) => total + value, 0) / numericValues.length, unit)
      : 'Unavailable';
  }
  if (aggregate === 'min') {
    const numericValues = rows.map((row) => toNumber(row[fieldName])).filter((value) => Number.isFinite(value));
    return numericValues.length > 0 ? formatNumber(Math.min(...numericValues), unit) : 'Unavailable';
  }
  if (aggregate === 'max') {
    const numericValues = rows.map((row) => toNumber(row[fieldName])).filter((value) => Number.isFinite(value));
    return numericValues.length > 0 ? formatNumber(Math.max(...numericValues), unit) : 'Unavailable';
  }
  const value = rows[0]?.[fieldName];
  return rows.length > 0 && unit && typeof value === 'number' && Number.isFinite(value)
    ? formatNumber(value, unit)
    : rows.length > 0 ? toText(value) : 'Unavailable';
}

/**
 * Coerces a value to its string form, substituting a fallback when the value
 * is `null`, `undefined`, or an empty string. Shared by badge and cell
 * display renderers that fall back to a placeholder label such as
 * `'unknown'` or `'unavailable'`.
 * @param {unknown} value
 * @param {string} fallback
 * @returns {string}
 */
export function stringOrFallback(value, fallback) {
  return value == null || value === '' ? fallback : String(value);
}

/**
 * Applies a declarative presentation-only format to a string value.
 * @param {unknown} value
 * @param {unknown} format
 * @param {string} fallback
 * @returns {string}
 */
export function formatString(value, format, fallback = 'unknown') {
  const text = stringOrFallback(value, fallback);
  if (format !== 'workflow-relative-path' || !text.startsWith('.github/workflows/')) return text;
  const formatted = text.slice('.github/workflows/'.length);
  return formatted || fallback;
}

/**
 * Formats a millisecond duration using cascading clock units (seconds, then
 * minutes, then hours, optionally rolling over into days). Shared by
 * run-duration renderers that differ only in whether a days tier applies.
 * @param {number} duration
 * @param {{ includeDays?: boolean }} [options]
 * @returns {string}
 */
export function formatClockDuration(duration, { includeDays = true } = {}) {
  const seconds = Math.max(0, Math.round(duration / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  if (!includeDays || hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

/**
 * @param {unknown} value
 * @returns {number}
 */
export function toNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * @param {number} value
 * @param {{ name: string, symbol: string, significant: number, format?: string } | null} [unit]
 * @param {boolean} [includeUnit]
 * @returns {string}
 */
export function formatNumber(value, unit = null, includeUnit = true) {
  if (unit && Number.isFinite(unit.significant) && unit.significant > 0) {
    const quotient = value / unit.significant;
    const rounded = Math.sign(quotient) * Math.round(Math.abs(quotient)) * unit.significant;
    if (unit.format === 'duration') {
      return formatDurationSeconds(rounded);
    }
    return `${rounded.toFixed(fractionDigits(unit.significant))}${includeUnit ? ` ${unit.symbol}` : ''}`;
  }
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

/**
 * @param {number} seconds
 * @returns {string}
 */
function formatDurationSeconds(seconds) {
  const sign = seconds < 0 ? '-' : '';
  const absoluteSeconds = Math.abs(seconds);
  if (absoluteSeconds < 60) return `${sign}${absoluteSeconds}s`;
  const minutes = Math.floor(absoluteSeconds / 60);
  if (minutes < 60) return `${sign}${minutes}m ${absoluteSeconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${sign}${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${sign}${days}d ${hours % 24}h`;
}

/**
 * Formats a 0-1 ratio as a locale percentage string with one fractional digit.
 * @param {unknown} value
 * @returns {string}
 */
export function formatPercent(value) {
  const numeric = value == null || value === '' ? Number.NaN : Number(value);
  return Number.isFinite(numeric)
    ? new Intl.NumberFormat('en', { style: 'percent', maximumFractionDigits: 1 }).format(numeric)
    : 'Not observed';
}

/**
 * Formats a timestamp relative to the dashboard's deterministic evaluation time.
 * @param {unknown} value
 * @param {unknown} relativeTo
 * @returns {string}
 */
export function formatRelativeTime(value, relativeTo) {
  const valueMs = Date.parse(String(value ?? ''));
  const relativeToMs = Date.parse(String(relativeTo ?? ''));
  if (!Number.isFinite(valueMs) || !Number.isFinite(relativeToMs)) return '';

  const differenceSeconds = (valueMs - relativeToMs) / 1000;
  const absoluteSeconds = Math.abs(differenceSeconds);
  const [divisor, unit] = absoluteSeconds < 60
    ? [1, 'second']
    : absoluteSeconds < 3_600
      ? [60, 'minute']
      : absoluteSeconds < 86_400
        ? [3_600, 'hour']
        : absoluteSeconds < 604_800
          ? [86_400, 'day']
          : [604_800, 'week'];
  const amount = Math.round(differenceSeconds / divisor);
  return new Intl.RelativeTimeFormat('en', { numeric: 'always' }).format(amount, /** @type {Intl.RelativeTimeFormatUnit} */ (unit));
}

/**
 * Formats an elapsed timestamp as compact dashboard chrome.
 * @param {unknown} value
 * @param {unknown} relativeTo
 * @returns {string}
 */
export function formatCompactElapsedTime(value, relativeTo) {
  const valueMs = Date.parse(String(value ?? ''));
  const relativeToMs = relativeTo instanceof Date
    ? relativeTo.getTime()
    : typeof relativeTo === 'number'
      ? relativeTo
      : Date.parse(String(relativeTo ?? ''));
  if (!Number.isFinite(valueMs) || !Number.isFinite(relativeToMs)) return '';

  const elapsedSeconds = Math.max(0, Math.floor((relativeToMs - valueMs) / 1_000));
  const [divisor, unit] = elapsedSeconds < 60
    ? [1, 's']
    : elapsedSeconds < 3_600
      ? [60, 'm']
      : elapsedSeconds < 86_400
        ? [3_600, 'h']
        : elapsedSeconds < 604_800
          ? [86_400, 'd']
          : [604_800, 'w'];
  return `${Math.floor(elapsedSeconds / divisor)}${unit} ago`;
}

/**
 * Formats a timestamp for quick scanning while retaining stable absolute dates
 * for older observations.
 * @param {unknown} value
 * @param {number | Date} [relativeTo]
 * @returns {string}
 */
export function formatHumanFriendlyTimestamp(value, relativeTo = Date.now()) {
  const valueMs = Date.parse(String(value ?? ''));
  const relativeToMs = relativeTo instanceof Date ? relativeTo.getTime() : relativeTo;
  if (!Number.isFinite(valueMs) || !Number.isFinite(relativeToMs)) return '';

  const differenceSeconds = (valueMs - relativeToMs) / 1_000;
  const absoluteSeconds = Math.abs(differenceSeconds);
  if (absoluteSeconds < 45) return 'just now';

  const relativeFormatter = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  if (absoluteSeconds < 90) return relativeFormatter.format(Math.sign(differenceSeconds), 'minute');
  if (absoluteSeconds < 45 * 60) return relativeFormatter.format(Math.round(differenceSeconds / 60), 'minute');
  if (absoluteSeconds < 90 * 60) return relativeFormatter.format(Math.sign(differenceSeconds), 'hour');
  if (absoluteSeconds < 22 * 3_600) return relativeFormatter.format(Math.round(differenceSeconds / 3_600), 'hour');
  if (absoluteSeconds < 36 * 3_600) return relativeFormatter.format(Math.sign(differenceSeconds), 'day');
  if (absoluteSeconds < 7 * 86_400) return relativeFormatter.format(Math.round(differenceSeconds / 86_400), 'day');

  const valueDate = new Date(valueMs);
  const relativeDate = new Date(relativeToMs);
  return new Intl.DateTimeFormat('en', {
    month: 'short',
    day: 'numeric',
    ...(valueDate.getUTCFullYear() === relativeDate.getUTCFullYear() ? {} : { year: 'numeric' }),
    timeZone: 'UTC'
  }).format(valueDate);
}

/**
 * @param {number} value
 * @returns {number}
 */
function fractionDigits(value) {
  const [mantissa, exponentText = '0'] = value.toString().toLowerCase().split('e');
  const fractionLength = mantissa.split('.')[1]?.length ?? 0;
  return Math.min(100, Math.max(0, fractionLength - Number(exponentText)));
}

const TEMPLATE_TOKEN_PATTERN = /\{\{([a-zA-Z0-9_-]+)(?::(suffix|word):([^:}]*):([^:}]*))?\}\}/g;

/**
 * Renders a JSON-configurable copy template against a set of named values, so that
 * pluralization and count-driven UI copy can be expressed as data instead of code.
 * Supported tokens: `{{name}}` (raw value), `{{name:suffix:singular:plural}}` (appends a
 * pluralization suffix based on whether `name` equals 1), and `{{name:word:singular:plural}}`
 * (substitutes a whole word based on the same rule).
 * @param {string} template
 * @param {Record<string, unknown>} values
 * @returns {string}
 */
export function renderTemplate(template, values) {
  return template.replace(TEMPLATE_TOKEN_PATTERN, (match, name, mode, singular, plural) => {
    const value = values[name];
    if (mode === undefined) {
      return value === undefined ? '' : String(value);
    }
    const isSingular = Number(value) === 1;
    return isSingular ? singular : plural;
  });
}

/**
 * Resolves a status label for a ratio against an ordered list of JSON-configured
 * thresholds. Each threshold declares an optional `max` (exclusive upper bound) and a
 * `status`; the last entry without a `max` acts as the fallback for higher ratios.
 * @param {number} ratio
 * @param {Array<{ max?: number, status: string }>} thresholds
 * @returns {string}
 */
export function resolveThresholdStatus(ratio, thresholds) {
  for (const threshold of thresholds) {
    if (typeof threshold.max !== 'number') {
      return threshold.status;
    }
    if (ratio < threshold.max) {
      return threshold.status;
    }
  }
  return 'unknown';
}
