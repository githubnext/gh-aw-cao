import { createDebug } from './debug.js';

const CONSOLE_METHODS = /** @type {const} */ (['debug', 'info', 'log', 'warn', 'error']);
const MAX_ENTRIES = 1_000;

const debugConsoleLogCapture = createDebug('console-log-capture');

/** @param {unknown} value */
function formatConsoleValue(value) {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`;
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'symbol' || typeof value === 'function' || value === undefined) return String(value);

  const seen = new WeakSet();
  try {
    return JSON.stringify(value, (_key, nestedValue) => {
      if (typeof nestedValue === 'bigint') return `${nestedValue}n`;
      if (nestedValue && typeof nestedValue === 'object') {
        if (seen.has(nestedValue)) return '[Circular]';
        seen.add(nestedValue);
      }
      return nestedValue;
    });
  } catch {
    return String(value);
  }
}

/**
 * @param {Pick<Console, 'debug' | 'info' | 'log' | 'warn' | 'error'>} output
 */
export function createConsoleLogCapture(output) {
  /** @type {string[]} */
  const entries = [];
  let started = false;
  let hasEvicted = false;

  const start = () => {
    if (started) return;
    started = true;
    for (const method of CONSOLE_METHODS) {
      const original = output[method].bind(output);
      output[method] = (...values) => {
        entries.push(`${method.toUpperCase()} ${values.map(formatConsoleValue).join(' ')}`);
        if (entries.length > MAX_ENTRIES) {
          entries.splice(0, entries.length - MAX_ENTRIES);
          // Report only the first eviction: entries overflow constantly once the
          // buffer is full, so logging every occurrence would be a hot-loop log.
          if (!hasEvicted) {
            hasEvicted = true;
            debugConsoleLogCapture({ event: 'buffer-limit-reached', maxEntries: MAX_ENTRIES });
          }
        }
        original(...values);
      };
    }
    debugConsoleLogCapture({ event: 'started', methodCount: CONSOLE_METHODS.length });
  };

  const text = () => {
    debugConsoleLogCapture({ event: 'read', entryCount: entries.length });
    return entries.length > 0 ? entries.join('\n') : 'No console entries captured.';
  };

  return { start, text };
}

const dashboardConsoleLogCapture = createConsoleLogCapture(globalThis.console);

export const startConsoleLogCapture = dashboardConsoleLogCapture.start;
export const capturedConsoleLogText = dashboardConsoleLogCapture.text;
