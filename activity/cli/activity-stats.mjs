import { spawnSync } from 'node:child_process';
import { readFile, readdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULT_ACTIVITY_STATS_ARTIFACT, DEFAULT_ACTIVITY_STATS_LIMIT, DEFAULT_ACTIVITY_STATS_WORKFLOW } from '../cli-usage.mjs';
import { UsageError } from './options.mjs';
import { auditJsonlDirectory } from './jsonl.mjs';

async function fileSizeStats(filePath) {
  try {
    const info = await stat(filePath);
    return { path: filePath, exists: true, sizeBytes: info.size };
  } catch (error) {
    if (error && error.code === 'ENOENT') return { path: filePath, exists: false, sizeBytes: 0 };
    throw error;
  }
}

async function shardSizeStats(shardDirectory) {
  let names = [];
  try {
    names = (await readdir(shardDirectory)).filter((name) => name.endsWith('.jsonl')).sort();
  } catch (error) {
    if (error && error.code === 'ENOENT') return [];
    throw error;
  }
  return Promise.all(names.map(async (name) => {
    const info = await stat(path.join(shardDirectory, name));
    return { name, sizeBytes: info.size };
  }));
}

async function hashFileNames(hashesPath) {
  let content;
  try {
    content = JSON.parse(await readFile(hashesPath, 'utf8'));
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error instanceof SyntaxError)) return [];
    throw error;
  }
  if (!content || typeof content !== 'object' || Array.isArray(content)) return [];
  return Object.keys(content).sort();
}

/**
 * Downloads the `cao-activity-index` artifact for a single workflow run
 * (via `gh run download`) into a throwaway directory, times the download,
 * and reports the size of the SQLite payload, retained wildcard shard files,
 * and recorded payload hash files. Shards are audited sequentially so the
 * raw/duplicate run-observation counts are available per inspected run.
 */
async function inspectActivityRun(repo, run, artifact, execute, keep) {
  const runId = String(run.databaseId ?? run.id ?? '');
  const stats = {
    runId,
    status: run.status ?? null,
    conclusion: run.conclusion ?? null,
    createdAt: run.createdAt ?? null,
    updatedAt: run.updatedAt ?? null,
    url: run.url ?? null
  };
  if (!runId) {
    stats.error = 'Run is missing a database id';
    return stats;
  }
  const directory = await mkdtemp(path.join(tmpdir(), 'cao-activity-stats-'));
  try {
    const started = Date.now();
    const download = execute('gh', [
      'run', 'download', runId,
      '--repo', repo,
      '--name', artifact,
      '--dir', directory
    ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    stats.downloadDurationMs = Date.now() - started;
    if (download.error || download.status !== 0) {
      stats.error = (download.stderr || '').trim() || download.error?.message || 'gh run download failed';
      return stats;
    }
    stats.sqlite = await fileSizeStats(path.join(directory, 'gh-aw-logs.sqlite'));
    stats.shards = await shardSizeStats(path.join(directory, 'gh-aw-logs-shards'));
    stats.hashFiles = await hashFileNames(path.join(directory, 'payload-hashes.json'));
    if (stats.shards.length > 0) {
      const audit = await auditJsonlDirectory(path.join(directory, 'gh-aw-logs-shards'));
      stats.uniqueRuns = audit.source.uniqueRawRuns;
      stats.duplicateRunObservations = audit.source.duplicateRawRunObservations;
      stats.rawRunObservations = audit.source.rawRunObservations;
    }
    if (keep) stats.directory = directory;
    return stats;
  } finally {
    if (!keep) await rm(directory, { recursive: true, force: true });
  }
}

/**
 * Investigates the performance and health of recent `cao-activity.yml`
 * workflow runs: for each of the most recent runs, the `cao-activity-index`
 * artifact is downloaded via the `gh` CLI and inspected for download
 * duration, SQLite payload size, retained shard files, recorded
 * payload hash files, and raw/duplicate run-observation counts. Intended
 * to be run as `cao activity-stats` so an agent investigating indexing
 * performance can consume a single JSON report.
 */
export async function activityWorkflowStats({
  repo = process.env.GITHUB_REPOSITORY,
  workflow = DEFAULT_ACTIVITY_STATS_WORKFLOW,
  artifact = DEFAULT_ACTIVITY_STATS_ARTIFACT,
  limit = DEFAULT_ACTIVITY_STATS_LIMIT,
  keep = false
} = {}, execute = spawnSync) {
  if (!repo) throw new UsageError('Missing required option --repo (or GITHUB_REPOSITORY environment variable)');
  const limitCount = Number(limit);
  if (!Number.isInteger(limitCount) || limitCount < 1) throw new UsageError('--limit must be a positive integer');

  const list = execute('gh', [
    'run', 'list',
    '--repo', repo,
    '--workflow', workflow,
    '--json', 'databaseId,status,conclusion,createdAt,updatedAt,url',
    '--limit', String(limitCount)
  ], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (list.error || list.status !== 0) {
    throw new Error(`Unable to list runs for ${workflow}: ${(list.stderr || '').trim() || list.error?.message || 'unknown error'}`);
  }
  let runs;
  try {
    runs = JSON.parse(list.stdout || '[]');
  } catch (error) {
    throw new Error(`Unable to parse "gh run list" output: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(runs)) throw new Error('Unable to parse "gh run list" output: expected a JSON array');

  const runStats = [];
  for (const run of runs) {
    runStats.push(await inspectActivityRun(repo, run, artifact, execute, keep));
  }

  const withArtifact = runStats.filter((entry) => !entry.error);
  const summary = {
    repository: repo,
    workflow,
    artifact,
    runsInspected: runStats.length,
    runsWithArtifact: withArtifact.length,
    runsMissingArtifact: runStats.length - withArtifact.length,
    totalDownloadDurationMs: runStats.reduce((sum, entry) => sum + (entry.downloadDurationMs || 0), 0),
    averageDownloadDurationMs: withArtifact.length === 0
      ? 0
      : Math.round(withArtifact.reduce((sum, entry) => sum + (entry.downloadDurationMs || 0), 0) / withArtifact.length),
    totalShardBytes: withArtifact.reduce(
      (sum, entry) => sum + entry.shards.reduce((shardSum, shard) => shardSum + shard.sizeBytes, 0),
      0
    ),
    totalSqliteBytes: withArtifact.reduce((sum, entry) => sum + (entry.sqlite?.sizeBytes || 0), 0),
    totalShardFiles: withArtifact.reduce((sum, entry) => sum + (entry.shards?.length || 0), 0),
    totalHashFiles: withArtifact.reduce((sum, entry) => sum + (entry.hashFiles?.length || 0), 0),
    totalUniqueRuns: withArtifact.reduce((sum, entry) => sum + (entry.uniqueRuns || 0), 0),
    totalDuplicateRunObservations: withArtifact.reduce((sum, entry) => sum + (entry.duplicateRunObservations || 0), 0)
  };

  return { command: 'activity-stats', summary, runs: runStats };
}
