/**
 * Builds a deterministic schema-v2 gh-aw cached JSONL payload large enough to
 * exercise the dashboard ingestion write phase, without downloading published
 * operational data.
 *
 * @param {{ runs?: number, toolCallsPerRun?: number, repositories?: number, workflows?: number, startedAt?: string }} [options]
 * @returns {string} newline-delimited JSON
 */
export function syntheticGhAwLogs(options = {}) {
  const runs = options.runs ?? 3000;
  const toolCallsPerRun = options.toolCallsPerRun ?? 20;
  const repositories = options.repositories ?? 20;
  const workflows = options.workflows ?? 15;
  const startedAt = Date.parse(options.startedAt ?? "2026-09-09T04:00:00Z");
  const lines = [];
  for (let index = 0; index < runs; index += 1) {
    const runIdentifier = 100000 + index;
    const observedAt = new Date(startedAt - index * 60_000).toISOString();
    lines.push(JSON.stringify({
      schema_version: 2,
      kind: "run",
      run: {
        run_id: runIdentifier,
        run_attempt: 1,
        organization: "githubnext",
        repository: `synthetic-repo-${index % repositories}`,
        workflow_name: `Synthetic Workflow ${index % workflows}`,
        workflow_path: `.github/workflows/synthetic-${index % workflows}.md`,
        status: "completed",
        conclusion: index % 7 === 0 ? "failure" : "success",
        created_at: observedAt,
        updated_at: observedAt,
        url: `https://github.com/githubnext/synthetic-repo-${index % repositories}/actions/runs/${runIdentifier}`,
        audit: {
          mcp_tool_usage: {
            tool_calls: Array.from({ length: toolCallsPerRun }, (_, call) => ({
              tool_call_id: `call-${runIdentifier}-${call}`,
              timestamp: observedAt,
              server_name: "github",
              tool_name: "search_issues",
              input_size: 42,
              output_size: 128,
              status: "success",
            })),
          },
          firewall_analysis: {
            requests_by_domain: {
              "api.github.com:443": { allowed: 4, blocked: 2 },
            },
          },
        },
      },
    }));
  }
  return `${lines.join("\n")}\n`;
}
