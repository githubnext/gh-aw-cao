import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const executeFile = promisify(execFile);

test("downloads the deployed JSONL and SQLite files without rebuilding", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "deployed-dashboard-data-"));
  const output = path.join(root, "activity");
  const logsContent = '{"schema_version":2,"kind":"run","run":{"run_id":303}}\n';
  const databaseContent = Buffer.from("published sqlite bytes");
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.url);
    response.writeHead(200, { "content-type": "application/x-ndjson" });
    response.end(request.url?.endsWith(".sqlite") ? databaseContent : logsContent);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const { stdout } = await executeFile(process.execPath, [
      path.resolve("scripts/download-deployed-dashboard-data.mjs"),
      "--url",
      `http://127.0.0.1:${address.port}/cao/gh-aw-logs.jsonl`,
      "--output",
      output,
    ]);
    const result = JSON.parse(stdout);
    assert.equal(await readFile(path.join(output, "gh-aw-logs.jsonl"), "utf8"), logsContent);
    assert.deepEqual(await readFile(path.join(output, "gh-aw-logs.sqlite")), databaseContent);
    assert.deepEqual(requests.toSorted(), [
      "/cao/gh-aw-logs.jsonl",
      "/cao/gh-aw-logs.sqlite",
    ]);
    assert.match(result.databaseUrl, /\/cao\/gh-aw-logs\.sqlite$/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
