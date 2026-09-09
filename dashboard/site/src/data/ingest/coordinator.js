import { processCanonicalDashboardSources } from '../../data-processor.js';
import { dashboardSourceGeneration } from '../adapters/dashboard-sources.js';
import { adaptGhAwLogs } from '../adapters/gh-aw-logs.js';
import { adaptSqlExport } from '../adapters/sql-export.js';
import { normalize } from '../normalize/index.js';
import { activateGeneration, activeGenerationIsUsable, stageCanonicalBatch } from '../storage/indexeddb.js';
import {
  inspectStorage,
  reclaimExpendableGenerations,
  requestPersistentStorage,
  withQuotaRecovery
} from '../storage/quota.js';
import { CanonicalIngestionError, classifyIngestionError } from './errors.js';

/**
 * @param {IDBFactory} indexedDB
 * @param {string} generation
 * @param {() => import('../model/schema.js').CanonicalBatch | Promise<import('../model/schema.js').CanonicalBatch>} buildBatch
 * @param {{ storage?: StorageManager }} options
 */
async function ingestReplacementGeneration(indexedDB, generation, buildBatch, options) {
  if (options.storage) {
    await Promise.allSettled([
      inspectStorage(options.storage),
      requestPersistentStorage(options.storage)
    ]);
  }
  if (await activeGenerationIsUsable(indexedDB, generation)) {
    return { generation, activated: false };
  }
  const batch = await buildBatch();
  await withQuotaRecovery(
    () => stageCanonicalBatch(indexedDB, batch, generation),
    () => reclaimExpendableGenerations(indexedDB)
  );
  await activateGeneration(indexedDB, generation);
  return { generation, activated: true };
}

/**
 * Builds a replacement canonical generation from the current published source
 * document for the authoritative query-backed renderer.
 *
 * @param {IDBFactory} indexedDB
 * @param {Record<string, unknown>} sources
 * @param {{ storage?: StorageManager }} [options]
 */
export async function ingestDashboardSources(indexedDB, sources, options = {}) {
  let phase = 'adapting';
  /** @type {string | null} */
  let generation = null;
  try {
    generation = dashboardSourceGeneration(sources);
    const targetGeneration = generation;
    phase = 'normalizing';
    phase = 'staging';
    const result = await ingestReplacementGeneration(
      indexedDB,
      targetGeneration,
      () => processCanonicalDashboardSources(sources, targetGeneration),
      options
    );
    phase = 'activating';
    return result;
  } catch (error) {
    if (error instanceof CanonicalIngestionError) throw error;
    throw new CanonicalIngestionError(classifyIngestionError(error, phase), phase, generation, error);
  }
}

/**
 * Replaces the active canonical generation with one complete SQL export. The
 * database producer publishes static JSON before the dashboard loads it.
 *
 * @param {IDBFactory} indexedDB
 * @param {unknown} input
 * @param {{ storage?: StorageManager }} [options]
 */
export async function ingestSqlExportGeneration(indexedDB, input, options = {}) {
  let phase = 'adapting';
  /** @type {string | null} */
  let generation = null;
  try {
    const adapted = adaptSqlExport(input);
    generation = adapted.generation;
    const targetGeneration = generation;
    phase = 'normalizing';
    const batch = normalize(adapted.observations, { generation: targetGeneration });
    phase = 'staging';
    const result = await ingestReplacementGeneration(indexedDB, targetGeneration, () => batch, options);
    phase = 'activating';
    return result;
  } catch (error) {
    if (error instanceof CanonicalIngestionError) throw error;
    throw new CanonicalIngestionError(classifyIngestionError(error, phase), phase, generation, error);
  }
}

/**
 * Replaces the active canonical generation with one complete gh-aw artifact
 * input assembled by the offline producer.
 *
 * @param {IDBFactory} indexedDB
 * @param {unknown} input
 * @param {{ storage?: StorageManager }} [options]
 */
export async function ingestGhAwLogsGeneration(indexedDB, input, options = {}) {
  let phase = 'adapting';
  /** @type {string | null} */
  let generation = null;
  try {
    const adapted = adaptGhAwLogs(input);
    generation = adapted.generation;
    const targetGeneration = generation;
    phase = 'normalizing';
    const batch = normalize(adapted.observations, { generation: targetGeneration });
    phase = 'staging';
    const result = await ingestReplacementGeneration(indexedDB, targetGeneration, () => batch, options);
    phase = 'activating';
    return result;
  } catch (error) {
    if (error instanceof CanonicalIngestionError) throw error;
    throw new CanonicalIngestionError(classifyIngestionError(error, phase), phase, generation, error);
  }
}