export const QUERY_CHUNK_SIZE = 25;

export function deployedProxyTarget(pathname, baseUrl) {
  const base = new URL(baseUrl);
  const target = new URL(base);
  target.pathname = `${base.pathname}${pathname.replace(/^\/+/, "")}`;
  return target.pathname.startsWith(base.pathname)
    ? target
    : null;
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
