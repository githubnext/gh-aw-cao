import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readRunSecurityTelemetry } from "../../dashboard/report/aic-usage.mjs";

test("dashboard telemetry extracts bounded security aggregates without retaining denial details", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dashboard-security-"));
  const runDirectory = path.join(root, "run-42");
  await mkdir(path.join(runDirectory, "agent"), { recursive: true });
  await mkdir(path.join(runDirectory, "detection"), { recursive: true });
  try {
    await writeFile(path.join(runDirectory, "run_summary.json"), JSON.stringify({
      cli_version: "0.88.0",
      agentic_assessments: [{
        kind: "partially_reducible",
        severity: "low",
        summary: "Half of the turns were deterministic data gathering.",
        evidence: "agentic_fraction=0.50 turns=8",
        recommendation: "Move data fetching into deterministic pre-steps.",
      }, {
        kind: "unsupported_future_assessment",
        severity: "critical",
        summary: "Must not be retained.",
      }],
      firewall_analysis: {
        total_requests: 4,
        allowed_requests: 3,
        blocked_requests: 1,
        requests_by_domain: {
          "api.github.com:443": { allowed: 3, blocked: 0 },
          "blocked.example:443": { allowed: 0, blocked: 1 },
        },
      },
      mcp_tool_usage: {
        summary: [{ tool_name: "get_file", call_count: 5 }],
        servers: [{
          server_name: "github",
          server_version: "1.2.3",
          protocol_version: "2025-06-18",
          tool_call_count: 5,
          error_count: 1,
          total_output_size: 12_000,
          max_output_size: 8_000,
        }],
        tool_calls: [{
          timestamp: "2026-09-03T05:01:00Z",
          server_name: "github",
          tool_name: "get_file",
          status: "success",
          output_size: 8_000,
          error: "sensitive MCP error",
        }],
        integrity: {
          total_filtered: 2,
          filtered_tool_counts: { create_issue: 2 },
          filtered_reason_counts: { integrity: 2 },
        },
        guard_policy_summary: {
          total_blocked: 1,
          repo_scope_blocked: 1,
        },
      },
      mcp_failures: [{ server_name: "playwright", status: "connection failed", error: "secret detail" }],
    }));
    await writeFile(path.join(runDirectory, "agent", "agent-stdio.log"), [
      "[sdk-driver] permission denied by workflow tool permissions: read(/private/path)",
      "[sdk-driver] permission denied by workflow tool permissions: mcp(github.create_issue)",
      "unrelated output that must not be retained",
    ].join("\n"));
    await writeFile(path.join(runDirectory, "detection", "detection_result.json"), JSON.stringify({
      prompt_injection: true,
      secret_leak: false,
      malicious_patch: false,
      reasons: [],
      warnings: [{ field: "patch", code: "ERR_VALIDATION", message: "sensitive diagnostic" }],
    }));

    const telemetry = await readRunSecurityTelemetry(root, 42);
    assert.deepEqual(telemetry.agenticAssessments, [{
      kind: "partially_reducible",
      severity: "low",
      summary: "Half of the turns were deterministic data gathering.",
      evidence: "agentic_fraction=0.50 turns=8",
      recommendation: "Move data fetching into deterministic pre-steps.",
    }]);
    assert.deepEqual(telemetry.accessControl.fileDenials, { read: 1 });
    assert.deepEqual(telemetry.accessControl.toolDenials, { mcp: 1 });
    assert.equal(telemetry.firewall.analysis.blocked_requests, 1);
    assert.equal(telemetry.firewall.firewallEvidenceState, "partial");
    assert.equal(telemetry.firewall.firewallEvidenceSource, "run-summary-legacy");
    assert.match(telemetry.firewall.firewallEvidenceError, /Legacy summary only/);
    assert.equal(telemetry.integrity.summary.total_filtered, 2);
    assert.equal(telemetry.integrity.totalToolCalls, 5);
    assert.deepEqual(telemetry.mcp, {
      available: true,
      cliVersion: "0.88.0",
      servers: [{
        serverName: "github",
        serverVersion: "1.2.3",
        protocolVersion: "2025-06-18",
        toolCallCount: 5,
        errorCount: 1,
        totalOutputSize: 12_000,
        maxOutputSize: 8_000,
      }],
      calls: [{
        timestamp: "2026-09-03T05:01:00Z",
        serverName: "github",
        toolName: "get_file",
        status: "success",
        outputSize: 8_000,
      }],
      failures: [{ serverName: "playwright", status: "connection failed" }],
    });
    assert.deepEqual(telemetry.threatDetection.verdict, {
      promptInjection: true,
      secretLeak: false,
      maliciousPatch: false,
      warnings: [{ field: "patch", code: "ERR_VALIDATION" }],
    });
    assert.doesNotMatch(JSON.stringify(telemetry), /private\/path|sensitive diagnostic|sensitive MCP error|secret detail|unrelated output/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dashboard telemetry keeps absent MCP usage unavailable when the failure list is empty", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dashboard-security-"));
  const runDirectory = path.join(root, "run-43");
  await mkdir(runDirectory, { recursive: true });
  try {
    await writeFile(path.join(runDirectory, "run_summary.json"), JSON.stringify({
      cli_version: "0.88.0",
      mcp_failures: [],
    }));

    const telemetry = await readRunSecurityTelemetry(root, 43);
    assert.equal(telemetry.mcp.available, false);
    assert.deepEqual(telemetry.mcp.failures, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dashboard telemetry preserves missing tool_call output_size as null", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dashboard-security-"));
  const runDirectory = path.join(root, "run-44");
  await mkdir(runDirectory, { recursive: true });
  try {
    await writeFile(path.join(runDirectory, "run_summary.json"), JSON.stringify({
      cli_version: "0.88.0",
      mcp_tool_usage: {
        tool_calls: [{
          timestamp: "2026-09-03T05:01:00Z",
          server_name: "github",
          tool_name: "get_file",
          status: "success",
        }],
      },
    }));

    const telemetry = await readRunSecurityTelemetry(root, 44);
    assert.equal(telemetry.mcp.calls[0].outputSize, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dashboard telemetry classifies authoritative, empty, malformed, and disabled firewall artifacts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dashboard-firewall-"));
  try {
    const authoritative = path.join(root, "run-50", "sandbox", "firewall", "audit");
    await mkdir(authoritative, { recursive: true });
    await writeFile(path.join(root, "run-50", "aw_info.json"), JSON.stringify({
      firewall: "squid",
      awf_version: "0.28.12",
    }));
    await writeFile(path.join(authoritative, "policy-manifest.json"), JSON.stringify({
      version: 1,
      generatedAt: "2026-09-03T05:00:00Z",
      rules: [{
        id: "github-api",
        order: 1,
        action: "allow",
        aclName: "github_api",
        protocol: "https",
        domains: [".github.com"],
        description: "GitHub API",
      }],
    }));
    await writeFile(path.join(authoritative, "audit.jsonl"), [
      JSON.stringify({ _schema: "audit/v0.28.12", ts: 1788411660, host: "api.github.com:443", method: "CONNECT", status: 200, decision: "TCP_TUNNEL:HIER_DIRECT" }),
      JSON.stringify({ _schema: "audit/v0.28.12", ts: 1788411720, host: "blocked.example:80", method: "GET", status: 403, decision: "TCP_DENIED:HIER_NONE" }),
    ].join("\n"));

    const telemetry = await readRunSecurityTelemetry(root, 50);
    assert.equal(telemetry.firewall.firewallEvidenceState, "available");
    assert.equal(telemetry.firewall.firewallEvidenceCompleteness, "complete");
    assert.equal(telemetry.firewall.firewallEnabled, true);
    assert.equal(telemetry.firewall.awfVersion, "0.28.12");
    assert.deepEqual(telemetry.firewall.observations.map(({ domain, port, protocol, decision }) => ({
      domain, port, protocol, decision,
    })), [
      { domain: "api.github.com", port: 443, protocol: "https", decision: "allowed" },
      { domain: "blocked.example", port: 80, protocol: "http", decision: "denied" },
    ]);
    assert.equal(telemetry.firewall.firewallEvidenceReference, "sandbox/firewall/audit/audit.jsonl");

    const noTraffic = path.join(root, "run-51", "sandbox", "firewall", "audit");
    await mkdir(noTraffic, { recursive: true });
    await writeFile(path.join(root, "run-51", "aw_info.json"), JSON.stringify({ firewall: "squid" }));
    await writeFile(path.join(noTraffic, "audit.jsonl"), "");
    assert.equal((await readRunSecurityTelemetry(root, 51)).firewall.firewallEvidenceState, "no-traffic");

    const malformed = path.join(root, "run-52", "sandbox", "firewall", "audit");
    await mkdir(malformed, { recursive: true });
    await writeFile(path.join(root, "run-52", "aw_info.json"), JSON.stringify({ firewall: "squid" }));
    await writeFile(path.join(malformed, "audit.jsonl"), "{not-json}\n");
    const malformedTelemetry = await readRunSecurityTelemetry(root, 52);
    assert.equal(malformedTelemetry.firewall.firewallEvidenceState, "malformed");
    assert.equal(malformedTelemetry.firewall.firewallEvidenceAvailable, false);

    const partial = path.join(root, "run-54", "sandbox", "firewall", "audit");
    await mkdir(partial, { recursive: true });
    await writeFile(path.join(root, "run-54", "aw_info.json"), JSON.stringify({ firewall: "squid" }));
    await writeFile(path.join(partial, "audit.jsonl"), [
      JSON.stringify({ ts: 1788411660, host: "api.github.com:443", method: "CONNECT", status: 200 }),
      "{not-json}",
    ].join("\n"));
    const partialTelemetry = await readRunSecurityTelemetry(root, 54);
    assert.equal(partialTelemetry.firewall.firewallEvidenceState, "partial");
    assert.equal(partialTelemetry.firewall.firewallEvidenceCompleteness, "partial");
    assert.equal(partialTelemetry.firewall.observations.length, 1);

    await mkdir(path.join(root, "run-53"), { recursive: true });
    await writeFile(path.join(root, "run-53", "aw_info.json"), JSON.stringify({ firewall: "disabled" }));
    const disabled = await readRunSecurityTelemetry(root, 53);
    assert.equal(disabled.firewall.firewallEvidenceState, "disabled");
    assert.equal(disabled.firewall.firewallEnabled, false);
    assert.equal(disabled.firewall.firewallEvidenceCompleteness, "complete");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
