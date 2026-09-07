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
import { existsSync, watch } from "node:fs";
import { createRequire } from "node:module";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
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
import { bundleDashboardFiles } from "./report/bundle-dashboards.mjs";
import { validateDashboardDocument } from "./site/src/validator.js";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const executeFile = promisify(execFile);
const defaultCatalogRoot = basename(resolve(scriptDirectory, "..", "..")) === ".github"
  ? null
  : resolve(scriptDirectory, "..");
const socketEndpoint = "/__dashboard_socket";
const dataArtifactName = "central-agentic-ops-dashboard-data";
const devServerPidFileName = ".cao-dashboard-dev-server.json";
const maxCopilotDashboardRepairAttempts = 3;
const trustedDashboardWorkflowPaths = new Set([
  ".github/workflows/dashboard-build.yml",
  ".github/workflows/dashboard.yml",
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
  [".md", "text/markdown; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"],
]);
const redactedTextExtensions = new Set([".css", ".html", ".js", ".md", ".mjs", ".svg"]);

async function existingDirectories(paths) {
  const directories = [];
  for (const path of paths) {
    const entry = await stat(path).catch(() => null);
    if (entry?.isDirectory()) directories.push(path);
  }
  return directories;
}

export async function repositorySkillDirectories(workingDirectory) {
  return existingDirectories([
    join(workingDirectory, ".github", "skills"),
    join(workingDirectory, ".agents", "skills"),
  ]);
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

async function dashboardSourceForView(view, dashboardPaths) {
  for (const path of dashboardPaths) {
    try {
      const document = JSON.parse(await readFile(path, "utf8"));
      const matches = document?.dashboard?.pages?.some((page) =>
        [page?.id, page?.title, page?.["navigation-label"]].includes(view));
      if (matches) return path;
    } catch (error) {
      console.log("Unable to inspect dashboard source for Copilot.", {
        path,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return dashboardPaths[0];
}

async function packageDashboardPaths(catalogRoot, installedDashboardsDirectory) {
  const paths = [];
  const installed = await readdir(installedDashboardsDirectory, { withFileTypes: true }).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  for (const entry of installed) {
    if (entry.isFile() && entry.name.endsWith(".json")) {
      paths.push(join(installedDashboardsDirectory, entry.name));
    }
  }

  if (catalogRoot) {
    const catalogEntries = await readdir(catalogRoot, { withFileTypes: true }).catch((error) => {
      if (error?.code === "ENOENT") return [];
      throw error;
    });
    for (const entry of catalogEntries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const path = join(catalogRoot, entry.name, "dashboard.json");
      if ((await stat(path).catch(() => null))?.isFile()) paths.push(path);
    }
  }
  return [...new Set(paths)].toSorted();
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

function normalizeDashboardJson(source) {
  return JSON.stringify(JSON.parse(source), null, 2);
}

function formatDashboardValidationErrors(errors) {
  return errors
    .map((error) => `${error.code} at ${error.path}: ${error.message}`)
    .join("\n");
}

function validateDashboardSource(source) {
  const result = validateDashboardDocument(source);
  if (result.ok) return;
  throw new Error(`Dashboard validation failed:\n${formatDashboardValidationErrors(result.errors)}`);
}

const copilotReadOnlyShellCommands = new Set([
  "basename",
  "cat",
  "cut",
  "dirname",
  "du",
  "echo",
  "file",
  "grep",
  "head",
  "jq",
  "ls",
  "pwd",
  "readlink",
  "realpath",
  "rg",
  "sed",
  "stat",
  "tail",
  "tr",
  "uniq",
  "wc",
]);

function shellCommandDetails(permission) {
  return {
    commands: permission.commands.map((command) => ({
      identifier: command.identifier,
      readOnly: command.readOnly,
    })),
    commandSegments: (permission.commandSegments ?? []).map((segment) => ({
      identifier: segment.identifier,
      command: truncatedLogText(segment.fullCommandText, 300),
    })),
  };
}

function shellCommandIdentifiers(permission) {
  const segmentIdentifiers = (permission.commandSegments ?? [])
    .map((segment) => segment.identifier)
    .filter(Boolean);
  return segmentIdentifiers.length > 0
    ? segmentIdentifiers
    : permission.commands.map((command) => command.identifier);
}

function shellAbsolutePaths(permission) {
  const commandPaths = permission.fullCommandText.match(/\/[^\s"'|;&<>]+/g) ?? [];
  return [...new Set([...permission.possiblePaths, ...commandPaths])];
}

export function shellPermissionRejection(permission) {
  if (permission.hasWriteFileRedirection || /[<>]/.test(permission.fullCommandText)) {
    return "shell command uses redirection";
  }
  if (permission.possibleUrls.length > 0) return "shell command may access a URL";
  const identifiers = shellCommandIdentifiers(permission);
  if (identifiers.length === 0) return "shell command could not be classified";
  if (identifiers.includes("sed")) {
    if (/(?:^|\s)(?:-i(?:\S*)?|--in-place(?:=\S*)?)(?:\s|$)/.test(permission.fullCommandText)) {
      return "sed in-place editing is not allowed";
    }
    if (/(?:^|\s)(?:-f|--file)(?:\s|=|$)/.test(permission.fullCommandText)) {
      return "sed script files are not allowed";
    }
    if (/(?:^|[;/'"\s])(?:e|w|W)(?:\s|['"]|$)/.test(permission.fullCommandText)) {
      return "sed execute and file-writing commands are not allowed";
    }
  }
  const deniedIdentifiers = identifiers.filter((identifier) =>
    !copilotReadOnlyShellCommands.has(identifier));
  if (deniedIdentifiers.length > 0) {
    return `shell command not allowed: ${deniedIdentifiers.join(", ")}`;
  }
  return null;
}

function dashboardPageIndex(document, view) {
  return document?.dashboard?.pages?.findIndex((page) =>
    [page?.id, page?.title, page?.["navigation-label"]].includes(view)) ?? -1;
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

function redactedLogValue(value) {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(redactJsonSecrets(JSON.stringify(value)));
  } catch {
    return "[unserializable]";
  }
}

function truncatedLogText(value, maximumLength = 1000) {
  if (typeof value !== "string") return undefined;
  const redacted = redactSecretValues(value);
  return redacted.length <= maximumLength
    ? redacted
    : `${redacted.slice(0, maximumLength)}… [truncated ${redacted.length - maximumLength} chars]`;
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
        || argument.endsWith("/dashboard/local-server.mjs")
        || argument.endsWith("/.github/aw/dashboard/local-server.mjs"));
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

function resolveCopilotCliPath() {
  const arch = process.arch;
  const variants = process.platform === "linux" ? ["linux", "linuxmusl"] : [process.platform];
  const req = createRequire(import.meta.url);
  const searchPaths = req.resolve.paths("@github/copilot") ?? [];
  for (const base of searchPaths) {
    for (const variant of variants) {
      const candidate = join(base, "@github", `copilot-${variant}-${arch}`, "index.js");
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

async function startCopilotRuntime({ workingDirectory, copilotExecutable }) {
  console.log("Loading Copilot SDK runtime.", { workingDirectory });
  let sdk;
  try {
    sdk = await import("@github/copilot-sdk");
  } catch {
    console.log("Copilot SDK runtime is unavailable. Install @github/copilot-sdk.");
    throw new Error("Copilot mode requires @github/copilot-sdk.");
  }
  const cliPath = copilotExecutable || resolveCopilotCliPath();
  const { CopilotClient, defineTool, RuntimeConnection } = sdk;
  const client = new CopilotClient({
    connection: RuntimeConnection.forTcp({
      ...(cliPath ? { path: cliPath } : {}),
    }),
    workingDirectory,
    logLevel: "debug",
  });
  try {
    console.log("Starting Copilot headless server.");
    await client.start();
  } catch (error) {
    console.log("Copilot headless server failed to start.", errorMetadata(error));
    await client.stop().catch((stopError) => {
      console.log("Copilot cleanup after startup failure failed.", errorMetadata(stopError));
    });
    throw error;
  }
  console.log("Copilot headless server started.");
  const skillDirectories = await repositorySkillDirectories(workingDirectory);
  console.log("Configured Copilot repository skills.", { skillDirectories });

  const sessions = new Map();
  return {
    async prompt({
      sessionKey,
      view,
      request,
      bundledDashboardPath,
      editableDashboardPaths,
      viewDashboardPath,
      onEvent = () => {},
      signal,
    }) {
      let entry = sessions.get(sessionKey);
      const context = entry?.context ?? {};
      Object.assign(context, {
        view,
        bundledDashboardPath,
        editableDashboardPaths,
        viewDashboardPath,
        onEvent,
        aborted: false,
      });
      console.log(entry ? "Reusing Copilot dashboard session." : "Creating Copilot dashboard session.", {
        sessionKey,
        sessionId: entry?.session.sessionId,
        view,
        bundledDashboardPath,
        viewDashboardPath,
        editableDashboardPaths,
      });
      const stringParameter = (description) => ({
        type: "string",
        description,
      });
      const readViewDocument = async () => {
        const document = JSON.parse(await readFile(context.viewDashboardPath, "utf8"));
        const pageIndex = dashboardPageIndex(document, context.view);
        if (pageIndex < 0) throw new Error("The selected dashboard view no longer exists.");
        return { document, pageIndex };
      };
      const validateViewCandidate = async (source) => {
        const candidate = JSON.parse(source);
        const { document, pageIndex } = await readViewDocument();
        const currentPage = document.dashboard.pages[pageIndex];
        if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
          throw new Error("Dashboard page must be a JSON object.");
        }
        if (candidate.id !== currentPage.id) {
          throw new Error("Dashboard page id cannot change.");
        }
        document.dashboard.pages[pageIndex] = candidate;
        const normalized = JSON.stringify(document, null, 2);
        validateDashboardSource(normalized);
        return { candidate, document, pageIndex, normalized };
      };
      const validateDashboardJson = async () => {
        const source = await readFile(context.viewDashboardPath, "utf8");
        const result = validateDashboardDocument(source);
        return {
          ok: result.ok,
          path: context.viewDashboardPath,
          errors: result.ok ? [] : result.errors,
        };
      };
      const tools = [
        defineTool("read_dashboard_language_reference", {
          description: "Read the canonical Dashboard Language vocabulary used by the local renderer.",
          parameters: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
          skipPermission: true,
          defer: "never",
          handler: async () => {
            const referencePath = join(scriptDirectory, "site", "src", "specification.js");
            const source = await readFile(referencePath, "utf8");
            console.log("Read Dashboard Language reference for Copilot.", {
              path: referencePath,
              bytes: Buffer.byteLength(source),
            });
            return source;
          },
        }),
        defineTool("read_current_dashboard_view", {
          description: "Read only the current dashboard page that the user asked to modify.",
          parameters: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
          skipPermission: true,
          defer: "never",
          handler: async () => {
            const { document, pageIndex } = await readViewDocument();
            const source = JSON.stringify(document.dashboard.pages[pageIndex], null, 2);
            console.log("Read current dashboard view for Copilot.", {
              path: context.viewDashboardPath,
              view: context.view,
              bytes: Buffer.byteLength(source),
            });
            return source;
          },
        }),
        defineTool("validate_current_dashboard_view", {
          description: "Validate the complete candidate JSON object for the current dashboard page.",
          parameters: {
            type: "object",
            properties: { source: stringParameter("Complete candidate dashboard page JSON object.") },
            required: ["source"],
            additionalProperties: false,
          },
          skipPermission: true,
          defer: "never",
          handler: async ({ source }) => {
            try {
              await validateViewCandidate(source);
              console.log("Validated Copilot dashboard view candidate.", {
                view: context.view,
                bytes: Buffer.byteLength(source),
              });
              return { ok: true };
            } catch (error) {
              console.log("Rejected invalid Copilot dashboard view candidate.", errorMetadata(error));
              return {
                ok: false,
                error: error instanceof Error ? error.message : "Dashboard page must be valid JSON.",
              };
            }
          },
        }),
        defineTool("validate_dashboard_json", {
          description: "Run the existing dashboard validator.js against the selected dashboard.json.",
          parameters: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
          skipPermission: true,
          defer: "never",
          handler: async () => {
            const result = await validateDashboardJson();
            console.log("Ran dashboard validator for Copilot.", {
              path: context.viewDashboardPath,
              ok: result.ok,
              errorCount: result.errors.length,
            });
            return result;
          },
        }),
        defineTool("save_current_dashboard_view", {
          description: "Save the complete validated JSON object for the current dashboard page.",
          parameters: {
            type: "object",
            properties: { source: stringParameter("Complete validated dashboard page JSON object.") },
            required: ["source"],
            additionalProperties: false,
          },
          skipPermission: true,
          defer: "never",
          handler: async ({ source }) => {
            try {
              const { candidate, document, pageIndex, normalized } = await validateViewCandidate(source);
              document.dashboard.pages[pageIndex] = candidate;
              await writeFile(context.viewDashboardPath, normalized);
              console.log("Saved normalized Copilot dashboard view.", {
                path: context.viewDashboardPath,
                view: context.view,
                bytes: Buffer.byteLength(normalized),
              });
              return { ok: true };
            } catch (error) {
              console.log("Rejected invalid Copilot dashboard view save.", {
                path: context.viewDashboardPath,
                ...errorMetadata(error),
              });
              return {
                ok: false,
                error: error instanceof Error ? error.message : "Dashboard page must be valid JSON.",
              };
            }
          },
        }),
      ];
      let session = entry?.session;
      const toolExecutions = new Map();
      const handleSessionEvent = (event) => {
        const sessionId = session?.sessionId;
        if (event.type === "session.skills_loaded") {
          const skills = event.data.skills
            .filter((skill) => skill.enabled)
            .map((skill) => skill.commandName || skill.name);
          console.log("Copilot dashboard skills loaded.", { skills });
          context.onEvent({
            type: "status",
            message: skills.includes("generate-dashboard-ir")
              ? "Dashboard authoring skill loaded."
              : "Repository skills loaded.",
          });
        } else if (event.type === "skill.invoked") {
          console.log("Copilot dashboard skill invoked.", {
            name: event.data.name,
            path: event.data.path,
            source: event.data.source,
          });
          context.onEvent({ type: "status", message: `Using /${event.data.name}…` });
        } else if (event.type === "assistant.message_delta") {
          context.onEvent({ type: "assistant-delta", content: event.data.deltaContent });
        } else if (event.type === "assistant.message") {
          context.onEvent({ type: "assistant-message", content: event.data.content });
        } else if (event.type === "assistant.reasoning_delta") {
          context.onEvent({
            type: "reasoning-delta",
            content: event.data.deltaContent,
            reasoningId: event.data.reasoningId,
          });
        } else if (event.type === "assistant.reasoning") {
          context.onEvent({
            type: "reasoning-message",
            content: event.data.content,
            reasoningId: event.data.reasoningId,
          });
        } else if (event.type === "tool.execution_start") {
          toolExecutions.set(event.data.toolCallId, {
            name: event.data.toolName,
            startedAt: performance.now(),
          });
          console.log("Copilot tool execution started.", {
            sessionId,
            toolCallId: event.data.toolCallId,
            toolName: event.data.toolName,
            arguments: redactedLogValue(event.data.arguments),
            shell: event.data.shellToolInfo
              ? {
                  hasWriteFileRedirection: event.data.shellToolInfo.hasWriteFileRedirection,
                  possiblePaths: event.data.shellToolInfo.possiblePaths,
                }
              : undefined,
          });
          context.onEvent({ type: "status", message: `Running ${event.data.toolName}…` });
        } else if (event.type === "tool.execution_complete") {
          const execution = toolExecutions.get(event.data.toolCallId);
          toolExecutions.delete(event.data.toolCallId);
          const shellExit = event.data.result?.contents?.find((content) =>
            content.type === "shell_exit" || content.type === "terminal");
          console.log("Copilot tool execution completed.", {
            sessionId,
            toolCallId: event.data.toolCallId,
            toolName: execution?.name ?? event.data.toolDescription?.name,
            success: event.data.success,
            durationMs: execution
              ? Math.max(0, Math.round(performance.now() - execution.startedAt))
              : undefined,
            sandboxed: event.data.sandboxed,
            error: event.data.error
              ? {
                  code: event.data.error.code,
                  message: truncatedLogText(event.data.error.message),
                }
              : undefined,
            shellExit: shellExit
              ? {
                  exitCode: shellExit.exitCode,
                  cwd: shellExit.cwd,
                  output: truncatedLogText(
                    shellExit.type === "shell_exit" ? shellExit.outputPreview : shellExit.text,
                  ),
                  outputTruncated: shellExit.type === "shell_exit"
                    ? shellExit.outputTruncated
                    : undefined,
                }
              : undefined,
            result: truncatedLogText(
              event.data.result?.detailedContent ?? event.data.result?.content,
            ),
            telemetry: redactedLogValue(event.data.toolTelemetry),
          });
          context.onEvent({
            type: "status",
            message: event.data.success
              ? "Applying dashboard update…"
              : "Copilot is retrying after a tool error…",
          });
        } else if (event.type === "permission.requested") {
          console.log("Copilot permission requested.", {
            sessionId,
            requestId: event.data.requestId,
            resolved: event.data.resolved,
            permission: event.data.permissionRequest.kind === "shell"
              ? {
                  ...redactedLogValue(event.data.permissionRequest),
                  ...shellCommandDetails(event.data.permissionRequest),
                }
              : redactedLogValue(event.data.permissionRequest),
            riskAssessment: redactedLogValue(event.data.riskAssessment),
          });
        } else if (event.type === "permission.completed") {
          console.log("Copilot permission completed.", {
            sessionId,
            requestId: event.data.requestId,
            toolCallId: event.data.toolCallId,
            result: redactedLogValue(event.data.result),
          });
        } else if (event.type === "session.error") {
          console.log("Copilot dashboard session error.", {
            sessionId,
            error: redactedLogValue(event.data),
          });
          context.onEvent({
            type: "status",
            message: "Copilot reported a session issue; checking the saved dashboard…",
          });
          context.onEvent({
            type: "debug",
            message: "Copilot SDK session reported an error.",
            details: {
              name: event.data.name,
              code: event.data.code,
              message: truncatedLogText(event.data.message),
            },
          });
        } else if (event.type === "session.idle" && event.data.aborted) {
          context.aborted = true;
        }
      };
      if (!entry) try {
        const workspaceRoot = await canonicalPath(workingDirectory);
        const temporaryRoot = await canonicalPath(tmpdir());
        const workspacePath = (path) => canonicalPath(
          isAbsolute(path) ? path : join(workspaceRoot, path),
        );
        session = await client.createSession({
          workingDirectory,
          enableSkills: true,
          streaming: true,
          skillDirectories,
          availableTools: [
            "builtin:skill",
            "builtin:task_complete",
            "builtin:view",
            "builtin:edit",
            "builtin:create",
            "builtin:grep",
            "builtin:bash",
            "custom:read_dashboard_language_reference",
            "custom:read_current_dashboard_view",
            "custom:validate_current_dashboard_view",
            "custom:validate_dashboard_json",
            "custom:save_current_dashboard_view",
          ],
          tools,
          onPermissionRequest: async (permission) => {
            let decision = {
              kind: "reject",
              feedback: "This session permits file reads and writes in the workspace and temporary directory, plus common safe shell commands.",
            };
            let reason = "unsupported permission kind";
            try {
              if (permission.requestSandboxBypass) {
                reason = "sandbox bypass requested";
              } else if (permission.managedApprovalRequired) {
                reason = "managed policy requires human approval";
              } else if (permission.kind === "read") {
                const requestedPath = await workspacePath(permission.path);
                if (isWithinCopilotFileRoots(workspaceRoot, temporaryRoot, requestedPath)) {
                  decision = { kind: "approve-once" };
                  reason = isWithin(temporaryRoot, requestedPath) ? "temporary directory read" : "workspace read";
                } else {
                  reason = "read path is outside workspace and temporary directory";
                }
              } else if (permission.kind === "write") {
                const requestedPath = await workspacePath(permission.fileName);
                if (isWithinCopilotFileRoots(workspaceRoot, temporaryRoot, requestedPath)) {
                  decision = { kind: "approve-once" };
                  reason = isWithin(temporaryRoot, requestedPath) ? "temporary directory write" : "workspace write";
                } else {
                  reason = "write path is outside workspace and temporary directory";
                }
              } else if (permission.kind === "shell") {
                const rejection = shellPermissionRejection(permission);
                if (rejection) {
                  reason = rejection;
                } else {
                  const possiblePaths = await Promise.all(
                    shellAbsolutePaths(permission).map(workspacePath),
                  );
                  if (possiblePaths.every((path) =>
                    isWithinCopilotFileRoots(workspaceRoot, temporaryRoot, path))) {
                    decision = { kind: "approve-once" };
                    reason = "allowlisted safe shell command";
                  } else {
                    reason = "shell path is outside workspace and temporary directory";
                  }
                }
              }
            } catch (error) {
              reason = `permission path resolution failed: ${error instanceof Error ? error.message : String(error)}`;
            }
            console.log("Copilot permission decision.", {
              sessionId: session?.sessionId,
              toolCallId: permission.toolCallId,
              kind: permission.kind,
              decision: decision.kind,
              reason: truncatedLogText(reason),
              permission: permission.kind === "shell"
                ? {
                    ...redactedLogValue(permission),
                    ...shellCommandDetails(permission),
                    resolvedPaths: shellAbsolutePaths(permission),
                  }
                : redactedLogValue(permission),
            });
            if (decision.kind === "reject") {
              const tool = permission.kind === "shell"
                ? shellCommandIdentifiers(permission).join(" | ") || "bash"
                : permission.kind;
              context.onEvent({
                type: "tool-refused",
                message: `Refused ${tool}: ${reason}.`,
                details: { tool, reason },
              });
            }
            return decision;
          },
          onEvent: handleSessionEvent,
        });
      } catch (error) {
        console.log("Copilot dashboard session creation failed.", errorMetadata(error));
        throw error;
      }
      if (!entry) {
        entry = { session, context };
        sessions.set(sessionKey, entry);
      }
      console.log("Copilot dashboard session ready.", {
        sessionKey,
        sessionId: session.sessionId,
        view,
      });
      const stopOnAbort = () => {
        context.aborted = true;
        console.log("Stopping active Copilot dashboard turn.", {
          sessionKey,
          sessionId: session.sessionId,
        });
        void session.abort().catch((error) => {
          console.log("Copilot dashboard turn abort failed.", {
            sessionId: session.sessionId,
            ...errorMetadata(error),
          });
        });
      };
      signal?.addEventListener("abort", stopOnAbort, { once: true });
      try {
        if (signal?.aborted) {
          stopOnAbort();
          return { aborted: true };
        }
        console.log("Sending Copilot dashboard request.", {
          sessionId: session.sessionId,
          view,
          requestLength: request.length,
        });
        try {
          await session.sendAndWait({
            prompt: `Use the /generate-dashboard-ir skill to update the current dashboard view named ${JSON.stringify(view)}.

Apply this request: ${request}

The composed preview dashboard is ${JSON.stringify(bundledDashboardPath)}. It is a generated temporary file and is provided only for context; do not read or edit it.
The original dashboard source most likely defining this view is ${JSON.stringify(viewDashboardPath)}.
The complete set of editable original dashboard sources is:
${editableDashboardPaths.map((path) => `- ${path}`).join("\n")}

Built-in views come from the site's dashboard.json. Package views come from their package dashboard.json source (for an installed control repository, under .github/aw/dashboards; for this catalog, in the matching top-level package directory). Only JSON dashboard changes are supported. You may inspect files in the workspace, search with grep, and use common safe shell commands to understand existing data, conventions, and related dashboards. Read, write, and shell access are available in the workspace and under ${JSON.stringify(tmpdir())}; use the temporary directory only for disposable intermediate files. Modify application state only through the selected dashboard.json. Use read_dashboard_language_reference when language vocabulary is needed, then use read_current_dashboard_view and validate_current_dashboard_view to inspect and validate the selected page. Prefer save_current_dashboard_view for the final write, then run validate_dashboard_json. Do not finish until validate_dashboard_json returns ok: true.

JavaScript, HTML, CSS, and all other application files are outside this session's scope. Do not propose or attempt changes to them because they require a full application reload; make the requested improvement only through the selected dashboard.json page.

After saving the validated dashboard page, respond with a short, plain-language summary of what changed in the dashboard and what the user will now see. Avoid implementation details, JSON field names, schema terminology, file paths, and developer-oriented language. Complete the edit rather than only describing it.`,
          });
        } catch (error) {
          if (context.aborted) return { aborted: true };
          console.log("Copilot dashboard session request failed.", {
            sessionId: session.sessionId,
            view,
            ...errorMetadata(error),
          });
          throw error;
        }
        for (let repairAttempt = 1; ; repairAttempt += 1) {
          if (context.aborted) return { aborted: true };
          const savedSource = await readFile(viewDashboardPath, "utf8");
          const validation = validateDashboardDocument(savedSource);
          if (validation.ok) {
            onEvent({
              type: "status",
              message: repairAttempt === 1
                ? "Dashboard validation passed."
                : "Dashboard repaired and validation passed.",
            });
            break;
          }
          const validationErrors = formatDashboardValidationErrors(validation.errors);
          console.log("Copilot dashboard validation failed; continuing the session for repair.", {
            sessionId: session.sessionId,
            view,
            repairAttempt,
            errorCount: validation.errors.length,
          });
          onEvent({
            type: "status",
            message: "Dashboard validation failed. Copilot is fixing it…",
          });
          onEvent({
            type: "debug",
            message: "Authoritative dashboard validation failed; continuing the same Copilot session.",
            details: {
              view,
              repairAttempt,
              errorCount: validation.errors.length,
            },
          });
          if (repairAttempt > maxCopilotDashboardRepairAttempts) {
            throw new Error(
              `Dashboard validation still failed after ${maxCopilotDashboardRepairAttempts} repair attempts:\n${validationErrors}`,
            );
          }
          try {
            await session.sendAndWait({
              prompt: `The saved dashboard.json did not pass the authoritative Dashboard Language validator.

Continue this same editing session and fix the current view. Use read_current_dashboard_view, then validate_current_dashboard_view and save_current_dashboard_view. Do not only describe the fix.

Validation errors:
${validationErrors}`,
            });
          } catch (error) {
            if (context.aborted) return { aborted: true };
            console.log("Copilot dashboard repair request failed.", {
              sessionId: session.sessionId,
              view,
              repairAttempt,
              ...errorMetadata(error),
            });
            throw error;
          }
        }
        console.log("Copilot dashboard request completed.", { sessionId: session.sessionId, view });
        return { aborted: context.aborted };
      } finally {
        signal?.removeEventListener("abort", stopOnAbort);
        context.onEvent = () => {};
      }
    },
    async stop(sessionKey) {
      const entry = sessions.get(sessionKey);
      if (!entry) return false;
      entry.context.aborted = true;
      await entry.session.abort();
      return true;
    },
    async disconnect(sessionKey) {
      const entry = sessions.get(sessionKey);
      if (!entry) return false;
      sessions.delete(sessionKey);
      entry.context.aborted = true;
      console.log("Disconnecting WebSocket Copilot dashboard session.", {
        sessionKey,
        sessionId: entry.session.sessionId,
      });
      await entry.session.abort().catch(() => {});
      await entry.session.disconnect();
      return true;
    },
    async close() {
      await Promise.all([...sessions.keys()].map(async (sessionKey) => {
        await this.disconnect(sessionKey);
      }));
      const errors = await client.stop();
      for (const error of errors) console.log("Copilot shutdown error.", errorMetadata(error));
    },
  };
}

function isWithin(root, candidate) {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

export function isWithinCopilotFileRoots(workspaceRoot, temporaryRoot, candidate) {
  return isWithin(workspaceRoot, candidate) || isWithin(temporaryRoot, candidate);
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
 *   installedDashboardsDirectory?: string,
 *   repository?: string,
 *   ghExecutable?: string,
 *   downloadData?: (destination: string, repository?: string, ghExecutable?: string) => Promise<void>,
 *   copilot?: boolean,
 *   copilotExecutable?: string,
 *   createCopilotRuntime?: typeof startCopilotRuntime,
 *   traceFile?: string,
 *   traceOutput?: (message: string) => void,
 *   requestOutput?: (message: string) => void,
 *   workingDirectory?: string,
 *   host?: string,
 *   port?: number,
 * }} options
 */
export async function startDashboardServer({
  siteRoot = join(scriptDirectory, "site"),
  catalogRoot = defaultCatalogRoot,
  installedDashboardsDirectory = resolve(scriptDirectory, "..", "dashboards"),
  repository,
  ghExecutable = "gh",
  downloadData = downloadDashboardData,
  copilot = false,
  copilotExecutable,
  allowMissingOrigin = false,
  createCopilotRuntime = startCopilotRuntime,
  traceFile,
  traceOutput = console.log,
  requestOutput = console.log,
  workingDirectory = process.cwd(),
  host = "127.0.0.1",
  port = 4173,
} = {}) {
  if (copilot && !isLoopbackHost(host)) {
    console.log("Copilot mode configuration rejected.", {
      reason: "host is not loopback",
      host,
    });
    throw new Error("Copilot mode requires a loopback --host such as 127.0.0.1 or ::1.");
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
  const resolvedInstalledDashboardsDirectory = await canonicalPath(installedDashboardsDirectory);
  if (!isWithin(resolvedWorkingDirectory, resolvedSiteRoot)
      || (resolvedCatalogRoot && !isWithin(resolvedWorkingDirectory, resolvedCatalogRoot))
      || !isWithin(resolvedWorkingDirectory, resolvedInstalledDashboardsDirectory)) {
    console.log("Dashboard server configuration rejected.", {
      reason: "dashboard path is outside the workspace",
    });
    throw new Error("Dashboard server paths must remain within the workspace.");
  }
  const baseDashboardPath = join(resolvedSiteRoot, "dashboard.json");
  const temporaryDirectory = await mkdtemp(join(resolvedWorkingDirectory, ".cao-dashboard-preview-"));
  const bundledDashboardPath = join(temporaryDirectory, "dashboard.json");
  const dashboardDataDirectory = join(temporaryDirectory, "data");
  let sourcesContent;
  try {
    await downloadData(dashboardDataDirectory, repository, ghExecutable);
    sourcesContent = redactJsonSecrets(
      await readFile(join(dashboardDataDirectory, "sources.json"), "utf8"),
    );
  } catch (error) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    throw error;
  }
  const sockets = new Set();
  const socketSessionKeys = new WeakMap();
  const capability = randomBytes(24).toString("hex");
  const routePrefix = `/${capability}`;
  const socketPath = `${routePrefix}${socketEndpoint}`;
  const watchers = new Map();
  let dashboardContent = "";
  let signature = "";
  let refreshTimer;
  let refreshPromise = Promise.resolve();
  let refreshRetryCount = 0;
  let closed = false;
  let copilotRuntime;
  let copilotRequestActive = false;
  let copilotRequest = null;
  const renderAcknowledgements = new Map();

  const broadcastDashboard = (traceId) => {
    console.log("Broadcasting dashboard preview update.", { socketCount: sockets.size });
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

  const sendSocketEvent = (socket, event) => {
    if (!socket.destroyed && !socket.writableEnded) {
      socket.write(websocketTextFrame(JSON.stringify(event)));
    }
  };

  const runCopilotRequest = async (socket, payload) => {
    const sessionKey = socketSessionKeys.get(socket);
    if (!sessionKey) {
      throw new Error("Copilot WebSocket session is unavailable.");
    }
    const traceId = typeof payload?.traceId === "string"
      && /^[A-Za-z0-9-]{8,80}$/.test(payload.traceId)
      ? payload.traceId
      : randomBytes(16).toString("hex");
    if (!copilotRuntime) {
      sendSocketEvent(socket, { type: "error", traceId, message: "Copilot mode is not available." });
      return;
    }
    if (copilotRequestActive) {
      console.log("Rejected concurrent Copilot dashboard request.");
      sendSocketEvent(socket, {
        type: "error",
        traceId,
        message: "A Copilot dashboard request is already running.",
      });
      return;
    }
    if (typeof payload?.view !== "string" || payload.view.length < 1 || payload.view.length > 200
        || typeof payload?.request !== "string" || payload.request.trim().length < 1
        || payload.request.length > 10000) {
      console.log("Rejected invalid Copilot dashboard request payload.");
      sendSocketEvent(socket, {
        type: "error",
        traceId,
        message: "A valid view and request are required.",
      });
      return;
    }

    copilotRequestActive = true;
    clearTimeout(refreshTimer);
    const controller = new AbortController();
    copilotRequest = { socket, controller, traceId, sessionKey };
    try {
      const editableDashboardPaths = [baseDashboardPath, ...await packageDashboardPaths(
        resolvedCatalogRoot,
        resolvedInstalledDashboardsDirectory,
      )];
      const viewDashboardPath = await dashboardSourceForView(payload.view, editableDashboardPaths);
      const previousDashboardSource = await readFile(viewDashboardPath, "utf8");
      console.log("Accepted Copilot dashboard request.", {
        view: payload.view,
        requestLength: payload.request.trim().length,
        viewDashboardPath,
      });
      trace.record("server", "copilot.request.accepted", {
        traceId,
        details: {
          view: payload.view,
          requestLength: payload.request.trim().length,
          viewDashboardPath,
        },
      });
      const onEvent = (event) => {
        trace.record("server", `copilot.${event.type}`, {
          traceId,
          details: {
            ...(event.message ? { message: event.message } : {}),
            ...(event.details ? { details: event.details } : {}),
          },
        });
        sendSocketEvent(socket, { ...event, traceId });
      };
      onEvent({
        type: "debug",
        message: "Starting dashboard view update.",
        details: { view: payload.view },
      });
      onEvent({ type: "started" });
      let result;
      let promptError;
      try {
        result = await copilotRuntime.prompt({
          sessionKey,
          traceId,
          view: payload.view,
          request: payload.request.trim(),
          bundledDashboardPath,
          editableDashboardPaths,
          viewDashboardPath,
          onEvent,
          signal: controller.signal,
        });
      } catch (error) {
        promptError = error;
      }
      if (result?.aborted) {
        onEvent({
          type: "debug",
          message: "Dashboard view update was stopped.",
          details: { view: payload.view },
        });
        onEvent({ type: "stopped" });
        return;
      }
      if (promptError) {
        const candidateSource = await readFile(viewDashboardPath, "utf8");
        let candidateValid = false;
        try {
          validateDashboardSource(normalizeDashboardJson(candidateSource));
          candidateValid = true;
        } catch {
          candidateValid = false;
        }
        if (candidateSource === previousDashboardSource || !candidateValid) throw promptError;
        console.log("Copilot session failed after saving a valid dashboard; continuing.", {
          view: payload.view,
          viewDashboardPath,
          ...errorMetadata(promptError),
        });
        trace.record("server", "copilot.request.recovered", {
          traceId,
          details: {
            view: payload.view,
            reason: "valid dashboard source was saved before the SDK failure",
            ...errorMetadata(promptError),
          },
        });
        onEvent({
          type: "status",
          message: "The dashboard change was saved; finishing the preview update…",
        });
      }
      onEvent({
        type: "debug",
        message: "Copilot session completed; validating the saved dashboard source.",
        details: { view: payload.view },
      });
      const savedSource = await readFile(viewDashboardPath, "utf8");
      let normalizedSource;
      try {
        normalizedSource = normalizeDashboardJson(savedSource);
        validateDashboardSource(normalizedSource);
      } catch (error) {
        console.log("Copilot dashboard request left an invalid dashboard source.", {
          view: payload.view,
          viewDashboardPath,
          ...errorMetadata(error),
        });
        throw new Error("Copilot produced an invalid dashboard.");
      }
      if (savedSource !== normalizedSource) {
        await writeFile(viewDashboardPath, normalizedSource);
        console.log("Normalized saved Copilot dashboard JSON.", {
          view: payload.view,
          viewDashboardPath,
          bytes: Buffer.byteLength(normalizedSource),
        });
      }
      console.log("Verified saved Copilot dashboard JSON.", {
        view: payload.view,
        viewDashboardPath,
      });
      trace.record("server", "copilot.source.verified", {
        traceId,
        details: {
          view: payload.view,
          viewDashboardPath,
          bytes: Buffer.byteLength(normalizedSource),
        },
      });
      onEvent({
        type: "debug",
        message: "Dashboard source saved; rebuilding the preview.",
        details: { view: payload.view },
      });
      const rendered = Promise.withResolvers();
      // Browser failure can arrive during rebuild, before execution reaches the await below.
      void rendered.promise.catch(() => {});
      const renderTimeout = setTimeout(() => rendered.reject(
        new Error("The browser did not confirm the dashboard update."),
      ), 5000);
      renderAcknowledgements.set(traceId, {
        socket,
        resolve: () => {
          clearTimeout(renderTimeout);
          rendered.resolve();
        },
        reject: (error) => {
          clearTimeout(renderTimeout);
          rendered.reject(error);
        },
      });
      try {
        refreshPromise = refreshPromise.then(
          () => rebuild(true, traceId, true),
          () => rebuild(true, traceId, true),
        );
        const packagePaths = await refreshPromise;
        await refreshWatchers(packagePaths);
        await rendered.promise;
      } catch (error) {
        let sourceRestored = false;
        let recoveryError;
        try {
          validateDashboardSource(previousDashboardSource);
          await writeFile(viewDashboardPath, previousDashboardSource);
          refreshPromise = refreshPromise.then(
            () => rebuild(false, traceId),
            () => rebuild(false, traceId),
          );
          const packagePaths = await refreshPromise;
          await refreshWatchers(packagePaths);
          sourceRestored = true;
        } catch (restoreError) {
          recoveryError = restoreError;
        }
        const browserRecovered = error?.browserRecovered !== false;
        const recovered = sourceRestored && browserRecovered;
        const errorLog = [
          error?.errorLog,
          error instanceof Error && error.stack ? error.stack : String(error),
          recoveryError
            ? `Dashboard source recovery failed:\n${
              recoveryError instanceof Error && recoveryError.stack
                ? recoveryError.stack
                : String(recoveryError)
            }`
            : undefined,
        ].filter(Boolean).join("\n\n");
        const reloadError = new Error(
          recovered
            ? "The updated preview could not reload, so the previous dashboard was restored."
            : "The updated preview could not reload, and automatic recovery was incomplete.",
          { cause: error },
        );
        reloadError.code = "DASHBOARD_PREVIEW_RELOAD_FAILED";
        reloadError.errorLog = truncatedLogText(errorLog, 6000);
        reloadError.recovered = recovered;
        throw reloadError;
      } finally {
        clearTimeout(renderTimeout);
        renderAcknowledgements.delete(traceId);
      }
      onEvent({
        type: "reloaded",
        message: "Saved and preview updated.",
        details: { view: payload.view },
      });
      onEvent({ type: "done" });
    } catch (error) {
      console.log("Copilot request failed.", errorMetadata(error));
      trace.record("server", "copilot.request.failed", {
        traceId,
        details: {
          view: payload?.view,
          ...errorMetadata(error),
        },
      });
      sendSocketEvent(socket, {
        type: "debug",
        traceId,
        message: "Dashboard view update failed.",
        details: { view: payload.view, ...errorMetadata(error) },
      });
      sendSocketEvent(socket, {
        type: "error",
        traceId,
        message: error?.code === "DASHBOARD_PREVIEW_RELOAD_FAILED"
          ? error.message
          : "Copilot could not update the view.",
        details: error?.code === "DASHBOARD_PREVIEW_RELOAD_FAILED"
          ? {
            phase: "hot-reload",
            recovered: error.recovered === true,
            ...(error.errorLog ? { errorLog: error.errorLog } : {}),
          }
          : undefined,
      });
    } finally {
      copilotRequestActive = false;
      if (copilotRequest?.socket === socket) copilotRequest = null;
    }
  };

  const handleSocketCommand = async (socket, command) => {
    if (command?.type === "copilot.start") {
      await runCopilotRequest(socket, command);
    } else if (command?.type === "copilot.stop") {
      if (socket === copilotRequest?.socket) {
        copilotRequest.controller.abort();
        await copilotRuntime?.stop(copilotRequest.sessionKey);
      }
    } else if (command?.type === "browser.trace"
        && typeof command.traceId === "string"
        && /^[A-Za-z0-9-]{8,80}$/.test(command.traceId)
        && typeof command.event === "string"
        && /^[a-z0-9.-]{1,80}$/.test(command.event)) {
      trace.record("browser", command.event, {
        traceId: command.traceId,
        details: command.details && typeof command.details === "object" ? command.details : {},
      });
      if (command.event === "preview.rendered") {
        const acknowledgement = renderAcknowledgements.get(command.traceId);
        if (acknowledgement?.socket === socket) acknowledgement.resolve();
      } else if (command.event === "preview.render.failed") {
        const acknowledgement = renderAcknowledgements.get(command.traceId);
        if (acknowledgement?.socket === socket) {
          const message = typeof command.details?.message === "string"
            ? command.details.message
            : "The browser could not render the updated dashboard.";
          const renderError = new Error(message);
          renderError.browserRecovered = command.details?.recovered === true;
          renderError.errorLog = truncatedLogText(command.details?.errorLog, 6000);
          acknowledgement.reject(renderError);
        }
      }
    }
  };

  const rebuild = async (notify = true, traceId, forceNotify = false) => {
    console.log("Checking dashboard sources for updates.");
    const packagePaths = await packageDashboardPaths(
      resolvedCatalogRoot,
      resolvedInstalledDashboardsDirectory,
    );
    const nextSignature = await sourceSignature([baseDashboardPath, ...packagePaths]);
    if (nextSignature === signature) {
      if (notify && forceNotify) broadcastDashboard(traceId);
      return packagePaths;
    }

    await copyFile(baseDashboardPath, bundledDashboardPath);
    await bundleDashboardFiles(bundledDashboardPath, packagePaths);
    dashboardContent = redactJsonSecrets(await readFile(bundledDashboardPath, "utf8"));
    signature = nextSignature;
    console.log("Dashboard preview rebuilt.", {
      bundledDashboardPath,
      editableDashboardPaths: [baseDashboardPath, ...packagePaths],
      notify,
    });
    trace.record("server", "preview.rebuilt", {
      traceId,
      details: {
        bundledDashboardPath,
        editableDashboardPaths: [baseDashboardPath, ...packagePaths],
        notify,
      },
    });
    if (notify) broadcastDashboard(traceId);
    return packagePaths;
  };

  const refreshWatchers = async (packagePaths) => {
    if (closed) return;
    const candidates = new Set([
      resolvedSiteRoot,
      resolvedInstalledDashboardsDirectory,
      ...packagePaths.map(dirname),
    ]);
    if (resolvedCatalogRoot) candidates.add(resolvedCatalogRoot);
    for (const directory of await existingDirectories(candidates)) {
      if (watchers.has(directory)) continue;
      const watcher = watch(directory, () => scheduleRefresh());
      watcher.on("error", (error) => {
        console.log(`Dashboard watcher failed for ${directory}: ${error.message}`);
        watcher.close();
        watchers.delete(directory);
      });
      watchers.set(directory, watcher);
      console.log("Watching dashboard source directory.", { directory });
    }
  };

  const refresh = async () => {
    if (closed) return;
    try {
      const packagePaths = await rebuild();
      await refreshWatchers(packagePaths);
      refreshRetryCount = 0;
    } catch (error) {
      console.log(`Dashboard update failed: ${error instanceof Error ? error.message : String(error)}`);
      if (refreshRetryCount < 4) {
        refreshRetryCount += 1;
        clearTimeout(refreshTimer);
        refreshTimer = setTimeout(scheduleRefresh, refreshRetryCount * 100);
      }
    }
  };

  function scheduleRefresh() {
    // The tracked Copilot rebuild includes every dashboard source change. Letting
    // watchers rebuild concurrently can show an update before its acknowledgement.
    if (copilotRequestActive) return;
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshPromise = refreshPromise.then(refresh, refresh);
    }, 75);
  }

  try {
    const initialPackagePaths = await rebuild(false);
    await refreshWatchers(initialPackagePaths);
    if (copilot) {
      copilotRuntime = await createCopilotRuntime({
        workingDirectory: resolvedWorkingDirectory,
        copilotExecutable,
      });
    }
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
        url.searchParams.set("local-preview", copilotRuntime ? "copilot" : "enabled");
        response.writeHead(302, { Location: `${routePrefix}/${url.search}`, "Content-Type": "text/html; charset=utf-8" }).end();
        return;
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        response.writeHead(405, { Allow: "GET, HEAD" }).end();
        return;
      }
      if (pathname === "/") pathname = "/index.html";
      if (pathname === "/sources.json") {
        response.writeHead(200, {
          "Cache-Control": "no-store",
          "Content-Type": contentTypes.get(".json"),
        });
        response.end(request.method === "HEAD" ? undefined : sourcesContent);
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
        console.log("Refused unsupported dashboard file type.", { extension: extension || null });
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
      response.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Type": contentTypes.get(extension),
      });
      response.end(request.method === "HEAD" ? undefined : content);
    } catch (error) {
      console.log(`Dashboard request failed: ${error instanceof Error ? error.message : String(error)}`);
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
    const sessionKey = randomBytes(16).toString("hex");
    socketSessionKeys.set(socket, sessionKey);
    console.log("Dashboard preview socket connected.", { socketCount: sockets.size });
    let incoming = Buffer.alloc(0);
    let removed = false;
    const remove = () => {
      if (removed) return;
      removed = true;
      sockets.delete(socket);
      if (socket === copilotRequest?.socket) {
        copilotRequest.controller.abort();
        void copilotRuntime?.stop(sessionKey);
      }
      void copilotRuntime?.disconnect?.(sessionKey).catch((error) => {
        console.log("Copilot WebSocket session disconnect failed.", {
          sessionKey,
          ...errorMetadata(error),
        });
      });
      for (const [traceId, acknowledgement] of renderAcknowledgements) {
        if (acknowledgement.socket === socket) {
          acknowledgement.reject(new Error("The browser disconnected before rendering the dashboard update."));
          renderAcknowledgements.delete(traceId);
        }
      }
      console.log("Dashboard preview socket disconnected.", { socketCount: sockets.size });
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
          } else if (frame.opcode === 0x1) {
            const command = JSON.parse(frame.payload.toString("utf8"));
            void handleSocketCommand(socket, command);
          } else {
            throw new Error("Unsupported WebSocket opcode.");
          }
        }
      } catch (error) {
        console.log("Dashboard preview socket command failed.", errorMetadata(error));
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
        console.log("Dashboard server listening.", {
          authority: expectedAuthority,
          ...(localhostAuthority ? { localhostAuthority } : {}),
          ...(codespaceAuthority ? { codespaceAuthority } : {}),
          copilot,
        });
        trace.record("server", "server.ready", {
          details: {
            authority: expectedAuthority,
            copilot,
            traceFile: resolvedTraceFile,
          },
        });
        accept();
      });
    });
  } catch (error) {
    for (const watcher of watchers.values()) watcher.close();
    await copilotRuntime?.close();
    await rm(temporaryDirectory, { recursive: true, force: true });
    throw error;
  }
  return {
    url: `http://${expectedAuthority}${routePrefix}`,
    ...(codespaceAuthority ? { codespaceUrl: `https://${codespaceAuthority}${routePrefix}` } : {}),
    async close() {
      if (closed) return;
      closed = true;
      console.log("Stopping dashboard server.");
      clearTimeout(refreshTimer);
      for (const watcher of watchers.values()) watcher.close();
      for (const socket of sockets) socket.end(websocketCloseFrame());
      await new Promise((accept, reject) => server.close((error) => error ? reject(error) : accept()));
      await copilotRuntime?.close();
      await refreshPromise;
      await rm(temporaryDirectory, { recursive: true, force: true });
      trace.record("server", "server.stopped");
      await trace.flush();
      console.log("Dashboard server stopped.");
    },
  };
}

function parseArguments(arguments_) {
  const options = {};
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--help") return { help: true };
    if (argument === "--copilot") options.copilot = true;
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
  if (!Number.isInteger(options.port ?? 4173) || (options.port ?? 4173) < 1 || (options.port ?? 4173) > 65535) {
    throw new Error("--port must be an integer from 1 through 65535");
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log("usage: local-server.mjs [--copilot] [--replace-existing] [--trace-file PATH] [--repo OWNER/REPOSITORY] [--host HOST] [--port PORT]");
    return;
  }
  const workingDirectory = await realpath(process.cwd());
  const port = options.port ?? 4173;
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
  console.log(`Dashboard preview: ${preview.url}/`);
  if (preview.codespaceUrl) {
    console.log(`Dashboard preview (Codespace): ${preview.codespaceUrl}/`);
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
