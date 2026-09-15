/**
 * Loads source collections one at a time when a split-source manifest is
 * available, keeping peak JSON parsing memory independent of the full payload.
 * @param {typeof fetch} fetchSource
 * @param {string} sourcesUrl
 * @param {{ onShardLoaded?: (shard: { name: string, sizeBytes: number | null, cacheStatus: string | null }) => void }} [options]
 * @returns {Promise<Record<string, unknown>>}
 */
export async function loadDashboardSources(fetchSource, sourcesUrl, options = {}) {
  const manifestUrl = new URL('./sources/manifest.json', sourcesUrl);
  const manifestResponse = await fetchSource(manifestUrl, { cache: 'no-store' });
  if (!manifestResponse.ok) {
    if (manifestResponse.status !== 404) {
      throw new Error(`Unable to load dashboard source manifest: ${manifestResponse.status}`);
    }
    const response = await fetchSource(sourcesUrl, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Unable to load sources.json: ${response.status}`);
    return response.json();
  }

  const manifest = /** @type {{ version?: unknown, generation?: unknown, sources?: unknown }} */ (await manifestResponse.json());
  if (!manifest || manifest.version !== 1 || !Array.isArray(manifest.sources)
      || manifest.sources.some((/** @type {unknown} */ name) => typeof name !== 'string' || !/^[a-z0-9-]+$/.test(name))
      || (manifest.generation !== undefined && (typeof manifest.generation !== 'string' || !/^[a-f0-9]{64}$/.test(manifest.generation)))) {
    throw new Error('Dashboard source manifest is invalid.');
  }

  /** @type {Record<string, unknown>} */
  const sources = {};
  for (const name of manifest.sources) {
    const response = await fetchSource(new URL(`${name}.json`, manifestUrl), { cache: 'no-store' });
    if (!response.ok) throw new Error(`Unable to load dashboard source ${name}: ${response.status}`);
    const contentLength = response.headers.get('content-length');
    const sizeBytes = contentLength !== null && /^\d+$/.test(contentLength)
      ? Number(contentLength)
      : null;
    const cacheStatus = ['cache-status', 'cf-cache-status', 'x-cache']
      .map((header) => response.headers.get(header)?.trim())
      .find(Boolean) ?? null;
    options.onShardLoaded?.({ name, sizeBytes, cacheStatus });
    const source = await response.json();
    if (manifest.generation && source?.metadata?.['artifact-generation'] !== manifest.generation) {
      throw new Error(`Dashboard source ${name} does not match the source manifest generation.`);
    }
    sources[name] = source;
  }
  return sources;
}