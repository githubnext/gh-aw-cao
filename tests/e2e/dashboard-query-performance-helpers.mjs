export const QUERY_CHUNK_SIZE = 25;

export function roundMilliseconds(value) {
  return Math.round(value * 100) / 100;
}

export function summarizeQueryTiming({ name, firstChunkMs, continuationChunkMs, fillMs, rows }) {
  const chunks = 1 + continuationChunkMs.length;
  const meanChunkMs = continuationChunkMs.length > 0
    ? continuationChunkMs.reduce((total, duration) => total + duration, 0) / continuationChunkMs.length
    : null;
  return {
    query: name,
    rows,
    chunks,
    firstChunkMs: roundMilliseconds(firstChunkMs),
    meanContinuationChunkMs: meanChunkMs === null ? null : roundMilliseconds(meanChunkMs),
    fillMs: roundMilliseconds(fillMs),
    continuationChunkMs: continuationChunkMs.map(roundMilliseconds),
  };
}

export function queryPerformanceMarkdown(report) {
  const lines = [
    `Population time: **${report.populateMs.toFixed(2)} ms**`,
    "",
    `Chunk size: **${report.chunkSize} rows**`,
    "",
    "| Query | Rows | Chunks | First chunk (ms) | Mean continuation chunk (ms) | Full fill (ms) |",
    "|---|---:|---:|---:|---:|---:|",
  ];
  for (const result of report.queries) {
    lines.push([
      `| \`${result.query}\``,
      result.rows,
      result.chunks,
      result.firstChunkMs.toFixed(2),
      result.meanContinuationChunkMs === null ? "—" : result.meanContinuationChunkMs.toFixed(2),
      result.fillMs.toFixed(2),
      "|",
    ].join(" | "));
  }
  return `${lines.join("\n")}\n`;
}
