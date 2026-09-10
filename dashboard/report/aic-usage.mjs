import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { actionsLog as log } from "../../activity/actions-log.mjs";
import { adaptGhAwTimelineFiles } from "../site/src/data/adapters/gh-aw-logs.js";
import { runId as canonicalRunId, sourceId } from "../site/src/data/model/ids.js";
import { parseRolloutMode } from "./dashboard-language-sources.mjs";
import { firstText } from "./text-utils.mjs";

const FIREWALL_HORIZON_DAYS = 30;

const MAX_SECURITY_FILE_BYTES = 10 * 1024 * 1024;
const MAX_SECURITY_FILES = 2_000;
const MAX_SECURITY_DIRECTORIES = 2_000;
const NON_EVIDENCE_DIRECTORIES = new Set([".downloaded-artifacts", "aw-prompts", "base", "prompts"]);

async function resolveRunRoot(outputDirectory, runId) {
  const target = `run-${runId}`;
  const direct = path.join(outputDirectory, target);
  const pending = [path.resolve(outputDirectory)];
  let visited = 0;
  while (pending.length > 0 && visited < MAX_SECURITY_DIRECTORIES) {
    const current = pending.pop();
    visited += 1;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const candidate = path.join(current, entry.name);
      if (entry.name === target) return candidate;
      if (entry.name.startsWith("run-")) continue;
      if (!NON_EVIDENCE_DIRECTORIES.has(entry.name)) pending.push(candidate);
    }
  }
  return direct;
}

async function securityFiles(root) {
  const files = [];
  const pending = [root];
  let visited = 0;
  while (pending.length > 0 && files.length < MAX_SECURITY_FILES && visited < MAX_SECURITY_DIRECTORIES) {
    const current = pending.pop();
    visited += 1;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const candidate = path.join(current, entry.name);
      if (entry.isDirectory() && !NON_EVIDENCE_DIRECTORIES.has(entry.name)) pending.push(candidate);
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

async function loadRunEvidence(outputDirectory, runId) {
  const runRoot = await resolveRunRoot(outputDirectory, runId);
  return { runRoot, files: await securityFiles(runRoot) };
}

export async function readRunTimeline(outputDirectory, runId, sessionId, evidence = null) {
  const { runRoot, files } = evidence || await loadRunEvidence(outputDirectory, runId);
  const selected = files.filter((file) => {
    const relativePath = relativeEvidencePath(runRoot, file);
    return /(^|\/)gateway\.jsonl$/.test(relativePath)
      || /(^|\/)rpc-messages\.jsonl$/.test(relativePath)
      || /firewall.*\/audit\.jsonl$/.test(relativePath)
      || /copilot-session-state\/[^/]+\/events\.jsonl$/.test(relativePath);
  });
  const inputs = (await Promise.all(selected.map(async (file) => ({
    path: relativeEvidencePath(runRoot, file),
    content: await readBounded(file),
  })))).filter((file) => file.content !== null);
  const timeline = adaptGhAwTimelineFiles(inputs, sessionId).map((observation) => ({
    sourceId: observation.sourceId,
    ...observation.data,
  }));
  if (timeline.length > 0) return timeline;

  const summaryFile = files.find((file) => path.basename(file) === "run_summary.json");
  const content = summaryFile ? await readBounded(summaryFile) : null;
  if (content === null) return [];
  try {
    const summary = JSON.parse(content);
    const calls = Array.isArray(summary?.mcp_tool_usage?.tool_calls)
      ? summary.mcp_tool_usage.tool_calls
      : [];
    return calls.flatMap((call, index) => {
      const eventTimestamp = firstText(call?.timestamp);
      const serverName = firstText(call?.server_name);
      const toolName = firstText(call?.tool_name);
      if (!eventTimestamp || !Number.isFinite(Date.parse(eventTimestamp)) || (!serverName && !toolName)) return [];
      return [{
        sourceId: `${sessionId}:run_summary.json:mcp_tool_usage.tool_calls:${index + 1}`,
        sessionId,
        timestamp: new Date(eventTimestamp).toISOString(),
        source: "gateway",
        type: "tool_call",
        summary: [serverName, toolName].filter(Boolean).join("/"),
        status: firstText(call?.status),
        payloadRef: `run_summary.json#mcp_tool_usage.tool_calls[${index}]`,
        sourceSequence: index + 1,
      }];
    });
  } catch {
    return [];
  }
}

function emptySecurityTelemetry() {
  return {
    agenticAssessments: [],
    agentInfo: {
      available: false,
      agentId: "",
      agentName: "",
      agentVersion: "",
      agentRuntime: "",
      modelId: "",
      ghAwVersion: "",
      cliVersion: "",
      firewallVersion: "",
      gatewayVersion: "",
      workflowName: "",
    },
    audit: { available: false, data: null },
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

const AGENTIC_ASSESSMENT_KINDS = new Set([
  "overkill_for_agentic",
  "resource_heavy_for_domain",
  "poor_agentic_control",
  "partially_reducible",
  "model_downgrade_available",
]);

function boundedAssessmentText(value) {
  return firstText(value).slice(0, 2_000);
}

function agenticAssessments(summary) {
  return Array.isArray(summary?.agentic_assessments)
    ? summary.agentic_assessments
      .filter((assessment) => AGENTIC_ASSESSMENT_KINDS.has(assessment?.kind)
        && ["low", "medium", "high"].includes(assessment?.severity))
      .map((assessment) => ({
        kind: assessment.kind,
        severity: assessment.severity,
        summary: boundedAssessmentText(assessment.summary),
        evidence: boundedAssessmentText(assessment.evidence),
        recommendation: boundedAssessmentText(assessment.recommendation),
      }))
    : [];
}

const AUDIT_SECTIONS = {
  behaviorFingerprint: "behavior_fingerprint",
  engineConfig: "engine_config",
  firewallAnalysis: "firewall_analysis",
  mcpToolUsage: "mcp_tool_usage",
  metrics: "metrics",
  observabilityInsights: "observability_insights",
  recommendations: "recommendations",
  sessionAnalysis: "session_analysis",
  toolUsage: "tool_usage",
};
const SENSITIVE_AUDIT_KEY = /(argument|authorization|body|content|credential|input|message|output|prompt|response|secret|token|transcript)/i;

function boundedAuditValue(value, depth = 0) {
  if (depth > 5) return null;
  if (value === null) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") return value.slice(0, 2_000);
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((item) => boundedAuditValue(item, depth + 1));
  }
  if (typeof value !== "object") return null;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !SENSITIVE_AUDIT_KEY.test(key))
    .slice(0, 100)
    .map(([key, item]) => [key, boundedAuditValue(item, depth + 1)]));
}

function normalizedAudit(audit) {
  return Object.fromEntries(Object.entries(AUDIT_SECTIONS).map(([target, source]) => [
    target,
    boundedAuditValue(audit?.[source] ?? null),
  ]));
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

async function readFirewallTelemetry(runRoot, files, summary, info) {
  const firewall = emptySecurityTelemetry().firewall;
  const infoFile = files.find((file) => path.basename(file) === "aw_info.json");
  if (info) {
    firewall.firewallEnabled = firewallEnabledFromInfo(info);
    firewall.firewallExpected = firewall.firewallEnabled;
    firewall.awfVersion = firstText(info.awf_version, info.firewall_version) || "unknown";
  } else if (infoFile) {
    firewall.firewallEvidenceError = "Firewall configuration metadata is malformed.";
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

export async function readRunSecurityTelemetry(outputDirectory, runId, evidence = null) {
  const telemetry = emptySecurityTelemetry();
  const { runRoot, files } = evidence || await loadRunEvidence(outputDirectory, runId);
  const infoFile = files.find((file) => path.basename(file) === "aw_info.json");
  let info = null;
  if (infoFile) {
    const content = await readBounded(infoFile);
    if (content !== null) try {
      info = JSON.parse(content);
      telemetry.agentInfo = {
        available: true,
        agentId: firstText(info.engine_id),
        agentName: firstText(info.engine_name),
        agentVersion: firstText(info.agent_version),
        agentRuntime: firstText(info.agent_runtime),
        modelId: firstText(info.model),
        ghAwVersion: firstText(info.cli_version, info.version),
        cliVersion: firstText(info.cli_version),
        firewallVersion: firstText(info.awf_version),
        gatewayVersion: firstText(info.awmg_version),
        workflowName: firstText(info.workflow_name),
      };
    } catch {
      // Missing or malformed optional agent metadata remains unavailable.
    }
  }
  const auditFile = files.find((file) => path.basename(file) === "audit.json");
  if (auditFile) {
    const content = await readBounded(auditFile);
    if (content !== null) try {
      const audit = JSON.parse(content);
      telemetry.audit = { available: true, ...normalizedAudit(audit) };
      telemetry.agenticAssessments = agenticAssessments(audit);
    } catch {
      // Missing or malformed optional telemetry is represented as unavailable.
    }
  }
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
  telemetry.firewall = await readFirewallTelemetry(runRoot, files, summary, info);

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

async function readRunEvals(outputDirectory, runId, evidence = null) {
  const { files } = evidence || await loadRunEvidence(outputDirectory, runId);
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

export async function collectAicUsage() {
  log.group`Collect AI Credit usage`;
  try {
  const inventoryPath = process.env.REPORT_DEPLOYED_WORKFLOWS;
  const outputPath = path.resolve(process.env.REPORT_AIC_USAGE || "_inventory/aic-usage.json");
  const logsPath = process.env.REPORT_GH_AW_LOGS ? path.resolve(process.env.REPORT_GH_AW_LOGS) : "";
  const logsStatePath = process.env.REPORT_GH_AW_LOGS_STATE ? path.resolve(process.env.REPORT_GH_AW_LOGS_STATE) : "";
  const configuredCacheRoot = process.env.REPORT_AIC_CACHE ? path.resolve(process.env.REPORT_AIC_CACHE) : "";
  if (!inventoryPath) throw new Error("REPORT_DEPLOYED_WORKFLOWS is required");

  const inventory = JSON.parse(await readFile(inventoryPath, "utf8"));
  const runIdsByRepository = new Map();
  const workflowByRunId = new Map();
  for (const workflow of inventory.workflows || []) {
    const runIds = runIdsByRepository.get(workflow.repository) || new Set();
    const runRecords = new Map((workflow.runHealth?.runRecords || []).map((run) => [Number(run.runId), run]));
    for (const runId of workflow.runHealth?.runIds || []) {
      runIds.add(runId);
      const metadata = { workflow, run: runRecords.get(Number(runId)) || null };
      workflowByRunId.set(Number(runId), metadata);
    }
    runIdsByRepository.set(workflow.repository, runIds);
  }

  // Collection is incremental: a previously written aic-usage.json is loaded
  // and used to seed this run's data so that a download failure (or a run
  // simply missing from this window's gh-aw logs) falls back to the last
  // observed record for that run instead of overwriting it with an empty
  // placeholder.
  let previousUsage = null;
  let previousRunsByKey = new Map();
  let previousSecurityRunsByKey = new Map();
  try {
    previousUsage = JSON.parse(await readFile(outputPath, "utf8"));
    previousRunsByKey = new Map((previousUsage.runs || []).map((run) => [`${run.repository}:${run.runId}`, run]));
    previousSecurityRunsByKey = new Map(
      (previousUsage.securityRuns || []).map((run) => [`${run.repository}:${run.runId}`, run]),
    );
    log.info`Loaded ${previousRunsByKey.size} previously collected AIC runs from ${outputPath}`;
  } catch (error) {
    if (error.code !== "ENOENT") log.warning`Ignoring previous AI Credit usage at ${outputPath}: ${error.message}`;
  }

  const runs = new Map(previousRunsByKey);
  const securityRuns = new Map(previousSecurityRunsByKey);
  for (const [runId, metadata] of workflowByRunId) {
    const repository = metadata.workflow.repository;
    const key = `${repository}:${runId}`;
    const previousRun = previousRunsByKey.get(key);
    if (previousRun) runs.set(key, previousRun);
    securityRuns.set(key, previousSecurityRunsByKey.get(key) || {
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
  log.info`AI Credit collection will process ${workflowByRunId.size} selected workflow runs; cache root=${temporaryRoot}; logs JSONL=${logsPath || "disabled"}`;
  try {
    let collectionAvailable = true;
    if (logsStatePath) {
      try {
        const logsState = JSON.parse(await readFile(logsStatePath, "utf8"));
        collectionAvailable = logsState.available === true;
      } catch {
        collectionAvailable = false;
      }
    }
    try {
      if (!logsPath) throw new Error("REPORT_GH_AW_LOGS is required");
      const logs = (await readFile(logsPath, "utf8"))
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      log.info`Processing ${logs.length} cached gh-aw log records from ${logsPath}`;
      for (const run of logs) {
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
          runAttempt: Number(run.run_attempt ?? run.runAttempt ?? run.attempt) || 1,
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
        let security;
        let evals = [];
        let timeline = [];
        try {
          const evidence = await loadRunEvidence(temporaryRoot, runId);
          [security, evals, timeline] = await Promise.all([
            readRunSecurityTelemetry(temporaryRoot, runId, evidence),
            readRunEvals(temporaryRoot, runId, evidence),
            readRunTimeline(
              temporaryRoot,
              runId,
              sourceId(
                "session",
                "gh-aw-logs",
                `${canonicalRunId(runId, common.runAttempt)}:unified`,
              ),
              evidence,
            ),
          ]);
        } catch (error) {
          security = emptySecurityTelemetry();
          security.firewall.firewallEvidenceState = "unavailable";
          security.firewall.firewallEvidenceError = "Firewall artifact parsing failed.";
          log.warning`Firewall evidence unavailable for ${repository} run ${runId}: ${error.message}`;
        }
        const enriched = {
          ...common,
          engine: firstText(common.engine, security.agentInfo.agentId, security.agentInfo.agentName),
          engineVersion: firstText(common.engineVersion, security.agentInfo.agentVersion),
          requestedModel: firstText(common.requestedModel, security.agentInfo.modelId),
          resolvedModel: firstText(common.resolvedModel, security.agentInfo.modelId),
          agentRuntime: firstText(common.agentRuntime, security.agentInfo.agentRuntime),
          ghAwVersion: firstText(security.agentInfo.ghAwVersion, security.mcp.cliVersion),
        };
        if (Number.isFinite(aic) || enriched.tokenUsage) runs.set(`${repository}:${runId}`, {
          ...enriched,
          aic: Number.isFinite(aic) ? aic : null,
        });
        if (
          common.createdAt
          && ["available", "partial", "disabled", "no-traffic"].includes(security.firewall.firewallEvidenceState)
          && !security.firewall.firewallEvidenceHorizonStart
        ) {
          security.firewall.firewallEvidenceHorizonStart = common.createdAt;
          security.firewall.firewallEvidenceHorizonEnd = common.createdAt;
        }
        if (security.firewall.firewallEvidenceSource !== "none") {
          security.firewall.firewallEvidenceFreshness = collectionAvailable ? "fresh" : "stale";
        }
        securityRuns.set(`${repository}:${runId}`, {
          ...enriched,
          logsPayload: run,
          security,
          evals,
          timeline,
        });
      }
    } catch (error) {
      collectionAvailable = false;
      log.warning`AI Credit usage unavailable: ${error.message}`;
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
      firewallLastSuccessfulCollectionAt: collectionAvailable
        ? generatedAt
        : previousUsage?.firewallLastSuccessfulCollectionAt || null,
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
  collectAicUsage().catch((error) => {
    log.error`${error.stack || error.message || error}`;
    process.exitCode = 1;
  });
}