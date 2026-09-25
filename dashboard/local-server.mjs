#!/usr/bin/env node

import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  appendFile,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createReadStream, createWriteStream, watch } from "node:fs";
import { isIP } from "node:net";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { cliActionTemplateFields, renderCliActionCommand } from "./site/src/cli-action-template.js";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import { createGzip, gzipSync } from "node:zlib";
import { bundleDashboardFiles } from "./report/bundle-dashboards.mjs";
import { buildDashboardPageChunkPath, splitDashboardDocument } from "./site/src/dashboard-chunks.js";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const executeFile = promisify(execFile);
const defaultCatalogRoot = resolve(scriptDirectory, "..");
const socketEndpoint = "/__dashboard_socket";
const dataArtifactName = "central-agentic-ops-dashboard";
const devServerPidFileName = ".cao-dashboard-dev-server.json";
const trustedDashboardWorkflowPaths = new Set([
  ".github/workflows/cao-dashboard.yml",
]);
const contentTypes = new Map([
  [".avif", "image/avif"],
  [".css", "text/css; charset=utf-8"],
  [".gif", "image/gif"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".jsonl", "application/x-ndjson; charset=utf-8"],
  [".md", "text/markdown; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"],
]);
const redactedTextExtensions = new Set([".css", ".html", ".js", ".md", ".mjs", ".svg"]);
const compressibleContentTypes = new Set([
  "application/json; charset=utf-8",
  "application/x-ndjson; charset=utf-8",
  "image/svg+xml",
  "text/css; charset=utf-8",
  "text/html; charset=utf-8",
  "text/javascript; charset=utf-8",
  "text/markdown; charset=utf-8",
]);
const minimumCompressedBytes = 1_024;
const minimumCacheableCompressionBytes = 1_048_576;
const maximumCachedCompressions = 4;
/** @type {Map<string, Buffer>} */
const compressedPayloads = new Map();

function compressPayload(body) {
  if (body.byteLength < minimumCacheableCompressionBytes) return gzipSync(body);
  const key = createHash("sha256").update(body).digest("hex");
  const cached = compressedPayloads.get(key);
  if (cached) return cached;
  const compressed = gzipSync(body);
  compressedPayloads.set(key, compressed);
  for (const staleKey of [...compressedPayloads.keys()].slice(0, -maximumCachedCompressions)) {
    compressedPayloads.delete(staleKey);
  }
  return compressed;
}

/**
 * Serves preview content the way GitHub Pages serves the deployed dashboard, so
 * throttled-network previews measure compressed transfer sizes.
 */
function sendContent(request, response, contentType, content) {
  const headers = { "Cache-Control": "no-store", "Content-Type": contentType };
  const body = Buffer.isBuffer(content) ? content : Buffer.from(String(content));
  const acceptsGzip = /(^|,)\s*gzip\s*(;|,|$)/.test(String(request.headers["accept-encoding"] ?? ""));
  if (request.method === "HEAD") {
    response.writeHead(200, compressibleContentTypes.has(contentType)
      ? { ...headers, Vary: "Accept-Encoding" }
      : headers);
    response.end();
    return;
  }

  if (acceptsGzip && compressibleContentTypes.has(contentType) && body.byteLength >= minimumCompressedBytes) {
    const compressed = compressPayload(body);
    response.writeHead(200, { ...headers, "Content-Encoding": "gzip", Vary: "Accept-Encoding" });
    response.end(compressed);
    return;
  }
  response.writeHead(200, compressibleContentTypes.has(contentType)
    ? { ...headers, Vary: "Accept-Encoding" }
    : headers);
  response.end(body);
}

async function sendFileContent(request, response, contentType, path) {
  const headers = { "Cache-Control": "no-store", "Content-Type": contentType };
  const acceptsGzip = /(^|,)\s*gzip\s*(;|,|$)/.test(String(request.headers["accept-encoding"] ?? ""));
  if (request.method === "HEAD") {
    const file = await stat(path);
    response.writeHead(200, {
      ...headers,
      "Content-Length": file.size,
      Vary: "Accept-Encoding",
    });
    response.end();
    return;
  }
  response.writeHead(200, acceptsGzip
    ? { ...headers, "Content-Encoding": "gzip", Vary: "Accept-Encoding" }
    : { ...headers, Vary: "Accept-Encoding" });
  const source = createReadStream(path);
  if (acceptsGzip) {
    await pipeline(source, createGzip(), response);
    return;
  }
  await pipeline(source, response);
}

function sendJson(response, statusCode, value) {
  response.writeHead(statusCode, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(value));
}

async function readJsonRequest(request, maximumBytes = 8192) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > maximumBytes) throw new Error("Request body is too large.");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function existingDirectories(paths) {
  const directories = [];
  for (const path of paths) {
    const entry = await stat(path).catch(() => null);
    if (entry?.isDirectory()) directories.push(path);
  }
  return directories;
}

async function canonicalPath(path) {
  const absolutePath = resolve(path);
  try {
    return await realpath(absolutePath);
  } catch (error) {
    if (error?.code !== "ENOENT" || dirname(absolutePath) === absolutePath) throw error;
    return join(await canonicalPath(dirname(absolutePath)), basename(absolutePath));
  }
}

async function campaignDashboardPaths(catalogRoot) {
  if (!catalogRoot) return [];
  const paths = [];
  const catalogEntries = await readdir(catalogRoot, { withFileTypes: true }).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  for (const entry of catalogEntries) {
    if (entry.name.startsWith(".")) continue;
    const path = join(catalogRoot, entry.name, "dashboard.json");
    if (!(await stat(path).catch(() => null))?.isFile()) continue;
    const resolvedPath = await realpath(path);
    if (!isWithin(catalogRoot, resolvedPath)) {
      throw new Error("Dashboard server paths must remain within the workspace.");
    }
    paths.push(resolvedPath);
  }
  return paths.toSorted();
}

async function downloadDashboardData(destination, repository, ghExecutable) {
  const repositoryPath = repository || "{owner}/{repo}";
  let defaultBranch;
  let runId;
  try {
    const repositoryResult = await executeFile(ghExecutable, [
      "api",
      `repos/${repositoryPath}`,
      "--jq",
      ".default_branch",
    ]);
    defaultBranch = repositoryResult.stdout.trim();
    const result = await executeFile(ghExecutable, [
      "api",
      `repos/${repositoryPath}/actions/artifacts?name=${dataArtifactName}&per_page=100`,
      "--jq",
      "[.artifacts[] | select(.expired == false)] | sort_by(.created_at) | last | .workflow_run.id // empty",
    ]);
    runId = result.stdout.trim();
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      throw new Error("GitHub CLI is required to download dashboard data.");
    }
    throw new Error("Unable to query the dashboard data artifact. Authenticate GitHub CLI with Actions read access.");
  }
  if (!/^[1-9][0-9]*$/.test(runId)) {
    throw new Error(`No current ${dataArtifactName} artifact is available. Run the dashboard action first.`);
  }
  if (!defaultBranch) throw new Error("Unable to determine the repository default branch.");

  let provenance;
  try {
    const result = await executeFile(ghExecutable, [
      "api",
      `repos/${repositoryPath}/actions/runs/${runId}`,
      "--jq",
      "[.conclusion, .head_branch, .path] | @tsv",
    ]);
    provenance = result.stdout.trim().split("\t");
  } catch {
    throw new Error(`Unable to verify ${dataArtifactName} from workflow run ${runId}.`);
  }
  if (provenance[0] !== "success"
      || provenance[1] !== defaultBranch
      || !trustedDashboardWorkflowPaths.has(provenance[2])) {
    throw new Error(`The latest ${dataArtifactName} artifact is not from a successful trusted dashboard workflow run.`);
  }

  const arguments_ = ["run", "download", runId, "--name", dataArtifactName, "--dir", destination];
  if (repository) arguments_.push("--repo", repository);
  try {
    await executeFile(ghExecutable, arguments_);
  } catch {
    throw new Error(`Unable to download ${dataArtifactName} from workflow run ${runId}.`);
  }
}

async function findCanonicalDashboardData(root) {
  const matches = [];
  const visit = async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true });
    const names = new Set(entries.map((entry) => entry.name));
    if (names.has("inventory-sources.json") && names.has("gh-aw-logs-runs")) {
      matches.push(directory);
    }
    await Promise.all(entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => visit(join(directory, entry.name))));
  };
  await visit(root);
  if (matches.length > 1) {
    throw new Error("The dashboard artifact contains multiple canonical data directories.");
  }
  return matches[0] ?? null;
}

async function sourceSignature(paths) {
  const entries = await Promise.all(paths.map(async (path) => `${path}\0${await readFile(path, "utf8")}`));
  return entries.join("\n");
}

function isLoopbackHost(host) {
  const unbracketed = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (unbracketed === "localhost" || unbracketed === "::1") return true;
  if (isIP(unbracketed) !== 4) return false;
  return unbracketed.split(".")[0] === "127";
}

const secretKeyPattern = /(?:^|[-_])(api[-_]?key|authorization|client[-_]?secret|password|private[-_]?key|secret|token)(?:$|[-_])/i;
const secretValuePatterns = [
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi,
  /\bAKIA[A-Z0-9]{16}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

function redactSecretValues(value) {
  return secretValuePatterns.reduce(
    (redacted, pattern) => redacted.replace(pattern, "[REDACTED]"),
    value,
  );
}

function redactJsonSecrets(source) {
  const redact = (value, key = "") => {
    if (secretKeyPattern.test(key)) return "[REDACTED]";
    if (Array.isArray(value)) return value.map((entry) => redact(entry));
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([name, entry]) => [name, redact(entry, name)]));
    }
    if (typeof value !== "string") return value;
    return redactSecretValues(value);
  };
  return JSON.stringify(redact(JSON.parse(source)), null, 2);
}

async function redactJsonlSecretsFile(sourcePath, destinationPath) {
  const decoder = new TextDecoder();
  const hash = createHash("sha256");
  let pending = "";
  const redactLine = (line) => line.trim()
    ? JSON.stringify(JSON.parse(redactJsonSecrets(line)))
    : "";
  const emit = (stream, content) => {
    hash.update(content);
    stream.push(content);
  };
  const redactor = new Transform({
    transform(chunk, _encoding, callback) {
      try {
        pending += decoder.decode(chunk, { stream: true });
        let newline;
        while ((newline = pending.indexOf("\n")) !== -1) {
          const line = pending.slice(0, newline).replace(/\r$/, "");
          emit(this, `${redactLine(line)}\n`);
          pending = pending.slice(newline + 1);
        }
        callback();
      } catch (error) {
        callback(error);
      }
    },
    flush(callback) {
      try {
        pending += decoder.decode();
        if (pending) emit(this, redactLine(pending));
        callback();
      } catch (error) {
        callback(error);
      }
    },
  });
  await pipeline(createReadStream(sourcePath), redactor, createWriteStream(destinationPath));
  return hash.digest("hex");
}

function browserSafeFileContent(path, content) {
  const extension = extname(path).toLowerCase();
  if (extension === ".json") return redactJsonSecrets(content.toString("utf8"));
  if (redactedTextExtensions.has(extension)) {
    return redactSecretValues(content.toString("utf8"));
  }
  return content;
}

function errorMetadata(error) {
  return {
    name: error instanceof Error ? error.name : typeof error,
    code: error && typeof error === "object" && "code" in error
      ? String(error.code)
      : undefined,
  };
}

async function processIsRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

async function isWorkspaceDashboardServer(pid, workingDirectory) {
  try {
    const [commandLine, processDirectory] = await Promise.all([
      readFile(`/proc/${pid}/cmdline`, "utf8"),
      realpath(`/proc/${pid}/cwd`),
    ]);
    const arguments_ = commandLine.split("\0").filter(Boolean);
    return processDirectory === workingDirectory
      && arguments_.some((argument) =>
        argument === "dashboard/local-server.mjs"
        || argument.endsWith("/dashboard/local-server.mjs"));
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ESRCH") return false;
    throw error;
  }
}

async function listeningProcessIds(port) {
  try {
    const result = await executeFile("lsof", [
      "-nP",
      `-iTCP:${port}`,
      "-sTCP:LISTEN",
      "-t",
    ]);
    return result.stdout
      .trim()
      .split(/\s+/)
      .filter((value) => /^[1-9][0-9]*$/.test(value))
      .map(Number);
  } catch (error) {
    if (error?.code === 1 || error?.code === "ENOENT") return [];
    throw error;
  }
}

async function waitForProcessExit(pid, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (!await processIsRunning(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !await processIsRunning(pid);
}

async function readDevServerPid(pidFile) {
  try {
    const record = JSON.parse(await readFile(pidFile, "utf8"));
    return Number.isInteger(record?.pid) && record.pid > 0
      ? { pid: record.pid, port: record.port }
      : null;
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

export async function replaceExistingDashboardDevServer({
  workingDirectory,
  port,
  output = console.log,
}) {
  const resolvedWorkingDirectory = await realpath(workingDirectory);
  const pidFile = join(resolvedWorkingDirectory, devServerPidFileName);
  const recorded = await readDevServerPid(pidFile);
  const candidates = new Set(await listeningProcessIds(port));
  if (recorded?.port === port) candidates.add(recorded.pid);
  candidates.delete(process.pid);

  for (const pid of candidates) {
    if (!await processIsRunning(pid)) continue;
    if (!await isWorkspaceDashboardServer(pid, resolvedWorkingDirectory)) {
      if ((await listeningProcessIds(port)).includes(pid)) {
        throw new Error(`Port ${port} is used by another process; refusing to stop it.`);
      }
      continue;
    }
    output(`Stopping previous dashboard dev server (PID ${pid}).`);
    process.kill(pid, "SIGTERM");
    if (!await waitForProcessExit(pid)) {
      output(`Previous dashboard dev server did not stop gracefully; terminating PID ${pid}.`);
      process.kill(pid, "SIGKILL");
      if (!await waitForProcessExit(pid, 2000)) {
        throw new Error(`Unable to stop previous dashboard dev server PID ${pid}.`);
      }
    }
  }

  await writeFile(pidFile, `${JSON.stringify({
    pid: process.pid,
    port,
    workingDirectory: resolvedWorkingDirectory,
  }, null, 2)}\n`, "utf8");
  return pidFile;
}

async function releaseDashboardDevServerPid(pidFile) {
  if (!pidFile) return;
  const recorded = await readDevServerPid(pidFile);
  if (recorded?.pid === process.pid) await rm(pidFile, { force: true });
}

function createTraceRecorder({ traceFile, output = console.log }) {
  let writes = Promise.resolve();
  return {
    record(source, event, { traceId, details = {} } = {}) {
      const entry = {
        timestamp: new Date().toISOString(),
        source,
        event,
        ...(traceId ? { traceId } : {}),
        details: JSON.parse(redactJsonSecrets(JSON.stringify(details))),
      };
      const line = JSON.stringify(entry);
      output(`[dashboard-trace] ${line}`);
      if (traceFile) {
        writes = writes.then(() => appendFile(traceFile, `${line}\n`, "utf8"));
      }
      return entry;
    },
    async flush() {
      await writes;
    },
  };
}

function isWithin(root, candidate) {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function websocketTextFrame(content) {
  const payload = Buffer.from(content);
  let header;
  if (payload.length < 126) {
    header = Buffer.from([0x81, payload.length]);
  } else if (payload.length <= 0xffff) {
    header = Buffer.allocUnsafe(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  return Buffer.concat([header, payload]);
}

function websocketCloseFrame() {
  return Buffer.from([0x88, 0x00]);
}

function websocketPongFrame(content) {
  const header = Buffer.from([0x8a, content.length]);
  return Buffer.concat([header, content]);
}

function readWebsocketFrames(buffer) {
  const messages = [];
  let offset = 0;
  while (buffer.length - offset >= 2) {
    const first = buffer[offset];
    const second = buffer[offset + 1];
    const final = (first & 0x80) !== 0;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let headerLength = 2;
    if (length === 126) {
      if (buffer.length - offset < 4) break;
      length = buffer.readUInt16BE(offset + 2);
      headerLength = 4;
    } else if (length === 127) {
      if (buffer.length - offset < 10) break;
      const extendedLength = buffer.readBigUInt64BE(offset + 2);
      if (extendedLength > 16_384n) throw new Error("WebSocket message is too large.");
      length = Number(extendedLength);
      headerLength = 10;
    }
    if (!masked || !final || length > 16_384) throw new Error("Unsupported WebSocket frame.");
    if (buffer.length - offset < headerLength + 4 + length) break;
    const maskOffset = offset + headerLength;
    const payloadOffset = maskOffset + 4;
    const payload = Buffer.allocUnsafe(length);
    for (let index = 0; index < length; index += 1) {
      payload[index] = buffer[payloadOffset + index] ^ buffer[maskOffset + (index % 4)];
    }
    messages.push({ opcode, payload });
    offset = payloadOffset + length;
  }
  return { messages, remaining: buffer.subarray(offset) };
}

/**
 * Starts the local dashboard server.
 *
 * @param {{
 *   siteRoot?: string,
 *   catalogRoot?: string | null,
 *   repository?: string,
 *   ghExecutable?: string,
 *   downloadData?: (destination: string, repository?: string, ghExecutable?: string) => Promise<void>,
 *   canvas?: boolean,
 *   executeCliAction?: (action: { id: string, command: string, input?: string, onOutput: (event: { stream: 'stdout'|'stderr', data: string }) => void }) => Promise<unknown>,
 *   traceFile?: string,
 *   traceOutput?: (message: string) => void,
 *   requestOutput?: (message: string) => void,
 *   output?: (...values: unknown[]) => void,
 *   workingDirectory?: string,
 *   host?: string,
 *   port?: number,
 * }} options
 */
export async function startDashboardServer({
  siteRoot = join(scriptDirectory, "site"),
  catalogRoot = defaultCatalogRoot,
  repository,
  ghExecutable = "gh",
  downloadData = downloadDashboardData,
  canvas = false,
  executeCliAction,
  allowMissingOrigin = false,
  traceFile,
  traceOutput = console.log,
  requestOutput = console.log,
  output = console.log,
  workingDirectory = process.cwd(),
  host = "127.0.0.1",
  port = 4173,
} = {}) {
  if (canvas && typeof executeCliAction !== "function") {
    throw new Error("Canvas mode requires a CLI action executor.");
  }
  const resolvedWorkingDirectory = await realpath(workingDirectory);
  const resolvedTraceFile = traceFile ? resolve(resolvedWorkingDirectory, traceFile) : null;
  if (resolvedTraceFile && !isWithin(resolvedWorkingDirectory, resolvedTraceFile)) {
    throw new Error("Dashboard trace file must remain within the workspace.");
  }
  if (resolvedTraceFile) {
    await mkdir(dirname(resolvedTraceFile), { recursive: true });
    await writeFile(resolvedTraceFile, "", "utf8");
  }
  const trace = createTraceRecorder({ traceFile: resolvedTraceFile, output: traceOutput });
  const resolvedSiteRoot = await realpath(siteRoot);
  const resolvedCatalogRoot = catalogRoot ? await canonicalPath(catalogRoot) : null;
  if (!isWithin(resolvedWorkingDirectory, resolvedSiteRoot)
      || (resolvedCatalogRoot && !isWithin(resolvedWorkingDirectory, resolvedCatalogRoot))) {
    output("Dashboard server configuration rejected.", {
      reason: "dashboard path is outside the workspace",
    });
    throw new Error("Dashboard server paths must remain within the workspace.");
  }
  await campaignDashboardPaths(resolvedCatalogRoot);
  const baseDashboardPath = join(resolvedSiteRoot, "dashboard.json");
  const temporaryDirectory = await mkdtemp(join(resolvedWorkingDirectory, ".cao-dashboard-preview-"));
  const bundledDashboardPath = join(temporaryDirectory, "dashboard.json");
  const dashboardDataDirectory = join(temporaryDirectory, "data");
  let sourcesContent;
  let sourceManifestContent;
  const dashboardDataShards = new Map();
  let payloadHashesContent;
  let inventorySourcesContent;
  const splitSourceContent = new Map();
  try {
    await downloadData(dashboardDataDirectory, repository, ghExecutable);
    const canonicalDataDirectory = await findCanonicalDashboardData(dashboardDataDirectory);
    if (canonicalDataDirectory) {
      const payloadHashes = {};
      for (const shardDirectoryName of ["gh-aw-logs-runs", "gh-aw-logs-records"]) {
        const shardDirectory = join(canonicalDataDirectory, shardDirectoryName);
        for (const entry of await readdir(shardDirectory, { withFileTypes: true }).catch(() => [])) {
          if (!entry.isFile() || !/^[A-Za-z0-9._-]+\.jsonl$/.test(entry.name)) continue;
          const outputPath = join(temporaryDirectory, shardDirectoryName, entry.name);
          await mkdir(dirname(outputPath), { recursive: true });
          const hash = await redactJsonlSecretsFile(join(shardDirectory, entry.name), outputPath);
          const publishedName = `${shardDirectoryName}/${entry.name}`;
          dashboardDataShards.set(`/${publishedName}`, outputPath);
          payloadHashes[publishedName] = hash;
        }
      }
      payloadHashesContent = JSON.stringify(payloadHashes);
      inventorySourcesContent = redactJsonSecrets(
        await readFile(join(canonicalDataDirectory, "inventory-sources.json"), "utf8"),
      );
    } else {
      sourcesContent = redactJsonSecrets(
        await readFile(join(dashboardDataDirectory, "sources.json"), "utf8"),
      );
      const parsedSources = JSON.parse(sourcesContent);
      for (const [name, logicalSource] of Object.entries(parsedSources)) {
        const browserSource = name === "runs"
          ? { ...logicalSource, rows: logicalSource.rows.map(({ "logs-payload": _logsPayload, ...row }) => row) }
          : logicalSource;
        splitSourceContent.set(name, JSON.stringify(browserSource));
      }
      sourceManifestContent = JSON.stringify({ version: 1, sources: [...splitSourceContent.keys()] });
    }
  } catch (error) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    throw error;
  }
  const sockets = new Set();
  const capability = randomBytes(24).toString("hex");
  const routePrefix = `/${capability}`;
  const socketPath = `${routePrefix}${socketEndpoint}`;
  const watchers = new Map();
  let dashboardContent = "";
  /** @type {Map<string, string>} */
  let dashboardPageChunkContent = new Map();
  let signature = "";
  let refreshTimer;
  let refreshPromise = Promise.resolve();
  let refreshRetryCount = 0;
  let closed = false;

  const broadcastDashboard = (traceId) => {
    output("Broadcasting dashboard preview update.", { socketCount: sockets.size });
    trace.record("server", "preview.broadcast", {
      traceId,
      details: { socketCount: sockets.size },
    });
    const message = traceId
      ? JSON.stringify({ type: "dashboard-update", traceId, dashboard: JSON.parse(dashboardContent) })
      : dashboardContent;
    const frame = websocketTextFrame(message);
    for (const socket of sockets) socket.write(frame);
  };

  const rebuild = async (notify = true, traceId, forceNotify = false) => {
    output("Checking dashboard sources for updates.");
    const campaignPaths = await campaignDashboardPaths(resolvedCatalogRoot);
    const nextSignature = await sourceSignature([baseDashboardPath, ...campaignPaths]);
    if (nextSignature === signature) {
      if (notify && forceNotify) broadcastDashboard(traceId);
      return campaignPaths;
    }

    await copyFile(baseDashboardPath, bundledDashboardPath);
    await bundleDashboardFiles(bundledDashboardPath, campaignPaths);
    const dashboardDocument = JSON.parse(await readFile(bundledDashboardPath, "utf8"));
    if (repository) dashboardDocument.dashboard.repository = repository;
    const splitDashboard = splitDashboardDocument({
      languageVersion: dashboardDocument["language-version"],
      dashboard: dashboardDocument.dashboard,
    });
    dashboardContent = redactJsonSecrets(JSON.stringify(splitDashboard.core));
    dashboardPageChunkContent = new Map(
      [...splitDashboard.pageChunks.entries()].map(([pageId, chunk]) => [
        `/${buildDashboardPageChunkPath(pageId)}`,
        redactJsonSecrets(JSON.stringify(chunk)),
      ]),
    );
    signature = nextSignature;
    output("Dashboard preview rebuilt.", {
      bundledDashboardPath,
      editableDashboardPaths: [baseDashboardPath, ...campaignPaths],
      notify,
    });
    trace.record("server", "preview.rebuilt", {
      traceId,
      details: {
        bundledDashboardPath,
        editableDashboardPaths: [baseDashboardPath, ...campaignPaths],
        notify,
      },
    });
    if (notify) broadcastDashboard(traceId);
    return campaignPaths;
  };

  const refreshWatchers = async (campaignPaths) => {
    if (closed) return;
    const candidates = new Set([
      resolvedSiteRoot,
      ...campaignPaths.map(dirname),
    ]);
    if (resolvedCatalogRoot) candidates.add(resolvedCatalogRoot);
    for (const directory of await existingDirectories(candidates)) {
      if (watchers.has(directory)) continue;
      const watcher = watch(directory, () => scheduleRefresh());
      watcher.on("error", (error) => {
        output(`Dashboard watcher failed for ${directory}: ${error.message}`);
        watcher.close();
        watchers.delete(directory);
      });
      watchers.set(directory, watcher);
      output("Watching dashboard source directory.", { directory });
    }
  };

  const refresh = async () => {
    if (closed) return;
    try {
      const campaignPaths = await rebuild();
      await refreshWatchers(campaignPaths);
      refreshRetryCount = 0;
    } catch (error) {
      output(`Dashboard update failed: ${error instanceof Error ? error.message : String(error)}`);
      if (refreshRetryCount < 4) {
        refreshRetryCount += 1;
        clearTimeout(refreshTimer);
        refreshTimer = setTimeout(scheduleRefresh, refreshRetryCount * 100);
      }
    }
  };

  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshPromise = refreshPromise.then(refresh, refresh);
    }, 75);
  }

  try {
    const initialCampaignPaths = await rebuild(false);
    await refreshWatchers(initialCampaignPaths);
  } catch (error) {
    for (const watcher of watchers.values()) watcher.close();
    await rm(temporaryDirectory, { recursive: true, force: true });
    throw error;
  }

  let expectedAuthority = null;
  let codespaceAuthority = null;
  let localhostAuthority = null;
  const isAllowedHost = (host) =>
      host === expectedAuthority
      || (localhostAuthority && host === localhostAuthority)
      || (codespaceAuthority && host === codespaceAuthority);
  const isAllowedOrigin = (origin) => {
    if (typeof origin !== "string") return false;
    try {
      const parsed = new URL(origin);
      return (parsed.protocol === "http:" || parsed.protocol === "https:")
        && isAllowedHost(parsed.host);
    } catch {
      return false;
    }
  };
  const server = createServer(async (request, response) => {
    const requestStarted = performance.now();
    let requestPath = "<outside-preview>";
    response.once("finish", () => {
      const duration = Math.max(0, Math.round(performance.now() - requestStarted));
      requestOutput(`${request.method || "GET"} ${requestPath} ${response.statusCode} ${duration}ms`);
    });
    try {
      if (!expectedAuthority || !request.headers.host || !isAllowedHost(request.headers.host)
          || /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(request.url || "")) {
        response.writeHead(400).end("Bad request\n");
        return;
      }
      const url = new URL(request.url || "/", "http://localhost");
      if (url.pathname !== routePrefix && !url.pathname.startsWith(`${routePrefix}/`)) {
        response.writeHead(404).end("Not found\n");
        return;
      }
      requestPath = `${url.pathname.slice(routePrefix.length) || "/"}${url.search}`;
      let pathname;
      try {
        pathname = decodeURIComponent(url.pathname.slice(routePrefix.length) || "/");
      } catch {
        response.writeHead(400).end("Bad request\n");
        return;
      }
      if ((pathname === "/" || pathname === "/index.html")
          && !url.searchParams.has("local-preview")) {
        url.searchParams.set("local-preview", canvas ? "canvas" : "enabled");
        response.writeHead(302, { Location: `${routePrefix}/${url.search}`, "Content-Type": "text/html; charset=utf-8" }).end();
        return;
      }
      if (pathname === "/__cli_action") {
        if (!canvas || typeof executeCliAction !== "function") {
          response.writeHead(404).end("Not found\n");
          return;
        }
        if (request.method !== "POST") {
          response.writeHead(405, { Allow: "POST" }).end();
          return;
        }
        if (!isAllowedOrigin(request.headers.origin)
            || !String(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
          response.writeHead(403).end("Forbidden\n");
          return;
        }
        let payload;
        try {
          payload = await readJsonRequest(request);
        } catch {
          sendJson(response, 400, { error: "Invalid CLI action request." });
          return;
        }
        if (!payload || typeof payload !== "object" || Array.isArray(payload)
            || Object.keys(payload).some((key) => !["id", "arguments", "values", "input"].includes(key))
            || typeof payload.id !== "string" || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(payload.id)
            || (payload.arguments !== undefined
              && (!payload.arguments || typeof payload.arguments !== "object" || Array.isArray(payload.arguments)))
            || (payload.values !== undefined
              && (!payload.values || typeof payload.values !== "object" || Array.isArray(payload.values)))
            || (payload.input !== undefined
              && (typeof payload.input !== "string" || payload.input.length === 0 || payload.input.length > 100_000))) {
          sendJson(response, 400, { error: "Invalid CLI action identifier." });
          return;
        }
        const dashboard = JSON.parse(dashboardContent);
        const action = dashboard.dashboard?.["cli-actions"]?.find((candidate) => candidate?.id === payload.id);
        if (!action || typeof action.command !== "string") {
          sendJson(response, 404, { error: "CLI action is not declared by this dashboard." });
          return;
        }
        const declaredArguments = Array.isArray(action.arguments) ? action.arguments : [];
        const suppliedArguments = payload.arguments ?? {};
        const templateFields = cliActionTemplateFields(action.command);
        const suppliedValues = payload.values ?? {};
        if (Object.keys(suppliedArguments).some((id) =>
          !declaredArguments.some((argument) => argument?.id === id)
          || typeof suppliedArguments[id] !== "boolean")) {
          sendJson(response, 400, { error: "Invalid CLI action arguments." });
          return;
        }
        if (Object.keys(suppliedValues).some((field) => !templateFields.includes(field))
            || templateFields.some((field) => typeof suppliedValues[field] !== "string")) {
          sendJson(response, 400, { error: "Invalid CLI action template values." });
          return;
        }
        let renderedCommand;
        try {
          renderedCommand = renderCliActionCommand(action.command, suppliedValues);
        } catch (error) {
          sendJson(response, 400, {
            error: error instanceof Error ? error.message : "Invalid CLI action template values.",
          });
          return;
        }
        const command = [
          renderedCommand,
          ...declaredArguments
            .filter((argument) => (
              suppliedArguments[argument.id] ?? argument.default === true
            ))
            .map((argument) => argument.flag),
        ].join(" ");
        const acceptsPromptInput = command === "gh agent-task create --from-file -";
        if ((payload.input !== undefined) !== acceptsPromptInput) {
          sendJson(response, 400, { error: "CLI action input is not valid for this command." });
          return;
        }
        response.writeHead(200, {
          "Cache-Control": "no-store",
          "Content-Type": "application/x-ndjson; charset=utf-8",
        });
        const emit = (event) => {
          if (!response.destroyed && !response.writableEnded) {
            response.write(`${JSON.stringify(event)}\n`);
          }
        };
        try {
          const result = await executeCliAction({
            id: action.id,
            command,
            ...(payload.input === undefined ? {} : { input: payload.input }),
            onOutput: ({ stream, data }) => emit({ type: "output", stream, data }),
          });
          emit({ type: "complete", result });
        } catch (error) {
          emit({
            type: "error",
            error: error instanceof Error ? error.message : "CLI action could not be executed.",
          });
        }
        response.end();
        return;
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        response.writeHead(405, { Allow: "GET, HEAD" }).end();
        return;
      }
      if (pathname === "/") pathname = "/index.html";
      if (pathname === "/sources.json") {
        if (sourcesContent === undefined) {
          response.writeHead(404).end("Not found\n");
          return;
        }
        sendContent(request, response, contentTypes.get(".json"), sourcesContent);
        return;
      }
      if (dashboardDataShards.has(pathname)) {
        await sendFileContent(
          request,
          response,
          contentTypes.get(".jsonl"),
          dashboardDataShards.get(pathname),
        );
        return;
      }
      if (pathname === "/payload-hashes.json") {
        if (payloadHashesContent === undefined) {
          response.writeHead(404).end("Not found\n");
          return;
        }
        sendContent(request, response, contentTypes.get(".json"), payloadHashesContent);
        return;
      }
      if (pathname === "/inventory-sources.json") {
        if (inventorySourcesContent === undefined) {
          response.writeHead(404).end("Not found\n");
          return;
        }
        sendContent(request, response, contentTypes.get(".json"), inventorySourcesContent);
        return;
      }
      if (dashboardPageChunkContent.has(pathname)) {
        sendContent(request, response, contentTypes.get(".json"), dashboardPageChunkContent.get(pathname));
        return;
      }
      if (pathname === "/sources/manifest.json") {
        if (sourceManifestContent === undefined) {
          response.writeHead(404).end("Not found\n");
          return;
        }
        sendContent(request, response, contentTypes.get(".json"), sourceManifestContent);
        return;
      }
      const splitSourceMatch = pathname.match(/^\/sources\/([a-z0-9-]+)\.json$/);
      if (splitSourceMatch) {
        const content = splitSourceContent.get(splitSourceMatch[1]);
        if (content === undefined) {
          response.writeHead(404).end("Not found\n");
          return;
        }
        sendContent(request, response, contentTypes.get(".json"), content);
        return;
      }
      const candidate = resolve(resolvedSiteRoot, `.${pathname}`);
      if (!isWithin(resolvedSiteRoot, candidate)) {
        response.writeHead(404).end("Not found\n");
        return;
      }

      let filePath = candidate;
      let metadata = await stat(filePath).catch(() => null);
      if (metadata?.isDirectory()) {
        filePath = join(filePath, "index.html");
        metadata = await stat(filePath).catch(() => null);
      }
      if (!metadata?.isFile()) {
        response.writeHead(404).end("Not found\n");
        return;
      }
      const extension = extname(filePath).toLowerCase();
      if (!contentTypes.has(extension)) {
        output("Refused unsupported dashboard file type.", { extension: extension || null });
        response.writeHead(404).end("Not found\n");
        return;
      }
      const canonicalFilePath = await realpath(filePath);
      if (!isWithin(resolvedSiteRoot, canonicalFilePath)) {
        response.writeHead(404).end("Not found\n");
        return;
      }

      let content;
      if (pathname === "/dashboard.json") content = dashboardContent;
      else content = browserSafeFileContent(canonicalFilePath, await readFile(canonicalFilePath));
      sendContent(request, response, contentTypes.get(extension), content);
    } catch (error) {
      output(`Dashboard request failed: ${error instanceof Error ? error.message : String(error)}`);
      if (!response.headersSent) response.writeHead(500);
      response.end("Internal server error\n");
    }
  });
  server.on("upgrade", (request, socket) => {
    const key = request.headers["sec-websocket-key"];
    if (!expectedAuthority
        || !isAllowedHost(request.headers.host)
        || (!request.headers.origin && !allowMissingOrigin)
        || (request.headers.origin && !isAllowedOrigin(request.headers.origin))
        || request.url !== socketPath
        || request.headers.upgrade?.toLowerCase() !== "websocket"
        || request.headers["sec-websocket-version"] !== "13"
        || typeof key !== "string"
        || Buffer.from(key, "base64").length !== 16) {
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      return;
    }
    const accept = createHash("sha1")
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write([
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "\r\n",
    ].join("\r\n"));
    sockets.add(socket);
    output("Dashboard preview socket connected.", { socketCount: sockets.size });
    let incoming = Buffer.alloc(0);
    let removed = false;
    const remove = () => {
      if (removed) return;
      removed = true;
      sockets.delete(socket);
      output("Dashboard preview socket disconnected.", { socketCount: sockets.size });
    };
    socket.on("data", (data) => {
      try {
        incoming = Buffer.concat([incoming, data]);
        const parsed = readWebsocketFrames(incoming);
        incoming = parsed.remaining;
        for (const frame of parsed.messages) {
          if (frame.opcode === 0x8) {
            if (!socket.writableEnded) socket.end(websocketCloseFrame());
          } else if (frame.opcode === 0x9) {
            socket.write(websocketPongFrame(frame.payload));
          } else {
            throw new Error("Unsupported WebSocket opcode.");
          }
        }
      } catch (error) {
        output("Dashboard preview socket command failed.", errorMetadata(error));
        socket.end(websocketCloseFrame());
      }
    });
    socket.on("close", remove);
    socket.on("error", remove);
    socket.resume();
  });

  try {
    await new Promise((accept, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          reject(new Error("dashboard server did not bind to a TCP port"));
          return;
        }
        expectedAuthority = `${address.address.includes(":") ? `[${address.address}]` : address.address}:${address.port}`;
        if (isLoopbackHost(address.address)) {
          localhostAuthority = `localhost:${address.port}`;
        }
        if (process.env.CODESPACES === "true" && process.env.CODESPACE_NAME
            && process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN) {
          codespaceAuthority = `${process.env.CODESPACE_NAME}-${address.port}.${process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN}`;
        }
        output("Dashboard server listening.", {
          authority: expectedAuthority,
          ...(localhostAuthority ? { localhostAuthority } : {}),
          ...(codespaceAuthority ? { codespaceAuthority } : {}),
        });
        trace.record("server", "server.ready", {
          details: {
            authority: expectedAuthority,
            traceFile: resolvedTraceFile,
          },
        });
        accept();
      });
    });
  } catch (error) {
    for (const watcher of watchers.values()) watcher.close();
    await rm(temporaryDirectory, { recursive: true, force: true });
    throw error;
  }
  return {
    url: `http://${expectedAuthority}${routePrefix}`,
    ...(codespaceAuthority ? { codespaceUrl: `https://${codespaceAuthority}${routePrefix}` } : {}),
    async close() {
      if (closed) return;
      closed = true;
      output("Stopping dashboard server.");
      clearTimeout(refreshTimer);
      for (const watcher of watchers.values()) watcher.close();
      for (const socket of sockets) socket.end(websocketCloseFrame());
      await new Promise((accept, reject) => server.close((error) => error ? reject(error) : accept()));
      await refreshPromise;
      await rm(temporaryDirectory, { recursive: true, force: true });
      trace.record("server", "server.stopped");
      await trace.flush();
      output("Dashboard server stopped.");
    },
  };
}

function parseArguments(arguments_) {
  const options = {};
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--help") return { help: true };
    if (argument === "--canvas") options.canvas = true;
    else if (argument === "--replace-existing") options.replaceExisting = true;
    else if (argument === "--trace-file") {
      options.traceFile = arguments_[index += 1];
      if (!options.traceFile) throw new Error("--trace-file requires a value");
    }
    else if (argument === "--host") {
      options.host = arguments_[index += 1];
      if (!options.host) throw new Error("--host requires a value");
    }
    else if (argument === "--port") options.port = Number(arguments_[index += 1]);
    else if (argument === "--repo") {
      options.repository = arguments_[index += 1];
      if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(options.repository || "")) {
        throw new Error("--repo must be an OWNER/REPOSITORY name");
      }
    }
    else throw new Error(`unknown argument: ${argument}`);
  }
  if (!options.host) options.host = "127.0.0.1";
  const port = options.port ?? (options.canvas ? 0 : 4173);
  const minimumPort = options.canvas ? 0 : 1;
  if (!Number.isInteger(port) || port < minimumPort || port > 65535) {
    throw new Error(
      `--port must be an integer from ${minimumPort} through 65535`,
    );
  }
  if (options.replaceExisting && options.canvas) {
    throw new Error("--replace-existing cannot be used with --canvas");
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log("usage: local-server.mjs [--canvas] [--replace-existing] [--trace-file PATH] [--repo OWNER/REPOSITORY] [--host HOST] [--port PORT]");
    return;
  }
  const workingDirectory = await realpath(process.cwd());
  const port = options.port ?? (options.canvas ? 0 : 4173);
  let pidFile;
  if (options.replaceExisting) {
    pidFile = await replaceExistingDashboardDevServer({ workingDirectory, port });
  }
  let preview;
  try {
    preview = await startDashboardServer(options);
  } catch (error) {
    await releaseDashboardDevServerPid(pidFile);
    throw error;
  }
  if (options.canvas) {
    console.log(`CAO_CANVAS_READY ${preview.url}/`);
  } else {
    console.log(`Dashboard preview: ${preview.url}/`);
    if (preview.codespaceUrl) {
      console.log(`Dashboard preview (Codespace): ${preview.codespaceUrl}/`);
    }
  }
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    void preview.close()
      .then(() => releaseDashboardDevServerPid(pidFile))
      .then(() => process.exit());
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch((error) => {
    console.log(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
