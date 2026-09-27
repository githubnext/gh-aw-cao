#!/usr/bin/env node
// Container end-to-end test for the read-only CAO MCP server.
//
// Builds the MCP image, mounts a fixture SQLite snapshot read-only, serves MCP
// over HTTPS with an ephemeral certificate, and verifies that the snapshot and
// the container filesystem stay unchanged.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import https from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { installSqliteIndexedDB } from "../../dashboard/site/src/data/storage/sqlite-indexeddb.js";
import { readCollections } from "../../dashboard/site/src/data/storage/indexeddb.js";
import { MCP_PROTOCOL_VERSION } from "../../activity/mcp-server.mjs";

const run = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const image = "cao-mcp-e2e";
const container = "cao-mcp-e2e";
const port = Number(process.env.CAO_MCP_E2E_PORT ?? 18443);

/**
 * @param {string} url
 * @param {string} certificateAuthority
 * @param {Record<string, unknown>} message
 */
function post(url, certificateAuthority, message) {
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
        ...(message.params?.name ? { "Mcp-Name": String(message.params.name) } : {}),
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

/**
 * @param {string} certificateAuthority
 */
async function waitForHealth(certificateAuthority) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const healthy = await new Promise((resolve, reject) => {
        https.get(`https://localhost:${port}/healthz`, {
          ca: certificateAuthority,
          servername: "localhost",
        }, (response) => {
          response.resume();
          resolve(response.statusCode === 200);
        }).on("error", reject);
      });
      if (healthy) return;
    } catch {
      // The container is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("CAO MCP container did not become healthy");
}

async function main() {
  try {
    await run("docker", ["version"]);
  } catch {
    process.stdout.write("Skipping CAO MCP container test: docker is unavailable.\n");
    return;
  }
  const directory = await mkdtemp(path.join(tmpdir(), "cao-mcp-container-"));
  const dataDirectory = path.join(directory, "data");
  const tlsDirectory = path.join(directory, "tls");
  const snapshot = path.join(dataDirectory, "gh-aw-logs.sqlite");
  await mkdir(dataDirectory, { recursive: true });
  await mkdir(tlsDirectory, { recursive: true });
  await run("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", path.join(tlsDirectory, "tls.key"),
    "-out", path.join(tlsDirectory, "tls.crt"),
    "-days", "1", "-subj", "/CN=localhost",
    "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
  ]);
  const fixture = await installSqliteIndexedDB(snapshot);
  await readCollections(fixture, ["runs"]);
  await run("chmod", ["-R", "a+rX", directory]);
  const digestBefore = createHash("sha256")
    .update(await readFile(snapshot))
    .digest("hex");
  const certificateAuthority = await readFile(
    path.join(tlsDirectory, "tls.crt"),
    "utf8",
  );
  await run("docker", [
    "build", "-f", "Dockerfile.mcp", "-t", image, ".",
  ], { cwd: repositoryRoot, maxBuffer: 64 * 1024 * 1024 });
  await run("docker", ["rm", "-f", container]).catch(() => {});
  await run("docker", [
    "run", "--detach", "--name", container,
    "--read-only", "--tmpfs", "/tmp",
    "--volume", `${dataDirectory}:/data:ro`,
    "--volume", `${tlsDirectory}:/run/cao:ro`,
    "--publish", `${port}:8443`,
    image,
  ]);
  try {
    await waitForHealth(certificateAuthority);
    const url = `https://localhost:${port}/mcp`;
    const tools = await post(url, certificateAuthority, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    const names = tools.payload.result.tools.map((tool) => tool.name);
    if (names.join(",") !== "cao_catalog,cao_query") {
      throw new Error(`Unexpected MCP tools: ${names.join(", ")}`);
    }
    const catalog = await post(url, certificateAuthority, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "cao_catalog", arguments: { kind: "queries" } },
    });
    const queries = catalog.payload.result.structuredContent.queries;
    const executable = queries.find((query) => query.execution.local);
    if (!executable) throw new Error("No locally executable query was discovered");
    const result = await post(url, certificateAuthority, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "cao_query", arguments: { id: executable.id, limit: 5 } },
    });
    const payload = result.payload.result.structuredContent;
    if (payload.query !== executable.id || !Array.isArray(payload.rows)) {
      throw new Error(`Unexpected cao_query result: ${JSON.stringify(payload)}`);
    }
    if (!payload.metadata?.availability) {
      throw new Error("cao_query result is missing availability metadata");
    }
    const { stdout: identity } = await run("docker", ["exec", container, "id", "-u"]);
    if (identity.trim() === "0") throw new Error("The container runs as root");
    const write = await run("docker", [
      "exec", container, "sh", "-c", "touch /app/write-probe",
    ]).then(() => "written").catch(() => "read-only");
    if (write !== "read-only") throw new Error("The container filesystem is writable");
    const digestAfter = createHash("sha256")
      .update(await readFile(snapshot))
      .digest("hex");
    if (digestBefore !== digestAfter) throw new Error("The mounted snapshot changed");
    process.stdout.write(
      `CAO MCP container served ${queries.length} catalogued queries over HTTPS without modifying its snapshot.\n`,
    );
  } finally {
    await run("docker", ["rm", "-f", container]).catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
}

await main();
