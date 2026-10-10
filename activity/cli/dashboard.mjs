import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { loadDashboardSource } from '../../dashboard/report/bundle-dashboards.mjs';
import { discoverInventory } from '../inventory.mjs';
import { discoverInventoryDashboardSources } from '../inventory-sources.mjs';
import { analyzeDashboardComplexity, formatDashboardComplexityMarkdown, readDashboardTableCounts } from '../dashboard-complexity.mjs';
import { pruneDashboardDocument } from '../dashboard-prune.mjs';
import { UsageError } from './options.mjs';
import { writeJsonAtomically } from './files.mjs';

export async function discoverWorkflows({
  root = ".",
  controlSettingsPath,
  inventoryPath,
  outputPath,
  repository,
  sourceInventoryPath,
} = {}) {
  const inventory = sourceInventoryPath
    ? JSON.parse(await readFile(path.resolve(sourceInventoryPath), "utf8"))
    : discoverInventory(path.resolve(root));
  if (
    !inventory ||
    typeof inventory !== "object" ||
    inventory.schemaVersion !== 1 ||
    !Array.isArray(inventory.workflows) ||
    !Array.isArray(inventory.bundles) ||
    !Array.isArray(inventory.campaigns)
  ) {
    throw new Error("source inventory is not a valid control-plane inventory");
  }
  inventory.generatedAt = new Date().toISOString();
  const controlSettings = JSON.parse(await readFile(path.resolve(controlSettingsPath), "utf8"));
  const sources = await discoverInventoryDashboardSources({
    inventory,
    controlSettings,
    repository,
  });
  await Promise.all([
    writeJsonAtomically(inventoryPath, inventory),
    writeJsonAtomically(outputPath, sources),
  ]);
  return {
    command: "discover-workflows",
    repositories: sources.repositories.rows.length,
    campaigns: sources.campaigns.rows.length,
    workflows: sources.workflows.rows.length,
  };
}

export async function pruneDashboardFile({ inputPath, outputPath } = {}) {
  let document;
  try {
    document = (await loadDashboardSource(path.resolve(inputPath))).document;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`${inputPath} contains invalid JSON: ${error.message}`);
    }
    throw error;
  }
  const result = pruneDashboardDocument(document);
  if (outputPath) await writeJsonAtomically(outputPath, result.document);
  return {
    command: 'prune-dashboard',
    input: inputPath,
    ...(outputPath ? { output: outputPath } : {}),
    ...result.report
  };
}

export async function analyzeDashboardComplexityFile({
  inputPath,
  queryId,
  format = 'json',
  limit,
  databasePath
} = {}) {
  let document;
  try {
    document = (await loadDashboardSource(path.resolve(inputPath))).document;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`${inputPath} contains invalid JSON: ${error.message}`);
    }
    throw error;
  }
  if (!['json', 'markdown'].includes(format)) {
    throw new UsageError('--format must be json or markdown');
  }
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    throw new UsageError('--limit must be a positive integer');
  }
  const tableCounts = databasePath === undefined
    ? undefined
    : readDashboardTableCounts(path.resolve(databasePath));
  const analysis = analyzeDashboardComplexity(document, { tableCounts });
  const selected = queryId === undefined
    ? undefined
    : analysis.inventory.find((query) => query.name === queryId);
  if (queryId !== undefined && !selected) {
    throw new UsageError(`Unknown dashboard query: ${queryId}`);
  }
  if (format === 'markdown') {
    return formatDashboardComplexityMarkdown(analysis, { limit, queryId });
  }
  return {
    command: 'dashboard-complexity',
    input: inputPath,
    ...(selected ? { query: selected } : analysis)
  };
}
