const day = 24 * 60 * 60 * 1000;
const isoTimestamp = /20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;

/** Keep the relative ordering of fixture events while keeping run details inside their seven-day TTL. */
/** @param {string} anchor */
export function recentFixtureDates(anchor) {
  const offset = Date.now() - day - Date.parse(anchor);
  const text = (/** @type {string} */ value) => value
    .replace(isoTimestamp, (timestamp) =>
      new Date(Date.parse(timestamp) + offset).toISOString().replace(/\.000Z$/, 'Z'))
    .replace(/"ts":(\d{10})/g, (_, seconds) =>
      `"ts":${Math.floor((Number(seconds) * 1000 + offset) / 1000)}`);
  return {
    text,
    timestamp: text,
    data: (/** @type {unknown} */ value) => JSON.parse(text(JSON.stringify(value)))
  };
}
