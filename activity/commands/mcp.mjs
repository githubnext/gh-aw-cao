import { DEFAULT_MCP_HOST, DEFAULT_MCP_PORT, startMcpServer } from "../mcp-server.mjs";

export async function runMcp({ options, indexedDB, signal, option, rejectUnknownOptions, UsageError }) {
  rejectUnknownOptions(options, ["database", "dashboard", "host", "port"]);
  const port = option(options, "port", false);
  if (port !== undefined && !(/^\d+$/.test(port) && Number(port) >= 1 && Number(port) <= 65535)) {
    throw new UsageError("--port must be a port number between 1 and 65535");
  }
  const server = await startMcpServer({
    indexedDB,
    dashboardPath: option(options, "dashboard", false),
    host: option(options, "host", false) || DEFAULT_MCP_HOST,
    port: port === undefined ? DEFAULT_MCP_PORT : Number(port),
    signal,
  });
  process.stderr.write(`CAO MCP listening on ${server.url}\n`);
  await server.closed;
  return { command: "mcp", url: server.url };
}
