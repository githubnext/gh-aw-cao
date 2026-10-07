export function postgresQueryCostMarkdown(report, candidates) {
  const ranks = new Map(candidates.map(({ name, rank }) => [name, rank]));
  const measurements = [...report.measurements].sort((a, b) => b["duration-ms"] - a["duration-ms"]);
  return [
    "### Dashboard query cost (deployed artifacts, Postgres + Go)",
    "",
    `Ingested **${report.records.toLocaleString("en-US")} records** into isolated Postgres; measured **${measurements.length} queries** selected by static cost rank.`,
    "",
    `Measured the first **${report["page-limit"]} result rows** of each query; full-plan cardinality and cost checks still cover every source row.`,
    "",
    "| Query | Static rank | Page rows | Total rows | Row operations | Time (ms) | Working rows | Retained bytes |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...measurements.map((entry) => `| \`${entry.query}\` | ${ranks.get(entry.query)} | ${entry.rows} | ${entry["total-rows"]} | ${entry.metrics.operations} | ${entry["duration-ms"].toFixed(2)} | ${entry.metrics.peakWorkingRows} | ${entry.metrics.retainedBytes} |`),
    "",
    "_Timings include Postgres source reads and Go query execution; operations and retained bytes are Go engine metrics, not PostgreSQL EXPLAIN statistics._",
    "",
  ].join("\n");
}
