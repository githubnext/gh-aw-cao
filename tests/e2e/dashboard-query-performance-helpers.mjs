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

export function queryPerformanceMarkdown(report) {
  const lines = [
    `Population time: **${report.populateMs.toFixed(2)} ms**`,
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
