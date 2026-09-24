export const QUERY_CHUNK_SIZE = 25;

/**
 * Parses a Playwright-style `N/M` shard descriptor (1-based index, total count).
 * Returns `{ index: 1, total: 1 }` for a missing or malformed descriptor so
 * callers can treat "no sharding" as shard 1 of 1.
 */
export function parseQueryPerformanceShard(descriptor) {
  const match = typeof descriptor === "string" ? descriptor.match(/^(\d+)\/(\d+)$/) : null;
  if (!match) return { index: 1, total: 1 };
  const total = Number(match[2]);
  const index = Number(match[1]);
  if (!Number.isInteger(total) || total < 1 || !Number.isInteger(index) || index < 1 || index > total) {
    return { index: 1, total: 1 };
  }
  return { index, total };
}

/**
 * Contiguously partitions `queries` into `total` groups and returns the
 * group for the 1-based `index`, distributing any remainder across the
 * earliest shards so every shard gets a near-even, deterministic slice.
 */
export function partitionQueryDefinitions(queries, index, total) {
  if (total <= 1) return queries;
  const count = queries.length;
  const baseSize = Math.floor(count / total);
  const remainder = count % total;
  const shardSize = (shard) => baseSize + (shard <= remainder ? 1 : 0);
  let start = 0;
  for (let shard = 1; shard < index; shard += 1) start += shardSize(shard);
  return queries.slice(start, start + shardSize(index));
}

/**
 * Merges the per-shard reports produced by sharded query-performance runs
 * back into a single report shaped like the unsharded output. The
 * population/overview/IndexedDB measurements are taken from the first shard
 * that reports them; per-query timings are concatenated in shard order.
 */
export function mergeQueryPerformanceReports(reports) {
  if (reports.length === 1) return reports[0];
  const base = reports.find((report) => report.overview) ?? reports[0];
  const queries = reports.flatMap((report) => report.queries);
  const overview = base.overview
    ? {
      ...base.overview,
      slowestSources: queries
        .filter(({ query }) => query in base.overview.returnedRows)
        .sort((left, right) => right.firstChunkMs - left.firstChunkMs)
        .slice(0, 5),
    }
    : base.overview;
  return {
    ...base,
    overview,
    queries,
  };
}

export function deployedProxyTarget(pathname, baseUrl) {
  const base = new URL(baseUrl);
  const target = new URL(base);
  target.pathname = `${base.pathname}${pathname.replace(/^\/+/, "")}`;
  return target.pathname.startsWith(base.pathname)
    ? target
    : null;
}

export async function availableDeployedActivityShardEntries(entries, { baseUrl, fetchImpl = fetch }) {
  const checked = await Promise.all(entries.map(async (entry) => {
    const target = deployedProxyTarget(`/${entry.sourceName}`, baseUrl);
    if (!target) return null;
    const response = await fetchImpl(target, { method: "HEAD", redirect: "error" }).catch(() => null);
    return response?.ok ? entry : null;
  }));
  return checked.filter(Boolean);
}

export function roundMilliseconds(value) {
  return Math.round(value * 100) / 100;
}

export function summarizeQueryTiming({ name, firstChunkMs, continuationChunkMs, fillIterationMs, rows }) {
  return {
    query: name,
    rows,
    chunks: Math.max(1, Math.ceil(rows / QUERY_CHUNK_SIZE)),
    firstChunkMs: roundMilliseconds(firstChunkMs),
    continuationChunkMs: continuationChunkMs === null ? null : roundMilliseconds(continuationChunkMs),
    fillIterationMs: roundMilliseconds(fillIterationMs),
  };
}

export function overviewPhaseBreakdown(overview) {
  const worker = overview.worker;
  const phases = [
    { phase: "IndexedDB reads", durationMs: worker.databaseMs },
    {
      phase: "Canonical projection",
      durationMs: worker.projectionMs,
    },
    {
      phase: "Declarative queries",
      durationMs: Math.max(0, worker.queryMs - worker.projectionMs),
    },
    {
      phase: "Worker messaging",
      durationMs: Math.max(0, overview.requestMs - worker.totalMs),
    },
  ].map((phase) => ({
    ...phase,
    durationMs: roundMilliseconds(phase.durationMs),
    percent: overview.requestMs > 0
      ? roundMilliseconds(phase.durationMs / overview.requestMs * 100)
      : 0,
  }));
  return phases.sort((left, right) => right.durationMs - left.durationMs);
}

export function queryPerformanceMarkdown(report) {
  const overviewPhases = overviewPhaseBreakdown(report.overview);
  const lines = [
    `Population time: **${report.populateMs.toFixed(2)} ms**`,
    "",
    "### IndexedDB count()",
    "",
    `Counted **${report.indexedDbCount.records.toLocaleString("en-US")} records** across `
      + `**${report.indexedDbCount.stores.toLocaleString("en-US")} stores** in `
      + `**${report.indexedDbCount.durationMs.toFixed(2)} ms**.`,
    "",
    "### Overview critical path",
    "",
    `Initial Overview ready: **${report.overview.initialReadyMs.toFixed(2)} ms**`,
    "",
    `Settled deployed-data query: **${report.overview.requestMs.toFixed(2)} ms** `
      + `(${report.overview.worker.recordsRead.toLocaleString("en-US")} records read)`,
    "",
    "| Phase | Duration (ms) | Share |",
    "|---|---:|---:|",
    ...overviewPhases.map((phase) =>
      `| ${phase.phase} | ${phase.durationMs.toFixed(2)} | ${phase.percent.toFixed(2)}% |`
    ),
    "",
    "Slowest standalone Overview sources:",
    "",
    "| Source | First result (ms) | Rows |",
    "|---|---:|---:|",
    ...report.overview.slowestSources.map((source) =>
      `| \`${source.query}\` | ${source.firstChunkMs.toFixed(2)} | ${source.rows} |`
    ),
    "",
    "### All dashboard queries",
    "",
    `Chunk size: **${report.chunkSize} rows**`,
    "",
    "| Query | Rows | Chunks | First chunk (ms) | Continuation chunk (ms) | Fill iteration (ms) |",
    "|---|---:|---:|---:|---:|---:|",
  ];
  for (const result of report.queries) {
    lines.push(`| ${[
      `\`${result.query}\``,
      result.rows,
      result.chunks,
      result.firstChunkMs.toFixed(2),
      result.continuationChunkMs === null ? "—" : result.continuationChunkMs.toFixed(2),
      result.fillIterationMs.toFixed(2),
    ].join(" | ")} |`);
  }
  return `${lines.join("\n")}\n`;
}
