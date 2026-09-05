import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { actionsLog as log } from "../../activity/actions-log.mjs";
import { parseRolloutMode } from "./dashboard-language-sources.mjs";
import { firstText } from "./text-utils.mjs";

const FIREWALL_HORIZON_DAYS = 30;

function runGhAw(targets, maxRunsPerWorkflow, outputDirectory) {
  return new Promise((resolve, reject) => {
    const child = spawn("gh", [
      "aw", "logs", "--json",
      "--output", outputDirectory, "--summary-file", "",
      "--artifacts", "usage,agent,detection,evals,experiment,firewall,graders,mcp",
      "--start-date", `-${FIREWALL_HORIZON_DAYS}d`, "--cache-before", `-${FIREWALL_HORIZON_DAYS}d`,
      "--count", String(maxRunsPerWorkflow), "--timeout", "15",
      "--max-github-api-rate-limit", "-2000", "--max-storage", "1024",
      ...targets,
    ], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    child.stdout.on("data", (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > 50 * 1024 * 1024) child.kill();
      else stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code, signal) => {
      const diagnostic = Buffer.concat(stderr).toString("utf8").trim();
      if (code === 0 && !signal) resolve(Buffer.concat(stdout).toString("utf8"));
      else reject(new Error(diagnostic || `gh aw logs exited with ${signal || code}`));
    });
  });
}

const MAX_SECURITY_FILE_BYTES = 10 * 1024 * 1024;
const MAX_SECURITY_FILES = 2_000;

async function securityFiles(root) {
  const files = [];
  const pending = [root];
  while (pending.length > 0 && files.length < MAX_SECURITY_FILES) {
    const current = pending.pop();
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const candidate = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(candidate);
      else if (entry.isFile()) files.push(candidate);
      if (files.length >= MAX_SECURITY_FILES) break;
    }
  }
  return files;
}

async function readBounded(file) {
  try {
    const details = await stat(file);
    if (!details.isFile() || details.size > MAX_SECURITY_FILE_BYTES) return null;
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
}

function emptySecurityTelemetry() {
  return {
    accessControl: { available: false, fileDenials: {}, toolDenials: {}, guardPolicy: null },
    firewall: {
      available: false,
      analysis: null,
      observations: [],
      policyManifest: null,
      policyAnalysis: null,
      firewallExpected: null,
      firewallEnabled: null,
      firewallEvidenceAvailable: false,
      firewallEvidenceState: "unknown",
      firewallEvidenceCompleteness: "unknown",
      firewallEvidenceFreshness: "unknown",
      firewallEvidenceError: "",
      firewallEvidenceSource: "none",
      firewallEvidenceReference: "",
      firewallEvidenceHorizonStart: null,
      firewallEvidenceHorizonEnd: null,
      awfVersion: "unknown",
    },
    integrity: { available: false, summary: null, totalToolCalls: 0 },
    mcp: { available: false, cliVersion: null, servers: [], calls: [], failures: [] },
    threatDetection: { available: false, verdict: null },
  };
}

function relativeEvidencePath(runRoot, file) {
  return file ? path.relative(runRoot, file).split(path.sep).join("/") : "";
}

function parseFirewallHost(value) {
  const text = firstText(value);
  if (!text || text === "-") return { domain: "unknown", host: "unknown", port: null };
  const explicitPort = text.match(/^(?:https?:\/\/)?(?:\[[^\]]+\]|[^/:]+):(\d+)(?:\/|$)/)?.[1];
  try {
    const parsed = new URL(text.includes("://") ? text : `https://${text}`);
    const port = explicitPort ? Number(explicitPort) : parsed.port ? Number(parsed.port) : null;
    return { domain: parsed.hostname.toLowerCase(), host: parsed.hostname.toLowerCase(), port };
  } catch {
    const bracketed = text.match(/^\[([^\]]+)\](?::(\d+))?$/);
    if (bracketed) return {
      domain: bracketed[1].toLowerCase(),
      host: bracketed[1].toLowerCase(),
      port: bracketed[2] ? Number(bracketed[2]) : null,
    };
    const match = text.match(/^(.+?)(?::(\d+))?$/);
    return {
      domain: firstText(match?.[1]).toLowerCase() || "unknown",
      host: firstText(match?.[1]).toLowerCase() || "unknown",
      port: match?.[2] ? Number(match[2]) : null,
    };
  }
}

function firewallDecision(entry) {
  const status = Number(entry?.status);
  const decision = String(entry?.decision || "").toUpperCase();
  if ([200, 206, 304].includes(status) || /TCP_(?:TUNNEL|HIT|MISS)/.test(decision)) return "allowed";
  if ([403, 407].includes(status) || /TCP_DENIED/.test(decision)) return "denied";
  return "unknown";
}

function firewallProtocol(entry, port) {
  if (String(entry?.method || "").toUpperCase() === "CONNECT" || port === 443) return "https";
  if (port === 80) return "http";
  return "unknown";
}

async function parseFirewallAudit(file) {
  const content = await readBounded(file);
  if (content === null) return { entries: [], malformed: 0, error: "Firewall audit artifact could not be read." };
  const entries = [];
  let malformed = 0;
  for (const line of content.split(/\r?\n/).filter((value) => value.trim())) {
    try {
      const raw = JSON.parse(line);
      const host = parseFirewallHost(firstText(raw.host, raw.dest, raw.url));
      const timestamp = Number(raw.ts);
      if (!Number.isFinite(timestamp) || host.host === "unknown") {
        malformed += 1;
        continue;
      }
      entries.push({
        observedAt: new Date(timestamp * 1000).toISOString(),
        ...host,
        protocol: firewallProtocol(raw, host.port),
        decision: firewallDecision(raw),
        status: Number.isFinite(Number(raw.status)) ? Number(raw.status) : null,
      });
    } catch {
      malformed += 1;
    }
  }
  return { entries, malformed, error: "" };
}

function firewallEnabledFromInfo(info) {
  const value = firstText(info?.firewall, info?.steps?.firewall);
  if (value) return value.toLowerCase() !== "none" && value.toLowerCase() !== "disabled";
  return null;
}

async function readFirewallTelemetry(runRoot, files, summary) {
  const firewall = emptySecurityTelemetry().firewall;
  const infoFile = files.find((file) => path.basename(file) === "aw_info.json");
  if (infoFile) {
    const content = await readBounded(infoFile);
    if (content !== null) try {
      const info = JSON.parse(content);
      firewall.firewallEnabled = firewallEnabledFromInfo(info);
      firewall.firewallExpected = firewall.firewallEnabled;
      firewall.awfVersion = firstText(info.awf_version, info.firewall_version) || "unknown";
    } catch {
      firewall.firewallEvidenceError = "Firewall configuration metadata is malformed.";
    }
  }

  const manifestFile = files.find((file) => path.basename(file) === "policy-manifest.json");
  if (manifestFile) {
    const content = await readBounded(manifestFile);
    if (content !== null) try {
      firewall.policyManifest = JSON.parse(content);
      firewall.firewallEnabled ??= true;
      firewall.firewallExpected ??= true;
    } catch {
      firewall.firewallEvidenceError = "Firewall policy manifest is malformed.";
    }
  }

  const auditFile = files.find((file) => path.basename(file) === "audit.jsonl");
  if (auditFile) {
    const parsed = await parseFirewallAudit(auditFile);
    firewall.observations = parsed.entries;
    firewall.firewallEvidenceReference = relativeEvidencePath(runRoot, auditFile);
    firewall.firewallEvidenceSource = "firewall-audit";
    firewall.firewallEvidenceAvailable = parsed.error === "";
    firewall.available = parsed.error === "";
    if (parsed.error) {
      firewall.firewallEvidenceState = "unavailable";
      firewall.firewallEvidenceCompleteness = "unknown";
      firewall.firewallEvidenceError = parsed.error;
    } else if (parsed.malformed > 0 && parsed.entries.length === 0) {
      firewall.available = false;
      firewall.firewallEvidenceAvailable = false;
      firewall.firewallEvidenceState = "malformed";
      firewall.firewallEvidenceCompleteness = "unknown";
      firewall.firewallEvidenceError = "Firewall audit artifact contains no valid records.";
    } else if (parsed.malformed > 0) {
      firewall.firewallEvidenceState = "partial";
      firewall.firewallEvidenceCompleteness = "partial";
      firewall.firewallEvidenceError = `${parsed.malformed} malformed firewall audit record(s) were skipped.`;
    } else if (parsed.entries.length === 0) {
      firewall.firewallEvidenceState = "no-traffic";
      firewall.firewallEvidenceCompleteness = "complete";
    } else {
      firewall.firewallEvidenceState = "available";
      firewall.firewallEvidenceCompleteness = "complete";
    }
    if (firewall.firewallEvidenceError && firewall.firewallEvidenceState === "available") {
      firewall.firewallEvidenceState = "partial";
      firewall.firewallEvidenceCompleteness = "partial";
    }
    const timestamps = parsed.entries.map((entry) => Date.parse(entry.observedAt)).filter(Number.isFinite);
    if (timestamps.length > 0) {
      firewall.firewallEvidenceHorizonStart = new Date(Math.min(...timestamps)).toISOString();
      firewall.firewallEvidenceHorizonEnd = new Date(Math.max(...timestamps)).toISOString();
      firewall.firewallEvidenceFreshness = "fresh";
    }
  }

  const legacy = summary?.firewall_analysis;
  if (summary?.policy_analysis && typeof summary.policy_analysis === "object") {
    firewall.policyAnalysis = summary.policy_analysis;
  }
  if (legacy && typeof legacy === "object") {
    firewall.analysis = legacy;
    firewall.firewallEnabled ??= true;
    firewall.firewallExpected ??= true;
    if (!auditFile) {
      firewall.available = true;
      firewall.firewallEvidenceAvailable = true;
      firewall.firewallEvidenceState = "partial";
      firewall.firewallEvidenceCompleteness = "partial";
      firewall.firewallEvidenceFreshness = "unknown";
      firewall.firewallEvidenceSource = "run-summary-legacy";
      firewall.firewallEvidenceReference = "run_summary.json";
      firewall.firewallEvidenceError ||= "Legacy summary only; authoritative request and policy attribution may be incomplete.";
    }
  }

  if (firewall.firewallEnabled === false) {
    firewall.available = true;
    firewall.firewallEvidenceAvailable = false;
    firewall.firewallEvidenceState = "disabled";
    firewall.firewallEvidenceCompleteness = "complete";
    firewall.firewallEvidenceSource = infoFile ? "workflow-metadata" : firewall.firewallEvidenceSource;
  } else if (firewall.firewallEnabled === true && firewall.firewallEvidenceState === "unknown") {
    firewall.firewallEvidenceState = "unavailable";
    firewall.firewallEvidenceCompleteness = "unknown";
    firewall.firewallEvidenceError ||= "Firewall was enabled but no firewall artifact was collected.";
  }
  return firewall;
}

function countPermissionDenials(content, telemetry) {
  const pattern = /\[sdk-driver\].*permission denied by workflow tool permissions:\s*(read|write|shell|mcp|url|custom-tool)\(/gi;
  for (const match of content.matchAll(pattern)) {
    const kind = match[1].toLowerCase();
    const target = kind === "read" || kind === "write"
      ? telemetry.accessControl.fileDenials
      : telemetry.accessControl.toolDenials;
    target[kind] = (target[kind] || 0) + 1;
  }
}

function validThreatVerdict(value) {
  return value
    && typeof value === "object"
    && typeof value.prompt_injection === "boolean"
    && typeof value.secret_leak === "boolean"
    && typeof value.malicious_patch === "boolean"
    && Array.isArray(value.reasons);
}

export async function readRunSecurityTelemetry(outputDirectory, runId) {
  const telemetry = emptySecurityTelemetry();
  const runRoot = path.join(outputDirectory, `run-${runId}`);
  const files = await securityFiles(runRoot);
  const summaryFile = files.find((file) => path.basename(file) === "run_summary.json");
  let summary = null;
  if (summaryFile) {
    const content = await readBounded(summaryFile);
    if (content !== null) try {
      summary = JSON.parse(content);
      telemetry.mcp.cliVersion = firstText(summary.cli_version);
      const toolUsage = summary.mcp_tool_usage;
      if (toolUsage && typeof toolUsage === "object") {
        telemetry.mcp.available = true;
        telemetry.mcp.servers = Array.isArray(toolUsage.servers)
          ? toolUsage.servers.map((server) => ({
            serverName: firstText(server?.server_name),
            serverVersion: firstText(server?.server_version, server?.version),
            protocolVersion: firstText(server?.protocol_version),
            toolCallCount: Math.max(0, Number(server?.tool_call_count ?? server?.request_count) || 0),
            errorCount: Math.max(0, Number(server?.error_count) || 0),
            totalOutputSize: Math.max(0, Number(server?.total_output_size) || 0),
            maxOutputSize: Math.max(0, Number(server?.max_output_size) || 0),
          })).filter((server) => server.serverName)
          : [];
        telemetry.mcp.calls = Array.isArray(toolUsage.tool_calls)
          ? toolUsage.tool_calls.map((call) => ({
            timestamp: firstText(call?.timestamp),
            serverName: firstText(call?.server_name),
            toolName: firstText(call?.tool_name),
            status: firstText(call?.status),
            outputSize: call?.output_size != null && Number.isFinite(Number(call.output_size))
              ? Math.max(0, Number(call.output_size))
              : null,
          })).filter((call) => call.serverName || call.toolName)
          : [];
        const integrity = toolUsage.integrity;
        if (integrity && typeof integrity === "object") {
          telemetry.integrity.available = true;
          telemetry.integrity.summary = integrity;
        }
        telemetry.integrity.totalToolCalls = Array.isArray(toolUsage.summary)
          ? toolUsage.summary.reduce((total, tool) => total + Math.max(0, Number(tool.call_count) || 0), 0)
          : 0;
        const guardPolicy = toolUsage.guard_policy_summary;
        if (guardPolicy && typeof guardPolicy === "object") {
          telemetry.accessControl.available = true;
          telemetry.accessControl.guardPolicy = guardPolicy;
        }
      }
      if (Array.isArray(summary.mcp_failures)) {
        telemetry.mcp.failures = summary.mcp_failures.map((failure) => ({
          serverName: firstText(failure?.server_name),
          status: firstText(failure?.status),
        })).filter((failure) => failure.serverName);
        if (telemetry.mcp.failures.length > 0) telemetry.mcp.available = true;
      }
    } catch {
      // Missing or malformed optional telemetry is represented as unavailable.
    }
  }
  telemetry.firewall = await readFirewallTelemetry(runRoot, files, summary);

  const agentLogs = files.filter((file) => path.basename(file) === "agent-stdio.log");
  if (agentLogs.length > 0) telemetry.accessControl.available = true;
  for (const file of agentLogs) {
    const content = await readBounded(file);
    if (content !== null) countPermissionDenials(content, telemetry);
  }

  const detectionFile = files.find((file) => path.basename(file) === "detection_result.json");
  if (detectionFile) {
    const content = await readBounded(detectionFile);
    if (content !== null) try {
      const verdict = JSON.parse(content);
      if (validThreatVerdict(verdict)) {
        telemetry.threatDetection = {
          available: true,
          verdict: {
            promptInjection: verdict.prompt_injection,
            secretLeak: verdict.secret_leak,
            maliciousPatch: verdict.malicious_patch,
            warnings: Array.isArray(verdict.warnings)
              ? verdict.warnings.map((warning) => ({
                field: firstText(warning?.field),
                code: firstText(warning?.code),
              })).filter((warning) => warning.field || warning.code)
              : [],
          },
        };
      }
    } catch {
      // Missing or malformed optional telemetry is represented as unavailable.
    }
  }
  return telemetry;
}

function securityTelemetryComplete(telemetry) {
  return telemetry.accessControl.available
    && telemetry.firewall.available
    && telemetry.integrity.available
    && telemetry.threatDetection.available;
}

function tokenUsage(run) {
  const summary = run?.token_usage_summary;
  return summary && typeof summary === "object" ? {
    inputTokens: Number(summary.total_input_tokens) || 0,
    outputTokens: Number(summary.total_output_tokens) || 0,
    cacheReadTokens: Number(summary.total_cache_read_tokens) || 0,
    cacheWriteTokens: Number(summary.total_cache_write_tokens) || 0,
    reasoningTokens: Object.values(summary.by_model || {}).reduce(
      (total, model) => total + (Number(model?.reasoning_tokens) || 0),
      0,
    ),
  } : null;
}

async function readRunEvals(outputDirectory, runId) {
  const runRoot = path.join(outputDirectory, `run-${runId}`);
  const files = await securityFiles(runRoot);
  const evalFiles = files.filter((file) => path.basename(file) === "evals.jsonl");
  const observations = [];
  for (const file of evalFiles) {
    const content = await readBounded(file);
    if (content === null) continue;
    for (const line of content.split(/\r?\n/).filter((value) => value.trim())) {
      try {
        const record = JSON.parse(line);
        const id = firstText(record?.id);
        if (!id) continue;
        observations.push({
          id,
          answer: firstText(record?.answer) || "unknown",
          runId: firstText(record?.runid, record?.run_id) || String(runId),
          timestamp: firstText(record?.timestamp),
        });
      } catch {
        // Malformed optional eval records remain unavailable.
      }
    }
  }
  return observations;
}

async function main() {
  log.group`Collect AI Credit usage`;
  try {
  const inventoryPath = process.env.REPORT_DEPLOYED_WORKFLOWS;
  const outputPath = path.resolve(process.env.REPORT_AIC_USAGE || "_inventory/aic-usage.json");
  const configuredCacheRoot = process.env.REPORT_AIC_CACHE ? path.resolve(process.env.REPORT_AIC_CACHE) : "";
  if (!inventoryPath) throw new Error("REPORT_DEPLOYED_WORKFLOWS is required");

  const inventory = JSON.parse(await readFile(inventoryPath, "utf8"));
  const runIdsByRepository = new Map();
  const workflowByRunId = new Map();
  const targets = [];
  let maxRunsPerWorkflow = 0;
  for (const workflow of inventory.workflows || []) {
    const runIds = runIdsByRepository.get(workflow.repository) || new Set();
    const runRecords = new Map((workflow.runHealth?.runRecords || []).map((run) => [Number(run.runId), run]));
    for (const runId of workflow.runHealth?.runIds || []) {
      runIds.add(runId);
      const metadata = { workflow, run: runRecords.get(Number(runId)) || null };
      workflowByRunId.set(Number(runId), metadata);
    }
    runIdsByRepository.set(workflow.repository, runIds);
    if (workflow.runHealth?.runIds?.length > 0) {
      targets.push(`${workflow.repository}/${workflow.path}`);
      maxRunsPerWorkflow = Math.max(maxRunsPerWorkflow, workflow.runHealth.runIds.length);
    }
  }

  const runs = new Map();
  const securityRuns = new Map();
  for (const [runId, metadata] of workflowByRunId) {
    const repository = metadata.workflow.repository;
    securityRuns.set(`${repository}:${runId}`, {
      repository,
      runId,
      workflowName: metadata.workflow.name || null,
      workflowPath: metadata.workflow.path || null,
      mode: parseRolloutMode(metadata.run?.displayTitle),
      conclusion: metadata.run?.conclusion || null,
      createdAt: metadata.run?.createdAt || null,
      engine: null,
      engineVersion: null,
      requestedModel: null,
      resolvedModel: null,
      agentRuntime: null,
      safeItemsCount: 0,
      noopCount: 0,
      missingDataCount: 0,
      missingToolCount: 0,
      reportIncompleteCount: 0,
      data: null,
      security: emptySecurityTelemetry(),
    });
  }
  const temporaryRoot = configuredCacheRoot || await mkdtemp(path.join(os.tmpdir(), "pages-aic-"));
  await mkdir(temporaryRoot, { recursive: true });
  try {
    let collectionAvailable = true;
    if (targets.length > 0) {
      try {
        const result = JSON.parse(await runGhAw(targets, maxRunsPerWorkflow, temporaryRoot));
        for (const run of result.runs || []) {
          const runId = Number(run.database_id ?? run.run_id ?? run.id);
          const aic = run.aic === null || run.aic === undefined || run.aic === ""
            ? null
            : Number(run.aic);
          const metadata = workflowByRunId.get(runId);
          if (!Number.isFinite(runId) || !metadata) continue;
          const repository = metadata.workflow.repository;
          const mode = parseRolloutMode(metadata.run?.displayTitle);
          const common = {
            repository,
            runId,
            workflowName: run.workflow_name || run.workflow || metadata.workflow.name || null,
            workflowPath: metadata.workflow.path || null,
            mode,
            conclusion: metadata.run?.conclusion || null,
            createdAt: run.created_at || run.started_at || metadata.run?.createdAt || null,
            engine: firstText(run.engine, run.agentic_engine, run.agent_engine),
            engineVersion: firstText(run.engine_version, run.agentic_engine_version, run.agent_engine_version, run.agent_version),
            requestedModel: firstText(run.requested_model, run.requestedModel, run.model, run.model_name),
            resolvedModel: firstText(run.resolved_model, run.resolvedModel, run.model_resolved, run.model),
            agentRuntime: firstText(run.agent_runtime, run.agentRuntime),
            safeItemsCount: Number(run.safe_items_count) || 0,
            noopCount: Number(run.noop_count) || 0,
            missingDataCount: Number(run.missing_data_count) || 0,
            missingToolCount: Number(run.missing_tool_count) || 0,
            reportIncompleteCount: Number(run.report_incomplete_count) || 0,
            data: run.data ?? null,
            tokenUsage: tokenUsage(run),
            experiments: run.experiments ?? null,
            graders: run.graders ?? null,
          };
          if (Number.isFinite(aic) || common.tokenUsage) runs.set(`${repository}:${runId}`, {
            ...common,
            aic: Number.isFinite(aic) ? aic : null,
          });
          let security;
          let evals = [];
          try {
            [security, evals] = await Promise.all([
              readRunSecurityTelemetry(temporaryRoot, runId),
              readRunEvals(temporaryRoot, runId),
            ]);
          } catch (error) {
            security = emptySecurityTelemetry();
            security.firewall.firewallEvidenceState = "unavailable";
            security.firewall.firewallEvidenceError = "Firewall artifact parsing failed.";
            log.warning`Firewall evidence unavailable for ${repository} run ${runId}: ${error.message}`;
          }
          if (
            common.createdAt
            && ["available", "partial", "disabled", "no-traffic"].includes(security.firewall.firewallEvidenceState)
            && !security.firewall.firewallEvidenceHorizonStart
          ) {
            security.firewall.firewallEvidenceHorizonStart = common.createdAt;
            security.firewall.firewallEvidenceHorizonEnd = common.createdAt;
          }
          if (security.firewall.firewallEvidenceSource !== "none" && security.firewall.firewallEvidenceFreshness === "unknown") {
            security.firewall.firewallEvidenceFreshness = "fresh";
          }
          securityRuns.set(`${repository}:${runId}`, {
            ...common,
            logsPayload: run,
            security,
            evals,
          });
        }
      } catch (error) {
        collectionAvailable = false;
        log.warning`AI Credit usage unavailable: ${error.message}`;
      }
    }
    const reportedRunsByRepository = Object.groupBy([...runs.values()], (run) => run.repository);
    const repositories = [...runIdsByRepository].map(([repository, runIds]) => {
      const reportedRuns = reportedRunsByRepository[repository]?.length || 0;
      const available = runIds.size === 0 || collectionAvailable;
      return {
        repository,
        selectedRuns: runIds.size,
        reportedRuns,
        available,
        complete: available && reportedRuns === runIds.size,
      };
    });

    const generatedAt = new Date().toISOString();
    const firewallEvidenceTimes = [...securityRuns.values()].flatMap((run) => [
      Date.parse(run.security.firewall.firewallEvidenceHorizonStart),
      Date.parse(run.security.firewall.firewallEvidenceHorizonEnd),
    ]).filter(Number.isFinite);
    const requestedFirewallStart = new Date(
      Date.parse(generatedAt) - FIREWALL_HORIZON_DAYS * 86_400_000,
    ).toISOString();
    const usage = {
      schemaVersion: 5,
      generatedAt,
      windowStart: inventory.runHealth?.windowStart || null,
      windowHours: inventory.runHealth?.windowHours || null,
      firewallRequestedHorizonStart: requestedFirewallStart,
      firewallRequestedHorizonEnd: generatedAt,
      firewallEvidenceHorizonStart: firewallEvidenceTimes.length > 0
        ? new Date(Math.min(...firewallEvidenceTimes)).toISOString()
        : null,
      firewallEvidenceHorizonEnd: firewallEvidenceTimes.length > 0
        ? new Date(Math.max(...firewallEvidenceTimes)).toISOString()
        : null,
      firewallLastSuccessfulCollectionAt: collectionAvailable ? generatedAt : null,
      available: repositories.every((entry) => entry.available),
      complete: repositories.every((entry) => entry.complete),
      securityAvailable: collectionAvailable,
      securityComplete: collectionAvailable
        && [...securityRuns.values()].every((run) => securityTelemetryComplete(run.security)),
      mcpAvailable: collectionAvailable,
      mcpComplete: collectionAvailable,
      repositories,
      runs: [...runs.values()],
      securityRuns: [...securityRuns.values()],
    };
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(usage, null, 2)}\n`);
    log.info`Collected ${usage.runs.length} AIC-bearing runs; coverage ${usage.complete ? "complete" : "partial"}`;
  } finally {
    if (!configuredCacheRoot) await rm(temporaryRoot, { recursive: true, force: true });
  }
  } finally {
    log.endGroup();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    log.error`${error.stack || error.message || error}`;
    process.exitCode = 1;
  });
}