import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dashboardPageChunkPath, normalizeDashboardPageChunk, resolveDashboardDocument } from '../src/dashboard-chunks.js';

/**
 * @param {string} siteRoot
 */
export function readResolvedDashboard(siteRoot) {
  const core = JSON.parse(readFileSync(join(siteRoot, 'dashboard.json'), 'utf8'));
  const chunks = (core.dashboard?.pages ?? []).flatMap((/** @type {{ chunk?: string }} */ page) => {
    const chunkPath = dashboardPageChunkPath(page);
    if (!chunkPath) return [];
    return [normalizeDashboardPageChunk(JSON.parse(readFileSync(join(siteRoot, chunkPath), 'utf8')))];
  });
  return resolveDashboardDocument(core, chunks);
}

/**
 * @param {string | URL} siteUrl
 */
export async function fetchResolvedDashboard(siteUrl) {
  const origin = new URL(siteUrl);
  const core = await fetch(new URL('dashboard.json', origin)).then((response) => {
    if (!response.ok) throw new Error(`dashboard.json returned HTTP ${response.status}`);
    return response.json();
  });
  const chunks = await Promise.all((core.dashboard?.pages ?? []).flatMap((/** @type {{ chunk?: string }} */ page) => {
    const chunkPath = dashboardPageChunkPath(page);
    if (!chunkPath) return [];
    return [fetch(new URL(chunkPath, origin)).then((response) => {
      if (!response.ok) throw new Error(`${chunkPath} returned HTTP ${response.status}`);
      return response.json();
    }).then((chunk) => normalizeDashboardPageChunk(chunk))];
  }));
  return resolveDashboardDocument(core, chunks);
}
