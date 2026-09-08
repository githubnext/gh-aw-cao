/**
 * Loads source collections one at a time when a split-source manifest is
 * available, keeping peak JSON parsing memory independent of the full payload.
 * @param {typeof fetch} fetchSource
 * @param {string} sourcesUrl
 * @returns {Promise<Record<string, unknown>>}
 */
export async function loadDashboardSources(fetchSource, sourcesUrl) {
  const manifestUrl = new URL('./sources/manifest.json', sourcesUrl);
  const manifestResponse = await fetchSource(manifestUrl);
  if (!manifestResponse.ok) {
    if (manifestResponse.status !== 404) {
      throw new Error(`Unable to load dashboard source manifest: ${manifestResponse.status}`);
    }
    const response = await fetchSource(sourcesUrl);
    if (!response.ok) throw new Error(`Unable to load sources.json: ${response.status}`);
    return response.json();
  }

  const manifest = /** @type {{ version?: unknown, sources?: unknown }} */ (await manifestResponse.json());
  if (!manifest || manifest.version !== 1 || !Array.isArray(manifest.sources)
      || manifest.sources.some((/** @type {unknown} */ name) => typeof name !== 'string' || !/^[a-z0-9-]+$/.test(name))) {
    throw new Error('Dashboard source manifest is invalid.');
  }

  /** @type {Record<string, unknown>} */
  const sources = {};
  for (const name of manifest.sources) {
    const response = await fetchSource(new URL(`${name}.json`, manifestUrl));
    if (!response.ok) throw new Error(`Unable to load dashboard source ${name}: ${response.status}`);
    sources[name] = await response.json();
  }
  return sources;
}