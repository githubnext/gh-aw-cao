import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import https from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  MAX_MCP_REQUEST_BYTES,
  MCP_LIST_CACHE,
  MCP_PROTOCOL_VERSION,
  handleMcpRequest,
  startMcpServer,
} from "../../activity/mcp-server.mjs";
import { installSqliteIndexedDB } from "../../dashboard/site/src/data/storage/sqlite-indexeddb.js";

const executeFile = promisify(execFile);
const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "cao-mcp-test-"));
const indexedDB = await installSqliteIndexedDB(
  path.join(temporaryDirectory, "gh-aw-logs.sqlite"),
);

test.after(async () => {
  await rm(temporaryDirectory, { recursive: true, force: true });
});

/**
 * @param {string} method
 * @param {unknown} params
 * @param {Record<string, string>} [headers]
 */
function request(method, params, headers = {}) {
  return handleMcpRequest({
    headers: {
      "mcp-protocol-version": MCP_PROTOCOL_VERSION,
      "mcp-method": method,
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    indexedDB,
  });
}

/**
 * Issues one MCP request over the wire so the HTTPS transport is tested at the
 * real protocol boundary rather than through a client library.
 *
 * @param {string} url
 * @param {string} certificateAuthority
 * @param {Record<string, unknown>} message
 */
function postOverHttps(url, certificateAuthority, message) {
  const body = JSON.stringify(message);
  return new Promise((resolve, reject) => {
    const request = https.request(url, {
      method: "POST",
      ca: certificateAuthority,
      servername: "localhost",
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
        "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
        "Mcp-Method": String(message.method),
      },
    }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { text += chunk; });
      response.on("end", () => {
        try {
          resolve({ status: response.statusCode, payload: JSON.parse(text) });
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on("error", reject);
    request.end(body);
  });
}

test("server/discover advertises the stateless protocol revision", async () => {
  const { status, body } = await request("server/discover", {});
  assert.equal(status, 200);
  assert.equal(body.result.protocolVersion, MCP_PROTOCOL_VERSION);
  assert.equal(body.result.serverInfo.name, "cao");
  assert.ok(body.result.capabilities.tools);
});

test("tools/list returns a deterministic, cacheable catalog", async () => {
  const { status, body } = await request("tools/list", {});
  assert.equal(status, 200);
  assert.deepEqual(
    body.result.tools.map((tool) => tool.name),
    ["cao_catalog", "cao_query"],
  );
  assert.deepEqual(body.result.cache, MCP_LIST_CACHE);
  const repeated = await request("tools/list", {});
  assert.deepEqual(repeated.body, body);
});

test("cao_catalog describes pages and queries", async () => {
  const pages = await request(
    "tools/call",
    { name: "cao_catalog", arguments: { kind: "pages" } },
    { "mcp-name": "cao_catalog" },
  );
  assert.equal(pages.status, 200);
  assert.ok(pages.body.result.structuredContent.pages.length > 0);

  const query = await request(
    "tools/call",
    { name: "cao_catalog", arguments: { kind: "queries", id: "campaign-runs" } },
    { "mcp-name": "cao_catalog" },
  );
  assert.equal(query.body.result.structuredContent.query.id, "campaign-runs");
  assert.equal(query.body.result.structuredContent.query.execution.local, true);
});

test("cao_catalog rejects an unknown kind", async () => {
  const { body } = await request(
    "tools/call",
    { name: "cao_catalog", arguments: { kind: "sql" } },
    { "mcp-name": "cao_catalog" },
  );
  assert.equal(body.result.isError, true);
});

test("cao_query returns rows with availability metadata", async () => {
  const { status, body } = await request(
    "tools/call",
    { name: "cao_query", arguments: { id: "campaign-runs", limit: 5 } },
    { "mcp-name": "cao_query" },
  );
  assert.equal(status, 200);
  const payload = body.result.structuredContent;
  assert.equal(payload.query, "campaign-runs");
  assert.ok(Array.isArray(payload.rows));
  assert.ok(payload.metadata.availability);
  assert.ok(payload.metadata.completeness);
  assert.ok(payload.metadata.freshness);
  assert.ok(payload.metadata["as-of"]);
});

test("cao_query refuses unknown queries and unknown parameters", async () => {
  const unknownQuery = await request(
    "tools/call",
    { name: "cao_query", arguments: { id: "not-a-query" } },
    { "mcp-name": "cao_query" },
  );
  assert.equal(unknownQuery.body.result.isError, true);
  assert.match(unknownQuery.body.result.content[0].text, /not-a-query/);

  const unknownParameter = await request(
    "tools/call",
    {
      name: "cao_query",
      arguments: { id: "campaign-runs", parameters: { nope: "value" } },
    },
    { "mcp-name": "cao_query" },
  );
  assert.equal(unknownParameter.body.result.isError, true);
});

test("MCP does not expose arbitrary SQL or declarative queries", async () => {
  const { body } = await request("tools/list", {});
  const names = body.result.tools.map((tool) => tool.name);
  for (const forbidden of ["cao_sql", "execute_sql", "query_sqlite"]) {
    assert.ok(!names.includes(forbidden));
  }
  const unknownTool = await request(
    "tools/call",
    { name: "cao_sql", arguments: {} },
    { "mcp-name": "cao_sql" },
  );
  assert.equal(unknownTool.status, 400);
  assert.equal(unknownTool.body.error.code, -32602);
});

test("requests must carry an agreeing protocol and method header", async () => {
  const missingVersion = await handleMcpRequest({
    headers: { "mcp-method": "tools/list" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    indexedDB,
  });
  assert.equal(missingVersion.status, 400);
  assert.match(missingVersion.body.error.message, /MCP-Protocol-Version/);

  const wrongVersion = await handleMcpRequest({
    headers: {
      "mcp-protocol-version": "2025-06-18",
      "mcp-method": "tools/list",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    indexedDB,
  });
  assert.equal(wrongVersion.status, 400);

  const wrongMethod = await request("tools/list", {}, { "mcp-method": "tools/call" });
  assert.equal(wrongMethod.status, 400);
  assert.equal(wrongMethod.body.error.code, -32600);

  const wrongName = await request(
    "tools/call",
    { name: "cao_query", arguments: { id: "campaign-runs" } },
    { "mcp-name": "cao_catalog" },
  );
  assert.equal(wrongName.status, 400);
  assert.equal(wrongName.body.error.code, -32600);
});

test("malformed, oversized, and unknown requests are rejected", async () => {
  const malformed = await handleMcpRequest({
    headers: {
      "mcp-protocol-version": MCP_PROTOCOL_VERSION,
      "mcp-method": "tools/list",
    },
    body: "{not json",
    indexedDB,
  });
  assert.equal(malformed.status, 400);
  assert.equal(malformed.body.error.code, -32700);

  const oversized = await handleMcpRequest({
    headers: {
      "mcp-protocol-version": MCP_PROTOCOL_VERSION,
      "mcp-method": "tools/call",
    },
    body: "x".repeat(MAX_MCP_REQUEST_BYTES + 1),
    indexedDB,
  });
  assert.equal(oversized.status, 413);

  const unknownMethod = await request("resources/list", {});
  assert.equal(unknownMethod.status, 400);
  assert.equal(unknownMethod.body.error.code, -32601);
});

test("cancelled requests stop before returning rows", async () => {
  const controller = new AbortController();
  controller.abort();
  const { status, body } = await handleMcpRequest({
    headers: {
      "mcp-protocol-version": MCP_PROTOCOL_VERSION,
      "mcp-method": "tools/call",
      "mcp-name": "cao_query",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "cao_query", arguments: { id: "campaign-runs" } },
    }),
    indexedDB,
    signal: controller.signal,
  });
  assert.equal(status, 499);
  assert.equal(body.error.code, -32800);
});

test("the server refuses to bind a non-loopback host without TLS", async () => {
  await assert.rejects(
    startMcpServer({ indexedDB, host: "0.0.0.0", port: 0 }),
    /--cert and --key/,
  );
});

test("the server answers MCP requests over HTTPS", async (t) => {
  const directory = path.join(temporaryDirectory, "tls");
  const certificate = path.join(directory, "tls.crt");
  const key = path.join(directory, "tls.key");
  await mkdir(directory, { recursive: true });
  try {
    await executeFile("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", key,
      "-out", certificate,
      "-days", "1", "-subj", "/CN=localhost",
      "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ]);
  } catch {
    t.skip("openssl is unavailable");
    return;
  }
  const server = await startMcpServer({
    indexedDB,
    host: "127.0.0.1",
    port: 0,
    certPath: certificate,
    keyPath: key,
  });
  try {
    assert.match(server.url, /^https:\/\//);
    const { status, payload } = await postOverHttps(
      server.url,
      await readFile(certificate, "utf8"),
      { jsonrpc: "2.0", id: 7, method: "tools/list" },
    );
    assert.equal(status, 200);
    assert.equal(payload.id, 7);
    assert.deepEqual(
      payload.result.tools.map((tool) => tool.name),
      ["cao_catalog", "cao_query"],
    );
  } finally {
    await server.stop();
  }
});
