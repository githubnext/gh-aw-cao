import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDashboardLanguageSources,
  detectionObservationRows,
} from "../../dashboard/report/dashboard-language-sources.mjs";

function detectionRun(runId, verdict, overrides = {}) {
  return {
    repository: "githubnext/gh-aw-cao",
    runId,
    workflowPath: ".github/workflows/example.lock.yml",
    createdAt: "2026-09-05T10:00:00Z",
    mode: "review",
    security: {
      threatDetection: verdict === null
        ? { available: false, verdict: null }
        : { available: true, verdict },
    },
    ...overrides,
  };
}

function detectionJob(run, conclusion = "success") {
  return {
    organization: "githubnext",
    repository: "gh-aw-cao",
    workflow: ".github/workflows/example.md",
    run: String(run),
    job: "detection",
    "job-status": "completed",
    "job-conclusion": conclusion,
    "started-at": "2026-09-05T10:00:00Z",
    "job-duration-seconds": 12,
    runner: "ubuntu-latest",
    "run-link": {
      relation: "run",
      href: `https://github.com/githubnext/gh-aw-cao/actions/runs/${run}`,
      label: `View run ${run}`,
    },
  };
}

test("detection observations preserve verdict, warning, tooling, skipped, and unknown states", () => {
  const clear = { promptInjection: false, secretLeak: false, maliciousPatch: false, warnings: [] };
  const usage = {
    generatedAt: "2026-09-05T11:00:00Z",
    securityAvailable: true,
    securityRuns: [
      detectionRun(1, clear),
      detectionRun(2, { ...clear, promptInjection: true }),
      detectionRun(3, { ...clear, warnings: [{ field: "patch", code: "ERR_VALIDATION" }] }),
      detectionRun(4, null),
      detectionRun(5, null),
      detectionRun(6, null),
      detectionRun(8, { ...clear, promptInjection: true, secretLeak: true, maliciousPatch: true }),
    ],
  };
  const rows = detectionObservationRows(usage, [
    detectionJob(1),
    detectionJob(2),
    detectionJob(3),
    detectionJob(4),
    detectionJob(5, "failure"),
    detectionJob(6, "skipped"),
    detectionJob(8),
  ]);
  const byRun = new Map(rows.map((row) => [row.run, row]));

  assert.equal(byRun.get("1")["detection-state"], "clean");
  assert.equal(byRun.get("1")["usable-verdict-percent"], 100);
  assert.equal(byRun.get("2")["detection-state"], "threat");
  assert.equal(byRun.get("2")["detection-signal"], "Prompt injection");
  assert.equal(byRun.get("3")["detection-state"], "degraded");
  assert.equal(byRun.get("3")["inspection-warning"], "patch: ERR_VALIDATION");
  assert.equal(byRun.get("4")["detection-state"], "tooling-failure");
  assert.equal(byRun.get("5")["detection-state"], "tooling-failure");
  assert.equal(byRun.get("6")["detection-state"], "skipped");
  assert.equal(byRun.get("6")["detection-applicable"], "false");
  assert.equal(byRun.get("8")["detection-state"], "threat");
  assert.equal(byRun.get("8")["detection-signal"], "Prompt injection, Secret leak, Malicious patch");
  assert.equal(byRun.get("2")["run-link"].href, "https://github.com/githubnext/gh-aw-cao/actions/runs/2");
});

test("detection observations normalize conclusions and keep usable verdicts independent of job failures", () => {
  const clear = { promptInjection: false, secretLeak: false, maliciousPatch: false, warnings: [] };
  const rows = detectionObservationRows({
    securityAvailable: true,
    securityRuns: [
      detectionRun(10, null),
      detectionRun(11, clear),
    ],
  }, [
    detectionJob(10, "startup_failure"),
    detectionJob(11, "failure"),
  ]);
  const byRun = new Map(rows.map((row) => [row.run, row]));

  assert.equal(byRun.get("10")["detection-state"], "tooling-failure");
  assert.equal(byRun.get("10")["job-conclusion"], "startup-failure");
  assert.equal(byRun.get("11")["detection-state"], "clean");
});

test("detection observations do not claim tooling failure when collection is unavailable", () => {
  const rows = detectionObservationRows({
    generatedAt: "2026-09-05T11:00:00Z",
    securityAvailable: false,
    securityRuns: [],
  }, [
    detectionJob(7),
  ]);

  assert.equal(rows[0]["detection-state"], "unknown");
  assert.equal(rows[0]["verdict-available"], "false");
  assert.equal(rows[0]["usable-verdict-percent"], 0);
});

test("detection observations retain unavailable telemetry without an observed job", () => {
  const rows = detectionObservationRows({
    generatedAt: "2026-09-05T11:00:00Z",
    securityAvailable: true,
    securityRuns: [detectionRun(9, null)],
  });

  assert.equal(rows[0]["detection-state"], "unknown");
  assert.equal(rows[0]["detection-expected"], "unknown");
  assert.equal(rows[0]["detection-executed"], "unknown");
});

test("detection source metadata exposes incomplete evidence", () => {
  const sources = buildDashboardLanguageSources({
    deployed: {
      generatedAt: "2026-09-05T11:00:00Z",
      discovery: { complete: true },
      runHealth: { available: true, complete: false, windowHours: 168 },
      workflows: [],
      bundles: [],
    },
    usage: {
      generatedAt: "2026-09-05T11:00:00Z",
      windowHours: 168,
      available: true,
      complete: false,
      securityAvailable: true,
      securityComplete: false,
      runs: [],
      securityRuns: [],
    },
    operationalValues: { records: [] },
    report: { generatedAt: "2026-09-05T11:00:00Z", records: [] },
  });

  assert.equal(sources["detection-observations"].metadata.completeness, "partial");
  assert.equal(sources["detection-observations"].metadata["coverage-start"], "2026-08-29T11:00:00.000Z");
  assert.equal(sources["detection-observations"].metadata["coverage-end"], "2026-09-05T11:00:00Z");
});

test("dashboard source bridge declares work-oriented sources unavailable without authoritative telemetry", () => {
  const sources = buildDashboardLanguageSources({
    deployed: { discovery: { complete: true }, runHealth: {}, workflows: [], bundles: [] },
    usage: {},
    operationalValues: { records: [] },
    report: { generatedAt: "2026-09-05T12:00:00Z", records: [] },
  });

  for (const sourceName of ["work-items", "attention-signals", "agent-assignments", "evidence-records"]) {
    assert.deepEqual(sources[sourceName].rows, []);
    assert.equal(sources[sourceName].metadata.availability, "unavailable");
    assert.equal(sources[sourceName].metadata.completeness, "partial");
    assert.equal(sources[sourceName].metadata.freshness, "unknown");
  }
});

  test("dashboard source bridge exposes gh aw logs payload data points", () => {
    const logPayload = {
      run_id: 42,
      aic: 2.5,
      token_usage_summary: { total_input_tokens: 100 },
    };
    const run = {
      repository: "githubnext/gh-aw-cao",
      runId: 42,
      workflowPath: ".github/workflows/example.lock.yml",
      createdAt: "2026-09-05T10:00:00Z",
      mode: "review",
      aic: 2.5,
      logsPayload: logPayload,
      tokenUsage: {
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 50,
        cacheWriteTokens: 10,
        reasoningTokens: 7,
      },
      experiments: {
        assignments: { prompt: "candidate" },
        cumulative_counts: { prompt: { control: 1, candidate: 2 } },
      },
      graders: {
        results: [{
          id: "quality",
          name: "Quality",
          status: "pass",
          value: 0.9,
          direction: "maximize",
          threshold: 0.8,
        }],
      },
    };
    const sources = buildDashboardLanguageSources({
      deployed: {
        generatedAt: "2026-09-05T11:00:00Z",
        discovery: { complete: true },
        runHealth: { available: true, complete: true, windowHours: 24 },
        bundles: [],
        workflows: [{
          repository: run.repository,
          path: run.workflowPath,
          name: "Example",
          state: "active",
          runHealth: { runRecords: [{
            runId: 42,
            status: "completed",
            conclusion: "success",
            startedAt: run.createdAt,
            updatedAt: "2026-09-05T10:05:00Z",
          }] },
        }],
      },
      usage: {
        generatedAt: "2026-09-05T11:00:00Z",
        windowHours: 24,
        available: true,
        complete: true,
        runs: [run],
        securityRuns: [{
          ...run,
          evals: [{ id: "correctness", answer: "YES", runId: "42", timestamp: "2026-09-05T10:05:00Z" }],
        }],
      },
      operationalValues: { records: [], complete: true },
      report: { generatedAt: "2026-09-05T11:00:00Z", records: [] },
    });

    assert.equal(sources.runs.rows[0]["logs-payload"], logPayload);
    assert.deepEqual({
      "input-tokens": sources.usage.rows[0]["input-tokens"],
      "output-tokens": sources.usage.rows[0]["output-tokens"],
      "cache-read-tokens": sources.usage.rows[0]["cache-read-tokens"],
      "cache-write-tokens": sources.usage.rows[0]["cache-write-tokens"],
      "reasoning-tokens": sources.usage.rows[0]["reasoning-tokens"],
    }, {
      "input-tokens": 100,
      "output-tokens": 20,
      "cache-read-tokens": 50,
      "cache-write-tokens": 10,
      "reasoning-tokens": 7,
    });
    assert.equal(sources.experiments.rows[0].experiment, "prompt");
    assert.equal(sources["experiment-assignments"].rows[0].variant, "candidate");
    assert.equal(sources.graders.rows[0].grader, "quality");
    assert.equal(sources["grader-observations"].rows[0].value, 0.9);
    assert.equal(sources.evals.rows[0].eval, "correctness");
    assert.equal(sources["eval-observations"].rows[0]["eval-result"], "YES");
  });

test("dashboard source bridge derives work-oriented sources from run, admission, and outcome telemetry", () => {
  const sources = buildDashboardLanguageSources({
    deployed: {
      generatedAt: "2026-09-05T12:00:00Z",
      discovery: { complete: true },
      runHealth: { available: true, complete: true },
      bundles: [],
      workflows: [{
        repository: "githubnext/gh-aw-cao",
        path: ".github/workflows/dependabot.lock.yml",
        name: "Dependabot",
        role: "orchestrator",
        state: "active",
        runHealth: { runRecords: [{
          runId: 100,
          status: "completed",
          conclusion: "failure",
          startedAt: "2026-09-05T09:00:00Z",
          admissionStatus: "denied",
          admissionReason: "package-disabled",
          engine: "copilot",
          resolvedModel: "gpt-5",
        }] },
      }, {
        repository: "githubnext/gh-aw-cao",
        path: ".github/workflows/worker.lock.yml",
        name: "Worker",
        role: "worker",
        state: "active",
        runHealth: { runRecords: [{
          runId: 200,
          status: "completed",
          conclusion: "success",
          startedAt: "2026-09-05T08:00:00Z",
          engine: "copilot",
          resolvedModel: "gpt-5",
        }] },
      }],
    },
    usage: { available: true, complete: true, runs: [] },
    operationalValues: { records: [] },
    report: {
      generatedAt: "2026-09-05T12:00:00Z",
      records: [{
        id: "worker-outcome",
        repository: "githubnext/gh-aw-cao",
        runtimeRepository: "githubnext/gh-aw-cao",
        workflowPath: ".github/workflows/worker.lock.yml",
        runUrl: "https://github.com/githubnext/gh-aw-cao/actions/runs/200",
        conclusion: "success",
        mode: "review",
        state: "closed",
        kind: "issue",
        title: "Do the thing",
      }],
    },
  });

  assert.equal(sources["work-items"].metadata.availability, "available");
  assert.equal(sources["work-items"].metadata.completeness, "complete");
  const workItems = new Map(sources["work-items"].rows.map((row) => [row["work-item-id"], row]));
  const dependabot = workItems.get("githubnext/gh-aw-cao:.github/workflows/dependabot.md");
  const worker = workItems.get("githubnext/gh-aw-cao:.github/workflows/worker.md");
  assert.equal(dependabot["lifecycle-state"], "blocked");
  assert.equal(dependabot.reason, "package-disabled");
  assert.equal(dependabot["consequence-tier"], "high");
  assert.equal(worker["lifecycle-state"], "completed");
  assert.equal(worker["verification-state"], "accepted");

  assert.equal(sources["attention-signals"].metadata.availability, "available");
  assert.deepEqual(sources["attention-signals"].rows.map((row) => row["work-item-id"]), [dependabot["work-item-id"]]);
  assert.equal(sources["attention-signals"].rows[0]["signal-type"], "blocked");

  assert.equal(sources["agent-assignments"].metadata.availability, "available");
  const assignments = new Map(sources["agent-assignments"].rows.map((row) => [row["work-item-id"], row]));
  assert.equal(assignments.get(dependabot["work-item-id"])["agent-state"], "blocked");
  assert.equal(assignments.get(worker["work-item-id"])["agent-state"], "completed");

  assert.equal(sources["evidence-records"].metadata.availability, "available");
  assert.equal(sources["evidence-records"].rows.length, 2);
  assert.deepEqual(sources["evidence-records"].rows.map((row) => row["work-item-id"]), [worker["work-item-id"], worker["work-item-id"]]);
  assert.deepEqual(new Set(sources["evidence-records"].rows.map((row) => row["evidence-class"])), new Set(["outcome", "finding"]));
  assert.ok(sources["evidence-records"].rows.every((row) => row["verification-state"] === "accepted" || row["verification-state"] === "pending"));
});

test("dashboard source bridge classifies safe-output performance and diagnostics", () => {
  const sources = buildDashboardLanguageSources({
    deployed: { discovery: { complete: true }, runHealth: {}, workflows: [], bundles: [] },
    usage: {
      available: true,
      complete: true,
      securityAvailable: true,
      securityComplete: true,
      generatedAt: "2026-09-05T12:00:00Z",
      windowHours: 24,
      securityRuns: [{
        repository: "githubnext/gh-aw-cao",
        runId: 42,
        workflowPath: ".github/workflows/review.lock.yml",
        mode: "review",
        conclusion: "success",
        createdAt: "2026-09-05T11:00:00Z",
        safeItemsCount: 3,
        noopCount: 1,
        missingDataCount: 2,
        missingToolCount: 1,
        reportIncompleteCount: 1,
      }],
    },
    operationalValues: { records: [] },
    report: { generatedAt: "2026-09-05T12:00:00Z", records: [] },
  });

  assert.deepEqual(
    sources["safe-output-performance"].rows.map((row) => ({
      kind: row["safe-output-kind"],
      status: row["safe-output-status"],
      count: row["safe-output-count"],
    })),
    [
      { kind: "output", status: "success", count: 3 },
      { kind: "noop", status: "neutral", count: 1 },
      { kind: "missing_data", status: "warning", count: 2 },
      { kind: "missing_tool", status: "warning", count: 1 },
      { kind: "report_incomplete", status: "warning", count: 1 },
    ],
  );
  assert.equal(sources["safe-output-performance"].metadata.completeness, "complete");
  assert.equal(sources["safe-output-performance"].metadata["coverage-start"], "2026-09-04T12:00:00.000Z");
});

test("dashboard source bridge expands GitHub telemetry resources", () => {
  const sources = buildDashboardLanguageSources({
    deployed: { discovery: { complete: true }, runHealth: {}, workflows: [], bundles: [] },
    usage: {},
    operationalValues: { records: [] },
    report: { generatedAt: "2026-09-04T12:00:00Z", records: [] },
    githubTelemetry: [{
      observedAt: "2026-09-04T11:59:00Z",
      phase: "after",
      operation: "refresh-activity",
      outcome: "success",
      tokenType: "app",
      rateLimit: {
        core: { limit: 5_000, used: 125, remaining: 4_875, resetAt: "2026-09-04T13:00:00Z" },
      },
      rateLimitError: null,
      stackTrace: [
        "at recordGithubTelemetry (activity/github-telemetry.mjs:100:16)",
        "at main (activity/github-telemetry.mjs:150:9)",
      ],
      activityCache: { hydrated: true, bytes: 1024, entryCount: 6, folderCount: 2 },
    }],
  });

  test("dashboard source bridge explains configuration health and proposes bounded rollout actions", () => {
    const document = {
      version: 1,
      "control-plane": {
        scope: { "allowed-owners": ["acme"] },
        packages: {
          dependabot: {
            mode: "review",
            workers: {
              updater: { workflow: "dependabot-updater", enabled: false },
            },
          },
        },
      },
    };
    const sources = buildDashboardLanguageSources({
      deployed: { discovery: { complete: true }, runHealth: {}, workflows: [], bundles: [] },
      usage: {},
      operationalValues: { records: [] },
      report: { generatedAt: "2026-09-04T12:00:00Z", records: [] },
      controlSettings: {
        policy_resolution: { status: "available", reason: "" },
        policy_document: document,
        policy_source: JSON.stringify(document, null, 2),
      },
    });

    assert.deepEqual(sources["configuration-summary"].rows, [
      { status: "Valid", count: 1 },
      { status: "Warnings", count: 1 },
      { status: "Guidance", count: 1 },
    ]);
    assert.equal(sources["configuration-policy"].rows[0].document, document);
    assert.match(sources["configuration-policy"].rows[0].raw, /"control-plane"/);
    assert.deepEqual(
      sources["configuration-actions"].rows.map((row) => row.action),
      ["Promote dependabot to live", "Enable updater"],
    );
    assert.match(sources["configuration-actions"].rows[0].prompt, /target-owned authority/);
  });

  assert.deepEqual(sources["github-api-rate-limits"].rows, [{
    "observation-id": "unknown:after:app:core:2026-09-04T11:59:00Z",
    "operation-execution-id": "unknown",
    "observed-at": "2026-09-04T11:59:00Z",
    phase: "after",
    operation: "refresh-activity",
    outcome: "success",
    credential: "app",
    "credential-type": "app",
    resource: "core",
    bucket: "core · app",
    "maximum-lane": "core · app · max 5000",
    "history-series": "core · app",
    "has-history": false,
    limit: 5_000,
    used: 125,
    remaining: 4_875,
    "remaining-percent": 97.5,
    "reset-at": "2026-09-04T13:00:00Z",
    "minutes-to-reset": 61,
    "consumed-since-previous": null,
    "burn-rate-per-minute": null,
    "projected-remaining-at-reset": null,
    "projected-exhaustion-at": null,
    "runway-ratio": null,
    "risk-status": "unknown",
    "risk-order": 3,
    "is-current": true,
    "attribution-status": "unavailable",
    "operation-consumed": null,
  }]);
  assert.deepEqual(sources["github-api-collector-health"].rows, [{
    "observed-at": "2026-09-04T11:59:00Z",
    "operation-execution-id": "unknown",
    phase: "after",
    operation: "refresh-activity",
    outcome: "success",
    credential: "app",
    "cache-hydrated": true,
    "cache-bytes": 1024,
    "cache-entries": 6,
    "cache-folders": 2,
    "rate-limit-error": "",
  }]);
  assert.deepEqual(sources["github-api-call-stacks"].rows, [
    {
      "observed-at": "2026-09-04T11:59:00Z",
      "operation-execution-id": "unknown",
      phase: "after",
      operation: "refresh-activity",
      outcome: "success",
      credential: "app",
      "stack-frame-id": "unknown:after:2026-09-04T11:59:00Z:0",
      "stack-parent-id": "",
      "stack-depth": 0,
      "stack-frame": "at main (activity/github-telemetry.mjs:150:9)",
    },
    {
      "observed-at": "2026-09-04T11:59:00Z",
      "operation-execution-id": "unknown",
      phase: "after",
      operation: "refresh-activity",
      outcome: "success",
      credential: "app",
      "stack-frame-id": "unknown:after:2026-09-04T11:59:00Z:1",
      "stack-parent-id": "unknown:after:2026-09-04T11:59:00Z:0",
      "stack-depth": 1,
      "stack-frame": "at recordGithubTelemetry (activity/github-telemetry.mjs:100:16)",
    },
  ]);
  assert.equal(sources["github-api-rate-limits"].metadata.availability, "available");
  assert.equal(sources["github-api-rate-limits"].metadata.completeness, "complete");
});

test("dashboard source bridge derives reset-safe rate-limit forecasts and correlated attribution", () => {
  const checkpoint = (observedAt, remaining, phase, pairId, resetAt = "2026-09-04T13:00:00Z") => ({
    observedAt,
    phase,
    pairId,
    operation: "refresh-activity",
    outcome: "success",
    tokenType: "app",
    credentialRole: "activity-reader",
    rateLimit: { core: { limit: 100, used: 100 - remaining, remaining, resetAt } },
    rateLimitError: null,
    activityCache: {},
  });
  const sources = buildDashboardLanguageSources({
    deployed: { discovery: { complete: true }, runHealth: {}, workflows: [], bundles: [] },
    usage: {},
    operationalValues: { records: [] },
    report: { generatedAt: "2026-09-04T11:01:00Z", records: [] },
    githubTelemetry: [
      checkpoint("2026-09-04T10:00:00Z", 100, "before", "run-1"),
      checkpoint("2026-09-04T10:30:00Z", 90, "after", "run-1"),
      checkpoint("2026-09-04T11:00:00Z", 80, "after", "run-2"),
    ],
  });

  const rows = sources["github-api-rate-limits"].rows;
  assert.equal(rows[1]["operation-consumed"], 10);
  assert.equal(rows[1]["attribution-status"], "available");
  assert.equal(rows[0]["has-history"], false);
  assert.equal(rows[1]["has-history"], true);
  assert.equal(rows[2]["consumed-since-previous"], 10);
  assert.equal(rows[2]["has-history"], true);
  assert.equal(rows[2]["burn-rate-per-minute"], 0.333);
  assert.equal(rows[2]["projected-remaining-at-reset"], 40);
  assert.equal(rows[2]["projected-exhaustion-at"], "2026-09-04T15:00:00.000Z");
  assert.equal(rows[2]["runway-ratio"], 2);
  assert.equal(rows[2]["risk-status"], "healthy");
  assert.equal(rows[2]["is-current"], true);
});

test("dashboard source bridge never carries burn forecasts across reset windows", () => {
  const entries = [
    ["2026-09-04T10:00:00Z", 20, "2026-09-04T11:00:00Z"],
    ["2026-09-04T10:20:00Z", 10, "2026-09-04T11:00:00Z"],
    ["2026-09-04T10:40:00Z", 0, "2026-09-04T11:00:00Z"],
    ["2026-09-04T11:01:00Z", 100, "2026-09-04T12:00:00Z"],
  ].map(([observedAt, remaining, resetAt]) => ({
    observedAt,
    phase: "after",
    operation: "refresh",
    tokenType: "app",
    rateLimit: { core: { limit: 100, remaining, resetAt } },
    activityCache: {},
  }));
  const sources = buildDashboardLanguageSources({
    deployed: { discovery: { complete: true }, runHealth: {}, workflows: [], bundles: [] },
    usage: {},
    operationalValues: { records: [] },
    report: { generatedAt: "2026-09-04T11:02:00Z", records: [] },
    githubTelemetry: entries,
  });

  const rows = sources["github-api-rate-limits"].rows;
  assert.equal(rows[2]["risk-status"], "critical");
  assert.equal(rows[2]["is-current"], false);
  assert.equal(rows[3]["consumed-since-previous"], null);
  assert.equal(rows[3]["burn-rate-per-minute"], null);
  assert.equal(rows[3]["risk-status"], "unknown");
  assert.equal(rows[3]["is-current"], true);
});

test("dashboard source bridge exposes stale and partial rate-limit evidence as unknown", () => {
  const base = {
    observedAt: "2026-09-04T10:00:00Z",
    phase: "after",
    operation: "refresh",
    tokenType: "app",
    rateLimit: { search: { limit: 30, used: 27, remaining: 3, resetAt: "2026-09-04T11:00:00Z" } },
    activityCache: {},
  };
  const sources = buildDashboardLanguageSources({
    deployed: { discovery: { complete: true }, runHealth: {}, workflows: [], bundles: [] },
    usage: {},
    operationalValues: { records: [] },
    report: { generatedAt: "2026-09-04T12:00:01Z", records: [] },
    githubTelemetry: [
      base,
      { ...base, observedAt: "2026-09-04T10:01:00Z", rateLimit: {}, rateLimitError: "unavailable" },
      { ...base, observedAt: "2026-09-04T10:02:00Z" },
    ],
  });

  assert.equal(sources["github-api-rate-limits"].metadata.freshness, "stale");
  assert.equal(sources["github-api-rate-limits"].metadata.completeness, "partial");
  assert.equal(sources["github-api-rate-limits"].rows[0]["risk-status"], "unknown");
  assert.equal(sources["github-api-rate-limits"].rows[1]["burn-rate-per-minute"], null);
  assert.equal(sources["github-api-rate-limits"].rows[1]["projected-exhaustion-at"], null);
  assert.equal(sources["github-api-rate-limits"].rows[1]["history-series"], "search · app · segment 2");
  assert.equal(sources["github-api-collector-health"].rows[1]["rate-limit-error"], "unavailable");
});

test("dashboard source bridge diagnoses telemetry without valid rate-limit data", () => {
  const sources = buildDashboardLanguageSources({
    deployed: { discovery: { complete: true }, runHealth: {}, workflows: [], bundles: [] },
    usage: {},
    operationalValues: { records: [] },
    report: { generatedAt: "2026-09-04T12:00:00Z", records: [] },
    githubTelemetry: [{
      schemaVersion: 1,
      observedAt: "2026-09-04T11:59:00Z",
      phase: "after",
      operation: "refresh-activity",
      rateLimit: {},
      rateLimitError: null,
      activityCache: {},
    }],
  });

  assert.deepEqual(sources["github-api-rate-limits"].rows, []);
  assert.equal(sources["github-api-rate-limits"].metadata.availability, "unavailable");
  assert.equal(sources["github-api-rate-limits"].metadata.completeness, "partial");
  assert.equal(
    sources["github-api-collector-health"].rows[0]["rate-limit-error"],
    "GitHub API returned no valid rate-limit resources.",
  );
});

test("dashboard source bridge carries API capacity admission blocks into run rows", () => {
  const workflowPath = ".github/workflows/self-care.lock.yml";
  const sources = buildDashboardLanguageSources({
    deployed: {
      generatedAt: "2026-09-02T21:00:00Z",
      discovery: { complete: true },
      runHealth: { available: true, complete: true },
      bundles: [],
      workflows: [{
        repository: "githubnext/gh-aw-cao",
        path: workflowPath,
        name: "SelfCare",
        state: "active",
        runHealth: { runRecords: [{
          runId: 33682053183,
          status: "completed",
          conclusion: "failure",
          event: "schedule",
          startedAt: "2026-09-02T20:54:26Z",
          updatedAt: "2026-09-02T20:54:39Z",
          admissionStatus: "resource-limited",
          admissionReason: "github-api-capacity-insufficient",
          failureJob: "pre_activation",
          failureMessage: "Target authority missing",
          failureStep: "CAO admission blocked: GitHub API limited until 2026-09-02T22:04:33.000Z",
          resource: "github-rest-api",
          resourceResetAt: "2026-09-02T22:04:33.000Z",
          resourceWaitHours: 1.08,
        }] },
      }],
    },
    usage: { available: true, complete: true, runs: [] },
    operationalValues: { records: [] },
    report: { generatedAt: "2026-09-02T21:00:00Z", records: [] },
  });

  test("dashboard source bridge exposes structured admission decisions and gate checks", () => {
    const admission = {
      schemaVersion: 1,
      observedAt: "2026-09-05T10:00:00.000Z",
      repository: "githubnext/gh-aw-cao",
      workflow: "Dependabot",
      workflowSha: "1111111111111111111111111111111111111111",
      runId: "42",
      runAttempt: 1,
      package: "dependabot",
      role: "orchestrator",
      worker: "",
      targetRepository: "",
      authorized: false,
      reason: "package-disabled",
      failedCheck: "Package",
      checks: [
        { check: "Runtime revision", status: "passed" },
        { check: "Package", status: "failed" },
      ],
    };
    const sources = buildDashboardLanguageSources({
      deployed: {
        generatedAt: "2026-09-05T10:05:00.000Z",
        discovery: { complete: true },
        runHealth: {
          available: true,
          complete: true,
          windowHours: 168,
          admissionEvidence: { available: true, complete: true },
        },
        bundles: [],
        workflows: [{
          repository: "githubnext/gh-aw-cao",
          path: ".github/workflows/dependabot.lock.yml",
          name: "Dependabot",
          role: "orchestrator",
          state: "active",
          runHealth: { runRecords: [{
            runId: 42,
            runAttempt: 1,
            status: "completed",
            conclusion: "success",
            admission,
          }] },
        }],
      },
      usage: { available: true, complete: true, runs: [] },
      operationalValues: { records: [] },
      report: { generatedAt: "2026-09-05T10:05:00.000Z", records: [] },
    });

    assert.equal(sources.admissions.metadata.completeness, "complete");
    assert.deepEqual(sources.admissions.rows[0], {
      organization: "githubnext",
      repository: "gh-aw-cao",
      workflow: ".github/workflows/dependabot.md",
      run: "42",
      "observed-at": "2026-09-05T10:00:00.000Z",
      package: "dependabot",
      "workflow-role": "orchestrator",
      worker: "",
      "target-repository": "",
      "admission-status": "denied",
      "admission-reason": "package-disabled",
      "failed-check": "Package",
      "github-api-status": "unknown",
      "github-api-remaining": null,
      "github-api-required": null,
      "github-api-reset-at": "",
      "runner-disk-status": "unknown",
      "runner-disk-available-mb": null,
      "runner-disk-required-mb": null,
      "run-link": {
        relation: "run",
        href: "https://github.com/githubnext/gh-aw-cao/actions/runs/42",
        label: "Run 42",
      },
    });
    assert.deepEqual(sources["admission-checks"].rows.map((row) => ({
      check: row.check,
      order: row["check-order"],
      status: row["check-status"],
    })), [
      { check: "Runtime revision", order: 1, status: "passed" },
      { check: "Package", order: 2, status: "failed" },
    ]);
  });

  assert.deepEqual(
    Object.fromEntries(Object.entries(sources.runs.rows[0]).filter(([key]) => [
      "admission-status", "admission-reason", "failure-job", "failure-message", "failure-step", "resource", "resource-reset-at", "resource-wait-hours",
    ].includes(key))),
    {
      "admission-status": "resource-limited",
      "admission-reason": "github-api-capacity-insufficient",
      "failure-job": "pre_activation",
      "failure-message": "Target authority missing",
      "failure-step": "CAO admission blocked: GitHub API limited until 2026-09-02T22:04:33.000Z",
      resource: "github-rest-api",
      "resource-reset-at": "2026-09-02T22:04:33.000Z",
      "resource-wait-hours": 1.08,
    },
  );
});

test("dashboard source bridge attaches usage data payloads to every run row", () => {
  const sources = buildDashboardLanguageSources({
    deployed: {
      generatedAt: "2026-09-03T06:00:00Z",
      discovery: { complete: true },
      runHealth: { available: true, complete: true },
      bundles: [],
      workflows: [{
        repository: "githubnext/gh-aw-cao",
        path: ".github/workflows/data.lock.yml",
        name: "Data",
        state: "active",
        runHealth: {
          runRecords: [
            { runId: 42, status: "completed", conclusion: "success" },
            { runId: 43, status: "completed", conclusion: "success" },
            { runId: 44, status: "completed", conclusion: "success" },
          ],
        },
      }],
    },
    usage: {
      available: true,
      complete: true,
      runs: [{
        repository: "githubnext/gh-aw-cao",
        runId: 42,
        aic: 1,
        data: { findings: [{ severity: "high", total: 3 }] },
      }],
      securityRuns: [{
        repository: "githubnext/gh-aw-cao",
        runId: 43,
        data: { summary: { total: 7 } },
      }],
    },
    operationalValues: { records: [] },
    report: { generatedAt: "2026-09-03T06:00:00Z", records: [] },
  });

  assert.deepEqual(sources.runs.rows.map((run) => run.data), [
    { findings: [{ severity: "high", total: 3 }] },
    { summary: { total: 7 } },
    null,
  ]);
});

test("dashboard source bridge detects rollout mode from run titles with punctuation separators", () => {
  const sources = buildDashboardLanguageSources({
    deployed: {
      generatedAt: "2026-09-03T06:00:00Z",
      discovery: { complete: true },
      runHealth: { available: true, complete: true },
      bundles: [],
      workflows: [{
        repository: "githubnext/gh-aw-cao",
        path: ".github/workflows/review-live.lock.yml",
        name: "Review Live",
        state: "active",
        runHealth: { runRecords: [{
          runId: 99,
          status: "completed",
          conclusion: "success",
          displayTitle: "Review Live: review",
          startedAt: "2026-09-03T05:00:00Z",
          updatedAt: "2026-09-03T05:10:00Z",
        }] },
      }],
    },
    usage: { available: true, complete: true, runs: [] },
    operationalValues: { records: [] },
    report: { generatedAt: "2026-09-03T06:00:00Z", records: [] },
  });

  test("dashboard source bridge exposes chart summaries and in-depth security observations", () => {
    const sources = buildDashboardLanguageSources({
      deployed: {
        generatedAt: "2026-09-03T06:00:00Z",
        discovery: { complete: true },
        runHealth: { available: true, complete: true },
        bundles: [],
        workflows: [],
      },
      usage: {
        available: true,
        complete: true,
        securityAvailable: true,
        securityComplete: true,
        runs: [],
        securityRuns: [{
          repository: "githubnext/gh-aw-cao",
          runId: 42,
          workflowPath: ".github/workflows/security.lock.yml",
          createdAt: "2026-09-03T05:00:00Z",
          security: {
            accessControl: {
              available: true,
              fileDenials: { read: 2 },
              toolDenials: { shell: 1 },
              guardPolicy: { repo_scope_blocked: 1 },
            },
            firewall: {
              available: true,
              analysis: {
                allowed_requests: 8,
                blocked_requests: 2,
                requests_by_domain: {
                  "api.github.com:443": { allowed: 8 },
                  "blocked.example:443": { blocked: 2 },
                },
              },
            },
            integrity: {
              available: true,
              totalToolCalls: 6,
              summary: {
                total_filtered: 2,
                filtered_tool_counts: { create_issue: 2 },
                filtered_reason_counts: { integrity: 2 },
              },
            },
            mcp: {
              available: true,
              cliVersion: "0.88.0",
              servers: [{
                serverName: "github",
                serverVersion: "1.2.3",
                protocolVersion: "2025-06-18",
                toolCallCount: 2,
                errorCount: 1,
                totalOutputSize: 12_000,
                maxOutputSize: 8_000,
              }],
              calls: [
                {
                  timestamp: "2026-09-03T05:01:00Z",
                  serverName: "github",
                  toolName: "issue_read",
                  status: "success",
                  outputSize: 4_000,
                },
                {
                  timestamp: "2026-09-03T05:02:00Z",
                  serverName: "github",
                  toolName: "search_code",
                  status: "failure",
                  outputSize: 8_000,
                },
              ],
              failures: [],
            },
            threatDetection: {
              available: true,
              verdict: {
                promptInjection: true,
                secretLeak: false,
                maliciousPatch: false,
                warnings: [{ field: "patch", code: "ERR_VALIDATION" }],
              },
            },
          },
        }],
      },
      operationalValues: { records: [] },
      report: { generatedAt: "2026-09-03T06:00:00Z", records: [] },
    });

    const rows = sources["security-observations"].rows;
    assert.equal(sources["security-observations"].metadata.completeness, "complete");
    assert.ok(rows.some((row) => row["security-feature"] === "access-control"
      && row["security-analysis"] === "summary"
      && row["security-signal"] === "File access denied"
      && row["security-count"] === 2));
    assert.ok(rows.some((row) => row["security-feature"] === "firewall"
      && row["security-analysis"] === "detail"
      && row["security-subject"] === "blocked.example:443"
      && row["security-status"] === "blocked"
      && row["security-count"] === 2));
    assert.ok(rows.some((row) => row["security-feature"] === "firewall"
      && row["security-analysis"] === "detail"
      && row["security-subject"] === "api.github.com:443"
      && row["security-status"] === "allowed"
      && row["security-count"] === 8));
    assert.ok(sources["firewall-observations"].rows.some((row) => row.domain === "api.github.com"
      && row.port === 443
      && row.protocol === "https"
      && row.decision === "allowed"
      && row["request-count"] === 8));
    assert.ok(rows.some((row) => row["security-feature"] === "integrity-filtering"
      && row["security-subject"] === "create_issue"));
    assert.ok(rows.some((row) => row["security-feature"] === "integrity-filtering"
      && row["security-signal"] === "Passed interactions"
      && row["security-count"] === 4));
    assert.ok(rows.some((row) => row["security-feature"] === "threat-detection"
      && row["security-signal"] === "Prompt injection"
      && row["security-status"] === "detected"));
    assert.equal(sources["detection-observations"].metadata.completeness, "complete");
    assert.equal(sources["detection-observations"].rows[0]["detection-state"], "threat");
    assert.equal(sources["detection-observations"].rows[0]["inspection-warning"], "patch: ERR_VALIDATION");
    assert.deepEqual(sources["mcp-calls"].rows.map((row) => ({
      server: row["mcp-server"],
      tool: row["mcp-tool"],
      status: row["mcp-status"],
      bytes: row["response-bytes"],
    })), [
      { server: "github", tool: "issue_read", status: "success", bytes: 4_000 },
      { server: "github", tool: "search_code", status: "failure", bytes: 8_000 },
    ]);
    assert.deepEqual(sources["mcp-servers"].rows[0], {
      organization: "githubnext",
      repository: "gh-aw-cao",
      workflow: ".github/workflows/security.md",
      run: "42",
      "rollout-mode": "unknown",
      "engine-version": "unknown",
      "gh-aw-version": "0.88.0",
      "observed-at": "2026-09-03T05:00:00Z",
      "run-link": {
        relation: "run",
        href: "https://github.com/githubnext/gh-aw-cao/actions/runs/42",
        label: "Run 42",
      },
      "mcp-server-observation": "githubnext/gh-aw-cao:42:github",
      "mcp-server": "github",
      "mcp-server-version": "1.2.3",
      "mcp-protocol-version": "2025-06-18",
      "mcp-status": "failure",
      "tool-calls": 2,
      "failed-calls": 1,
      "total-response-bytes": 12_000,
      "max-response-bytes": 8_000,
    });
    assert.equal(sources["mcp-servers"].metadata.completeness, "partial");
  });

  assert.equal(sources.runs.rows[0]["rollout-mode"], "review");
});

test("dashboard source bridge omits mcp-calls rows when mcp telemetry is unavailable and correctly counts mcp failures", () => {
  const sources = buildDashboardLanguageSources({
    deployed: {
      generatedAt: "2026-09-03T06:00:00Z",
      discovery: { complete: true },
      runHealth: { available: true, complete: true },
      bundles: [],
      workflows: [],
    },
    usage: {
      available: true,
      complete: true,
      securityAvailable: true,
      securityComplete: true,
      runs: [],
      securityRuns: [
        {
          repository: "githubnext/gh-aw-cao",
          workflowName: "Security",
          workflowPath: ".github/workflows/security.lock.yml",
          runId: 101,
          mode: "review",
          createdAt: "2026-09-03T05:00:00Z",
          security: {
            accessControl: { available: false, fileDenials: {}, toolDenials: {} },
            firewall: { available: false },
            integrity: { available: false, totalToolCalls: 0, summary: {} },
            mcp: { available: false, cliVersion: null, servers: [], calls: [], failures: [] },
            threatDetection: { available: false },
          },
        },
        {
          repository: "githubnext/gh-aw-cao",
          workflowName: "Security",
          workflowPath: ".github/workflows/security.lock.yml",
          runId: 102,
          mode: "review",
          createdAt: "2026-09-03T05:00:00Z",
          security: {
            accessControl: { available: false, fileDenials: {}, toolDenials: {} },
            firewall: { available: false },
            integrity: { available: false, totalToolCalls: 0, summary: {} },
            mcp: {
              available: true,
              cliVersion: "0.88.0",
              servers: [{
                serverName: "playwright",
                serverVersion: "1.0.0",
                protocolVersion: "2025-06-18",
                toolCallCount: 0,
                errorCount: 0,
                totalOutputSize: 0,
                maxOutputSize: 0,
              }],
              calls: [],
              failures: [{ serverName: "playwright", status: "failure" }],
            },
            threatDetection: { available: false },
          },
        },
        {
          repository: "githubnext/gh-aw-cao",
          workflowName: "Security",
          workflowPath: ".github/workflows/security.lock.yml",
          runId: 103,
          mode: "review",
          createdAt: "2026-09-03T05:00:00Z",
          security: {
            accessControl: { available: false, fileDenials: {}, toolDenials: {} },
            firewall: { available: false },
            integrity: { available: false, totalToolCalls: 0, summary: {} },
            mcp: {
              available: true,
              cliVersion: "0.88.0",
              servers: [{
                serverName: "github",
                serverVersion: "1.0.0",
                protocolVersion: "2025-06-18",
                toolCallCount: 2,
                errorCount: 1,
                totalOutputSize: 10,
                maxOutputSize: 10,
              }],
              calls: [],
              failures: [{ serverName: "github", status: "failure" }],
            },
            threatDetection: { available: false },
          },
        },
      ],
    },
    operationalValues: { records: [] },
    report: { generatedAt: "2026-09-03T06:00:00Z", records: [] },
  });

  assert.equal(sources["mcp-calls"].rows.filter((row) => row.run === "101").length, 0);

  const serverRow = sources["mcp-servers"].rows.find((row) => row.run === "102");
  assert.equal(serverRow["mcp-status"], "failure");
  assert.equal(serverRow["failed-calls"], 1);
  const aggregatedFailureRow = sources["mcp-servers"].rows.find((row) => row.run === "103");
  assert.equal(aggregatedFailureRow["failed-calls"], 1);
});

test("dashboard source bridge exposes run and job performance dimensions", () => {
  const sources = buildDashboardLanguageSources({
    deployed: {
      generatedAt: "2026-09-03T06:00:00Z",
      discovery: { complete: true },
      runHealth: { available: true, complete: true, windowHours: 24 },
      workflows: [{
        repository: "acme/control",
        path: ".github/workflows/review.lock.yml",
        runHealth: { runRecords: [{
          runId: 42,
          status: "completed",
          conclusion: "success",
          displayTitle: "Review: live",
          startedAt: "2026-09-03T05:00:00Z",
          updatedAt: "2026-09-03T05:10:00Z",
          jobs: [{
            name: "agent",
            status: "completed",
            conclusion: "success",
            startedAt: "2026-09-03T05:01:00Z",
            completedAt: "2026-09-03T05:08:30Z",
            runnerName: "GitHub Actions 2",
            runnerGroupName: "GitHub Actions",
            labels: ["ubuntu-latest"],
          }, {
            name: "detection",
            status: "in_progress",
            conclusion: null,
            startedAt: "2026-09-03T05:09:00Z",
            completedAt: null,
            runnerName: "GitHub Actions 3",
            runnerGroupName: "GitHub Actions",
            labels: ["ubuntu-latest"],
          }],
        }] },
      }],
    },
    usage: {
      available: true,
      complete: true,
      runs: [{
        repository: "acme/control",
        runId: 42,
        engine: "copilot",
        requestedModel: "gpt-5",
        resolvedModel: "gpt-5.4",
        agentRuntime: "gvisor",
        aic: 12,
      }],
    },
    operationalValues: { records: [] },
    report: { generatedAt: "2026-09-03T06:00:00Z", records: [] },
  });

  assert.match(sources["run-performance"].metadata["coverage-start"], /^2026-09-02/);
  assert.deepEqual(sources["run-performance"].rows[0], {
    organization: "acme",
    repository: "control",
    workflow: ".github/workflows/review.md",
    run: "42",
    "started-at": "2026-09-03T05:00:00Z",
    "run-conclusion": "success",
    "rollout-mode": "live",
    engine: "copilot",
    "sandbox-runtime": "gvisor",
    model: "gpt-5.4",
    "run-link": {
      relation: "run",
      href: "https://github.com/acme/control/actions/runs/42",
      label: "View run 42",
    },
    "run-duration-seconds": 600,
  });
  const { "run-duration-seconds": _runDuration, ...commonPerformance } = sources["run-performance"].rows[0];
  assert.deepEqual(sources["job-performance"].rows[0], {
    ...commonPerformance,
    job: "agent",
    "job-status": "completed",
    "job-conclusion": "success",
    runner: "ubuntu-latest",
    "runner-name": "GitHub Actions 2",
    "runner-group": "GitHub Actions",
    "job-duration-seconds": 450,
  });
  assert.deepEqual(sources["job-performance"].rows[1], {
    ...commonPerformance,
    job: "detection",
    "job-status": "in_progress",
    "job-conclusion": "unknown",
    runner: "ubuntu-latest",
    "runner-name": "GitHub Actions 3",
    "runner-group": "GitHub Actions",
    "job-duration-seconds": null,
  });
});

test("dashboard source bridge keeps partial workflow inventory available when discovery is incomplete", () => {
  const input = {
    deployed: {
      generatedAt: "2026-09-03T06:00:00Z",
      discovery: { complete: false },
      runHealth: { available: false, complete: false },
      bundles: [],
      workflows: [{
        repository: "githubnext/gh-aw-cao",
        path: ".github/workflows/self-care.lock.yml",
        name: "SelfCare",
        state: "active",
      }],
    },
    usage: { available: false, complete: false, runs: [] },
    operationalValues: { records: [] },
    report: { generatedAt: "2026-09-03T06:00:00Z", records: [] },
  };

  const partial = buildDashboardLanguageSources(input);
  assert.equal(partial.workflows.rows.length, 1);
  assert.equal(partial.workflows.metadata.availability, "available");
  assert.equal(partial.workflows.metadata.completeness, "partial");

  const unavailable = buildDashboardLanguageSources({
    ...input,
    deployed: { ...input.deployed, workflows: [] },
  });
  assert.equal(unavailable.workflows.rows.length, 0);
  assert.equal(unavailable.workflows.metadata.availability, "unavailable");
  assert.equal(unavailable.workflows.metadata.completeness, "partial");
});

test("dashboard source bridge keeps collected runs available when run health is partial", () => {
  const sources = buildDashboardLanguageSources({
    deployed: {
      generatedAt: "2026-09-03T06:00:00Z",
      discovery: { complete: true },
      runHealth: { available: false, complete: false },
      bundles: [],
      workflows: [{
        repository: "githubnext/gh-aw-cao",
        path: ".github/workflows/self-care.lock.yml",
        name: "SelfCare",
        state: "active",
        runHealth: {
          runRecords: [{
            runId: 42,
            status: "completed",
            conclusion: "success",
            startedAt: "2026-09-03T05:00:00Z",
          }],
        },
      }],
    },
    usage: { available: false, complete: false, runs: [] },
    operationalValues: { records: [] },
    report: { generatedAt: "2026-09-03T06:00:00Z", records: [] },
  });

  assert.equal(sources.runs.rows.length, 1);
  assert.equal(sources.runs.metadata.availability, "available");
  assert.equal(sources.runs.metadata.completeness, "partial");
});

test("dashboard source bridge carries package memberships, allowance, and inventory readiness into workflow rows", () => {
  const workflowPath = ".github/workflows/package.lock.yml";
  const sources = buildDashboardLanguageSources({
    deployed: {
      generatedAt: "2026-08-30T12:00:00Z",
      latestGhAwVersion: "v0.88.0",
      discovery: { complete: true },
      runHealth: { available: true, complete: true },
      bundles: [{
        repository: "githubnext/gh-aw-cao",
        path: "aw.yml",
        name: "Central Agentic Ops",
        workflows: [{ lockPath: workflowPath }],
      }, {
        repository: "githubnext/gh-aw-cao",
        path: "ambient-context/aw.yml",
        name: "Ambient Context",
        workflows: [{ lockPath: workflowPath }],
      }],
      workflows: [{
        repository: "githubnext/gh-aw-cao",
        path: workflowPath,
        name: "Package",
        role: "orchestrator",
        state: "active",
        ghAwVersion: "v0.88.0",
        updateState: "up-to-date",
        ghAwMetadata: { compiler_version: "v0.88.0", strict: true },
        ghAwManifest: { version: 1, actions: [] },
        runHealth: { runRecords: [] },
      }],
    },
    usage: { available: true, complete: true, runs: [] },
    operationalValues: { records: [] },
    report: {
      generatedAt: "2026-08-30T12:00:00Z",
      records: [{
        id: "ambient-context-output",
        bundle: "ambient-context",
        repository: "githubnext/target",
        runtimeRepository: "githubnext/gh-aw-cao",
        workflowPath,
        runUrl: "https://github.com/githubnext/gh-aw-cao/actions/runs/42",
        conclusion: "failure",
        mode: "review",
      }],
    },
    inventory: {
      workflows: [{ lockPath: workflowPath, maxAiCredits: 500, compiled: true }],
      bundles: [{
        id: "ambient-context",
        name: "Ambient Context",
        workflow: ".github/workflows/package.md",
        controlPackage: "ambient-context",
        maxAiCredits: 500,
        compiled: true,
        missingWorkers: [],
        workers: [],
      }],
    },
    controlSettings: {
      packages: { "ambient-context": { mode: "review", icon: "workflow" } },
    },
  });

  assert.deepEqual(
    {
      package: sources.workflows.rows[0].package,
      packageName: sources.workflows.rows[0]["package-name"],
      packageIcon: sources.workflows.rows[0]["package-icon"],
      packageMemberships: sources.workflows.rows[0]["package-memberships"],
      maxAiCredits: sources.workflows.rows[0]["max-ai-credits"],
      packageAllowance: sources.workflows.rows[0]["package-aic-allowance"],
      packageWorkerCount: sources.workflows.rows[0]["package-worker-count"],
      inventoryReady: sources.workflows.rows[0]["inventory-ready"],
      rolloutMode: sources.workflows.rows[0]["rollout-mode"],
      ghAwVersion: sources.workflows.rows[0]["gh-aw-version"],
      currentGhAwVersion: sources.workflows.rows[0]["gh-aw-current-version"],
      ghAwVersionLabel: sources.workflows.rows[0]["gh-aw-version-label"],
      updateState: sources.workflows.rows[0]["gh-aw-update-state"],
      metadata: sources.workflows.rows[0]["gh-aw-metadata"],
      manifest: sources.workflows.rows[0]["gh-aw-manifest"],
    },
    {
      package: "ambient-context",
      packageName: "Ambient Context",
      packageIcon: "workflow",
      packageMemberships: [
        { id: "ambient-context", name: "Ambient Context" },
      ],
      maxAiCredits: 500,
      packageAllowance: 500,
      packageWorkerCount: 0,
      inventoryReady: true,
      rolloutMode: "review",
      ghAwVersion: "v0.88.0",
      currentGhAwVersion: "v0.88.0",
      ghAwVersionLabel: "v0.88.0 (current)",
      updateState: "up-to-date",
      metadata: { compiler_version: "v0.88.0", strict: true },
      manifest: { version: 1, actions: [] },
    },
  );
  assert.equal(sources.outcomes.rows[0]["run-conclusion"], "failure");
});

test("dashboard source bridge maps a legacy manifest-derived package identity to the canonical inventory bundle id", () => {
  const orchestratorPath = ".github/workflows/uk-ai-advisory.lock.yml";
  const workerPath = ".github/workflows/uk-ai-advisory-operational-resilience.lock.yml";
  const standalonePath = ".github/workflows/uk-ai-advisory-package-maintainer.lock.yml";
  const sources = buildDashboardLanguageSources({
    deployed: {
      generatedAt: "2026-09-02T12:00:00Z",
      discovery: { complete: true },
      runHealth: { available: true, complete: true },
      bundles: [{
        repository: "githubnext/gh-aw-cao",
        path: "uk-ai-advisory/aw.yml",
        name: "UK AI Advisory",
        workflows: [
          { lockPath: orchestratorPath },
          { lockPath: workerPath },
          { lockPath: standalonePath },
        ],
      }],
      workflows: [
        { repository: "githubnext/gh-aw-cao", path: orchestratorPath, name: "UK AI Advisory", role: "orchestrator", state: "active" },
        { repository: "githubnext/gh-aw-cao", path: workerPath, name: "Operational Resilience", role: "worker", state: "active" },
        { repository: "githubnext/gh-aw-cao", path: standalonePath, name: "Package Maintainer", state: "active" },
      ],
    },
    usage: { available: true, complete: true, runs: [] },
    operationalValues: { records: [] },
    report: { generatedAt: "2026-09-02T12:00:00Z", records: [] },
    inventory: {
      workflows: [
        { sourcePath: ".github/workflows/uk-ai-advisory.md", lockPath: orchestratorPath, compiled: true },
        { sourcePath: ".github/workflows/uk-ai-advisory-operational-resilience.md", lockPath: workerPath, compiled: true },
      ],
      bundles: [{
        id: "uk-ai-advisory",
        name: "UK AI Advisory",
        workflow: ".github/workflows/uk-ai-advisory.md",
        controlPackage: "uk-ai-advisory",
        maxAiCredits: 250,
        compiled: true,
        missingWorkers: [],
        workers: [{
          id: "uk-ai-advisory-operational-resilience",
          sourcePath: ".github/workflows/uk-ai-advisory-operational-resilience.md",
          lockPath: workerPath,
          maxAiCredits: 600,
          compiled: true,
        }],
      }],
    },
    controlSettings: {
      packages: { "uk-ai-advisory": { mode: "review" } },
    },
  });

  const packagesById = new Map(sources.workflows.rows.map((row) => [row.workflow, row.package]));
  assert.equal(packagesById.get(".github/workflows/uk-ai-advisory.md"), "uk-ai-advisory");
  assert.equal(packagesById.get(".github/workflows/uk-ai-advisory-operational-resilience.md"), "uk-ai-advisory");
  assert.equal(packagesById.get(".github/workflows/uk-ai-advisory-package-maintainer.md"), "uk-ai-advisory");
  assert.deepEqual(
    new Set(sources.workflows.rows.map((row) => row.package)),
    new Set(["uk-ai-advisory"]),
  );
});

test("dashboard source bridge carries model and agent metadata into usage and report rows", () => {
  const sources = buildDashboardLanguageSources({
    deployed: {
      generatedAt: "2026-09-02T12:00:00Z",
      discovery: { complete: true },
      runHealth: { available: true, complete: true },
      bundles: [],
      workflows: [{
        repository: "githubnext/gh-aw-cao",
        path: ".github/workflows/model-audit.lock.yml",
        name: "Model Audit",
        state: "active",
        runHealth: {
          runRecords: [{
            runId: 42,
            status: "completed",
            conclusion: "success",
            displayTitle: "Model Audit · review",
            engine: "copilot",
            engineVersion: "0.87.9",
            requestedModel: "gpt-5.6-sol",
            resolvedModel: "gpt-5.6-sol",
          }],
        },
      }],
    },
    usage: {
      available: true,
      complete: true,
      runs: [{
        repository: "githubnext/gh-aw-cao",
        runId: 42,
        workflowPath: ".github/workflows/model-audit.lock.yml",
        engine: "copilot",
        engineVersion: "0.87.9",
        requestedModel: "gpt-5.6-sol",
        resolvedModel: "gpt-5.6-sol",
        aic: 12.5,
      }, {
        repository: "githubnext/gh-aw-cao",
        runId: 43,
        workflowPath: ".github/workflows/model-audit.lock.yml",
        engine: "copilot",
        requestedModel: "gpt-5.6-sol",
        resolvedModel: "gpt-5.6-sol",
        aic: null,
      }],
    },
    operationalValues: { records: [] },
    report: {
      generatedAt: "2026-09-02T12:00:00Z",
      records: [{
        id: "model-audit-output",
        repository: "githubnext/gh-aw-cao",
        runtimeRepository: "githubnext/gh-aw-cao",
        workflowPath: ".github/workflows/model-audit.lock.yml",
        runUrl: "https://github.com/githubnext/gh-aw-cao/actions/runs/42",
        engine: "copilot",
        engineVersion: "0.87.9",
        requestedModel: "gpt-5.6-sol",
        resolvedModel: "gpt-5.6-sol",
        mode: "review",
      }],
    },
  });

  assert.deepEqual(
    {
      runEngine: sources.runs.rows[0].engine,
      runVersion: sources.runs.rows[0]["engine-version"],
      usageEngine: sources.usage.rows[0].engine,
      usageVersion: sources.usage.rows[0]["engine-version"],
      usageModel: sources.usage.rows[0]["resolved-model"],
      estimatedUsd: sources.usage.rows[0]["estimated-usd"],
      missingEstimatedUsd: sources.usage.rows[1]["estimated-usd"],
      reportEngine: sources.outcomes.rows[0].engine,
      reportVersion: sources.outcomes.rows[0]["engine-version"],
      reportModel: sources.outcomes.rows[0]["resolved-model"],
    },
    {
      runEngine: "copilot",
      runVersion: "0.87.9",
      usageEngine: "copilot",
      usageVersion: "0.87.9",
      usageModel: "gpt-5.6-sol",
      estimatedUsd: 0.125,
      missingEstimatedUsd: null,
      reportEngine: "copilot",
      reportVersion: "0.87.9",
      reportModel: "gpt-5.6-sol",
    },
  );
});

test("dashboard source bridge carries usage agent metadata into assignments", () => {
  const sources = buildDashboardLanguageSources({
    deployed: {
      generatedAt: "2026-09-02T12:00:00Z",
      discovery: { complete: true },
      runHealth: { available: true, complete: true },
      bundles: [],
      workflows: [{
        repository: "githubnext/gh-aw-cao",
        path: ".github/workflows/model-audit.lock.yml",
        name: "Model Audit",
        state: "active",
        runHealth: {
          runRecords: [{
            runId: 42,
            status: "completed",
            conclusion: "success",
            startedAt: "2026-09-02T11:00:00Z",
          }],
        },
      }],
    },
    usage: {
      available: true,
      complete: true,
      runs: [{
        repository: "githubnext/gh-aw-cao",
        runId: 42,
        engine: "copilot",
        requestedModel: "gpt-5.6-sol",
      }],
    },
    operationalValues: { records: [] },
    report: { generatedAt: "2026-09-02T12:00:00Z", records: [] },
  });

  assert.deepEqual(
    sources["agent-assignments"].rows.map((row) => ({
      agent: row["agent-name"],
      workItem: row["work-item-id"],
      state: row["agent-state"],
    })),
    [{
      agent: "copilot · gpt-5.6-sol",
      workItem: "githubnext/gh-aw-cao:.github/workflows/model-audit.md",
      state: "completed",
    }],
  );
});

test("dashboard source bridge carries canonical coverage diagnostics", () => {
  const input = {
    deployed: {
      generatedAt: "2026-08-31T12:00:00Z",
      includePrivate: false,
      repositoryScope: "organization",
      repositoryCount: 3,
      organizationRepositories: { public: 2, private: 1, internal: 0, total: 3 },
      discovery: { complete: true },
      runHealth: { available: true, complete: true, windowHours: 24 },
      bundles: [],
      workflows: [
        { repository: "githubnext/public", visibility: "public", path: ".github/workflows/public.lock.yml" },
        { repository: "githubnext/unknown", visibility: "unknown", path: ".github/workflows/unknown.lock.yml" },
      ],
    },
    usage: { available: true, complete: false, windowHours: 24, runs: [] },
    operationalValues: { records: [] },
    report: { generatedAt: "2026-08-31T12:00:00Z", records: [] },
    controlSettings: {
      policy_resolution: {
        status: "unavailable",
        reason: "control-plane is required",
      },
    },
  };

  const sources = buildDashboardLanguageSources(input);
  assert.deepEqual(
    {
      runs: {
        start: sources.runs.metadata["coverage-start"],
        end: sources.runs.metadata["coverage-end"],
      },
      usage: {
        start: sources.usage.metadata["coverage-start"],
        end: sources.usage.metadata["coverage-end"],
      },
    },
    {
      runs: { start: "2026-08-30T12:00:00.000Z", end: "2026-08-31T12:00:00Z" },
      usage: { start: "2026-08-30T12:00:00.000Z", end: "2026-08-31T12:00:00Z" },
    },
  );
  assert.deepEqual(sources["coverage-diagnostics"].rows, [
    {
      title: "Control policy resolution unavailable",
      effect: "control-plane is required",
    },
    {
      title: "Private repository discovery is off",
      effect: "Private repositories are excluded from workflow inventory and run-health totals.",
    },
    {
      title: "AIC telemetry is partial",
      effect: "AI Credit totals exclude runs whose usage artifacts could not be collected.",
    },
  ]);
  assert.deepEqual(sources["repository-coverage"].rows, [
    { label: "Discovery scope", value: "Organization" },
    { label: "Repositories in scope", value: "3" },
    { label: "Discovered public", value: "1" },
    { label: "Discovered private", value: "0" },
    { label: "Discovered internal", value: "0" },
    { label: "Unknown visibility", value: "1" },
    { label: "Organization total", value: "3" },
    { label: "Organization public", value: "2" },
    { label: "Organization private", value: "1" },
    { label: "Organization internal", value: "0" },
  ]);
  assert.deepEqual(
    buildDashboardLanguageSources({
      ...input,
      deployed: { ...input.deployed, includePrivate: true },
      usage: { ...input.usage, complete: true },
      controlSettings: { policy_resolution: { status: "available", reason: "" } },
    })["coverage-diagnostics"].rows,
    [],
  );
});

test("dashboard source bridge exposes rate-limit details for retained records", () => {
  const sources = buildDashboardLanguageSources({
    deployed: {
      includePrivate: true,
      discovery: { complete: true },
      runHealth: { available: true, complete: true },
      workflows: [],
      bundles: [],
    },
    usage: { available: true, complete: true, runs: [] },
    operationalValues: { records: [] },
    inventory: {},
    controlSettings: {},
    report: {
      generatedAt: "2026-09-03T00:00:00Z",
      records: [{ repository: "githubnext/service", updatedAt: "2026-09-02T23:00:00Z" }],
      error: "GitHub API rate limit exceeded",
      errorStatus: 403,
      errorEndpoint: "/repos/githubnext/service/issues",
      rateLimitResetAt: "2026-09-03T01:00:00.000Z",
      snapshotGeneratedAt: "2026-09-02T23:00:00Z",
      snapshotAgeSeconds: 3600,
      stale: true,
    },
  });

  assert.deepEqual(sources["coverage-diagnostics"].rows, [
    {
      kind: "github-api-rate-limit-403",
      title: "Durable output collection unavailable",
      effect: "Durable output evidence is partial because GitHub rate-limited collection.",
      "technical-detail": "GitHub API rate limit exceeded",
      endpoint: "/repos/githubnext/service/issues",
      "rate-limit-reset": "2026-09-03T01:00:00.000Z",
      "snapshot-age-seconds": 3600,
    },
    {
      title: "Durable output snapshot is stale",
      effect: "Retained the last successful snapshot from 2026-09-02T23:00:00Z.",
      "snapshot-age-seconds": 3600,
    },
  ]);
  assert.equal(sources.outcomes.metadata.completeness, "partial");
  assert.equal(sources.outcomes.metadata.freshness, "stale");
});

test("dashboard source bridge derives admission gates from resolved control policy", () => {
  const sources = buildDashboardLanguageSources({
    deployed: {
      generatedAt: "2026-09-02T12:00:00Z",
      discovery: { complete: true },
      runHealth: { available: true, complete: true },
      bundles: [],
      workflows: [
        { repository: "acme/control", path: ".github/workflows/operations.lock.yml", name: "Operations", role: "orchestrator", state: "active", runHealth: { runRecords: [] } },
        { repository: "acme/control", path: ".github/workflows/enabled-worker.lock.yml", name: "Enabled worker", role: "worker", state: "active", runHealth: { runRecords: [] } },
        { repository: "acme/control", path: ".github/workflows/disabled-worker.lock.yml", name: "Disabled worker", role: "worker", state: "active", runHealth: { runRecords: [] } },
        { repository: "acme/control", path: ".github/workflows/undeclared-worker.lock.yml", name: "Undeclared worker", role: "worker", state: "active", runHealth: { runRecords: [] } },
        { repository: "acme/control", path: ".github/workflows/disabled-package.lock.yml", name: "Disabled package", role: "orchestrator", state: "active", runHealth: { runRecords: [] } },
        { repository: "acme/control", path: ".github/workflows/undeclared-package.lock.yml", name: "Undeclared package", role: "orchestrator", state: "active", runHealth: { runRecords: [] } },
      ],
    },
    usage: { available: true, complete: true, runs: [] },
    operationalValues: { records: [] },
    report: { generatedAt: "2026-09-02T12:00:00Z", records: [] },
    inventory: {
      workflows: [],
      bundles: [{
        id: "operations",
        name: "Operations",
        workflow: ".github/workflows/operations.md",
        controlPackage: "operations",
        compiled: true,
        missingWorkers: [],
        workers: [
          { id: "enabled-worker", sourcePath: ".github/workflows/enabled-worker.md", lockPath: ".github/workflows/enabled-worker.lock.yml", compiled: true },
          { id: "disabled-worker", sourcePath: ".github/workflows/disabled-worker.md", lockPath: ".github/workflows/disabled-worker.lock.yml", compiled: true },
          { id: "undeclared-worker", sourcePath: ".github/workflows/undeclared-worker.md", lockPath: ".github/workflows/undeclared-worker.lock.yml", compiled: true },
        ],
      }, {
        id: "disabled-package",
        name: "Disabled package",
        workflow: ".github/workflows/disabled-package.md",
        controlPackage: "disabled-package",
        compiled: true,
        missingWorkers: [],
        workers: [],
      }, {
        id: "undeclared-package",
        name: "Undeclared package",
        workflow: ".github/workflows/undeclared-package.md",
        controlPackage: "undeclared-package",
        compiled: true,
        missingWorkers: [],
        workers: [],
      }],
    },
    controlSettings: {
      packages: {
        operations: {
          enabled: true,
          worker_policies: {
            "enabled-worker": { worker: "enabled", enabled: true, max_mode: null },
            "disabled-worker": { worker: "disabled", enabled: false, max_mode: null },
          },
        },
        "disabled-package": {
          enabled: false,
          worker_policies: {},
        },
      },
    },
  });

  assert.deepEqual(sources.workflows.rows.map((row) => ({
    workflow: row.workflow,
    status: row["admission-status"],
    reason: row["admission-reason"],
  })), [
    { workflow: ".github/workflows/operations.md", status: "authorized", reason: "authorized" },
    { workflow: ".github/workflows/enabled-worker.md", status: "authorized", reason: "authorized" },
    { workflow: ".github/workflows/disabled-worker.md", status: "blocked", reason: "worker-disabled" },
    { workflow: ".github/workflows/undeclared-worker.md", status: "blocked", reason: "worker-undeclared" },
    { workflow: ".github/workflows/disabled-package.md", status: "blocked", reason: "package-disabled" },
    { workflow: ".github/workflows/undeclared-package.md", status: "blocked", reason: "package-undeclared" },
  ]);
});

test("dashboard source bridge retains unavailable grader records separately from value observations", () => {
  const sources = buildDashboardLanguageSources({
    deployed: {
      generatedAt: "2026-08-31T12:00:00Z",
      discovery: { complete: true },
      runHealth: { available: true, complete: true },
      bundles: [],
      workflows: [{
        repository: "githubnext/control-plane",
        path: ".github/workflows/daily.lock.yml",
        name: "Daily review",
        role: "worker",
        state: "active",
        runHealth: { runRecords: [] },
      }],
    },
    usage: { available: true, complete: true, runs: [] },
    operationalValues: {
      records: [
        {
          workflowId: "daily-value",
          workflowPath: ".github/workflows/daily-value.lock.yml",
          runId: 42,
          runUrl: "https://github.com/githubnext/gh-aw-cao/actions/runs/42",
          status: "pass",
          value: 0.8,
          baselineValue: 0.5,
          deltaFromBaseline: 0.3,
          evaluatorDigest: "1234567890abcdef",
          observation: {
            evidenceAt: "2026-08-31T10:00:00Z",
            opportunityKey: "githubnext/gh-aw-cao#42",
            mature: false,
            case: { targetRepo: "githubnext/gh-aw-cao" },
          },
        },
        {
          workflowId: "missing-value",
          workflowPath: ".github/workflows/missing-value.lock.yml",
          repository: "githubnext/gh-aw-cao",
          runId: 43,
          status: "unavailable",
        },
      ],
    },
    report: { generatedAt: "2026-08-31T12:00:00Z", records: [] },
  });

  assert.equal(sources["operational-values"].rows.length, 1);
  assert.equal(sources["grader-observations"].rows.length, 2);
  assert.deepEqual(
    sources["grader-observations"].rows.map((row) => ({
      grader: row.grader,
      status: row.status,
      maturity: row["maturity-status"],
      baseline: row["baseline-value"],
      run: row.run,
      runHref: row["run-link"]?.href,
    })),
    [
      {
        grader: "daily-value",
        status: "pass",
        maturity: "interim",
        baseline: 0.5,
        run: "42",
        runHref: "https://github.com/githubnext/gh-aw-cao/actions/runs/42",
      },
      {
        grader: "missing-value",
        status: "unavailable",
        maturity: "unavailable",
        baseline: undefined,
        run: "43",
        runHref: "https://github.com/githubnext/gh-aw-cao/actions/runs/43",
      },
    ],
  );
});

test("dashboard source bridge preserves report observation identity, diagnostics, and historical coverage", () => {
  const sources = buildDashboardLanguageSources({
    deployed: {
      generatedAt: "2026-09-01T12:00:00Z",
      discovery: { complete: true },
      runHealth: { available: true, complete: true },
      bundles: [],
      workflows: [],
    },
    usage: { available: true, complete: true, runs: [] },
    operationalValues: {
      schemaVersion: 1,
      generatedAt: "2026-09-01T11:30:00Z",
      window: {
        startAt: "2026-01-01T00:00:00Z",
        endAt: "2026-09-01T11:00:00Z",
      },
      complete: true,
      definitions: [{
        repository: "github/gh-aw",
        workflowId: "daily-file-diet",
        evaluatorDigest: "1234567890abcdef",
        diagnosticMetrics: [{ id: "repository-health", name: "Repository health", direction: "higher_is_better" }],
      }],
      records: [{
        repository: "github/gh-aw",
        workflowId: "daily-file-diet",
        workflowPath: ".github/workflows/daily-file-diet.lock.yml",
        runId: 42,
        runAttempt: 2,
        runUrl: "https://github.com/github/gh-aw/actions/runs/42",
        status: "pass",
        value: 0.8,
        evaluatorDigest: "1234567890abcdef",
        diagnostics: { "repository-health": 0.65 },
        observation: {
          evidenceAt: "2026-08-31T10:00:00Z",
          evidenceCutoff: "2026-08-31T09:00:00Z",
          opportunityKey: "github/gh-aw#42",
          mature: true,
          case: { targetRepo: "github/gh-aw" },
          provenance: [{ repository: "github/gh-aw", sha: "abc123", path: "pkg/cli" }],
        },
      }],
    },
    report: { generatedAt: "2026-09-01T12:00:00Z", records: [] },
  });

  assert.deepEqual(
    sources["operational-values"].rows[0],
    {
      organization: "github",
      repository: "gh-aw",
      "repository-name": "gh-aw",
      workflow: ".github/workflows/daily-file-diet.md",
      run: "42",
      "run-attempt": 2,
      "observation-id": "github/gh-aw:daily-file-diet:42:2:1234567890abcdef",
      experiment: "",
      "operational-case": "github/gh-aw#42",
      "evaluator-digest": "1234567890abcdef",
      "rollout-mode": "unknown",
      "operational-value": 0.8,
      "operational-value-definition": "daily-file-diet",
      "requested-evidence-at": "2026-08-31T10:00:00Z",
      "evidence-cutoff": "2026-08-31T09:00:00Z",
      "maturity-at": "2026-08-31T10:00:00Z",
      "maturity-status": "matured",
      "baseline-value": undefined,
      "delta-from-baseline": undefined,
      "observed-at": "2026-08-31T10:00:00Z",
      "accepted-evidence-provenance": [{ repository: "github/gh-aw", sha: "abc123", path: "pkg/cli" }],
      diagnostics: { "repository-health": 0.65 },
      "diagnostic-definitions": [{ id: "repository-health", name: "Repository health", direction: "higher_is_better" }],
      "evidence-link": {
        relation: "evidence",
        href: "https://github.com/github/gh-aw/actions/runs/42",
        label: "View run 42",
      },
      "run-link": {
        relation: "run",
        href: "https://github.com/github/gh-aw/actions/runs/42",
        label: "Run 42",
      },
    },
  );
  assert.deepEqual(
    {
      asOf: sources["operational-values"].metadata["as-of"],
      retrievedAt: sources["operational-values"].metadata["retrieved-at"],
      coverageStart: sources["operational-values"].metadata["coverage-start"],
      coverageEnd: sources["operational-values"].metadata["coverage-end"],
      completeness: sources["operational-values"].metadata.completeness,
    },
    {
      asOf: "2026-09-01T11:00:00Z",
      retrievedAt: "2026-09-01T11:30:00Z",
      coverageStart: "2026-01-01T00:00:00Z",
      coverageEnd: "2026-09-01T11:00:00Z",
      completeness: "complete",
    },
  );
});

test("dashboard source bridge carries outcome detail content and presentation metadata", () => {
  const sources = buildDashboardLanguageSources({
    deployed: {
      generatedAt: "2026-08-31T12:00:00Z",
      discovery: { complete: true },
      runHealth: { available: true, complete: true },
      bundles: [],
      workflows: [{
        repository: "githubnext/control-plane",
        path: ".github/workflows/daily.lock.yml",
        name: "Daily review",
        role: "worker",
        state: "active",
      }, {
        repository: "githubnext/gh-aw-cao",
        path: ".github/workflows/daily.lock.yml",
        name: "Standalone daily review",
        role: "standalone",
        state: "active",
      }],
    },
    usage: { available: true, complete: true, runs: [] },
    operationalValues: { records: [] },
    report: {
      generatedAt: "2026-08-31T12:00:00Z",
      records: [{
        id: "outcome-1",
        number: 1,
        bundle: "daily",
        repository: "githubnext/gh-aw-cao",
        runtimeRepository: "githubnext/control-plane",
        workflowPath: ".github/workflows/daily.lock.yml",
        workflow: "Daily review",
        mode: "live",
        warning: true,
        kind: "pull-request",
        state: "closed",
        title: "Parity verification sweep",
        summary: "All checks passed.",
        bodyHtml: "<h2>Summary</h2><p>All checks passed.</p>",
        createdAt: "2026-08-31T10:00:00Z",
        updatedAt: "2026-08-31T11:00:00Z",
        url: "https://github.com/githubnext/gh-aw-cao/pull/1",
        runUrl: "https://github.com/githubnext/gh-aw-cao/actions/runs/1",
      }, {
        id: "noop-1",
        bundle: "daily",
        repository: "githubnext/gh-aw-cao",
        runtimeRepository: "githubnext/control-plane",
        workflowPath: ".github/workflows/daily.lock.yml",
        workflow: "Daily review",
        mode: "live",
        warning: false,
        kind: "noop",
        state: "complete",
        title: "Daily review completed with no action",
        createdAt: "2026-08-31T11:30:00Z",
        updatedAt: "2026-08-31T11:30:00Z",
        url: "https://github.com/githubnext/gh-aw-cao/issues/2#issuecomment-1",
        runUrl: "https://github.com/githubnext/control-plane/actions/runs/2",
      }],
    },
  });

  assert.deepEqual(
    {
      workflow: sources.outcomes.rows[0].workflow,
      workflowRole: sources.outcomes.rows[0]["workflow-role"],
      runtimeRepository: sources.outcomes.rows[0]["runtime-repository"],
      package: sources.outcomes.rows[0].package,
      workflowName: sources.outcomes.rows[0]["workflow-name"],
      title: sources.outcomes.rows[0]["outcome-title"],
      number: sources.outcomes.rows[0]["outcome-number"],
      summary: sources.outcomes.rows[0]["outcome-summary"],
      bodyHtml: sources.outcomes.rows[0]["outcome-body-html"],
      category: sources.outcomes.rows[0]["outcome-category"],
      status: sources.outcomes.rows[0]["outcome-status"],
      mode: sources.outcomes.rows[0]["rollout-mode"],
      warning: sources.outcomes.rows[0]["outcome-warning"],
      publishedAt: sources.outcomes.rows[0]["published-at"],
    },
    {
      workflow: ".github/workflows/daily.md",
      workflowRole: "worker",
      runtimeRepository: "githubnext/control-plane",
      package: "daily",
      workflowName: "Daily review",
      title: "Parity verification sweep",
      number: 1,
      summary: "All checks passed.",
      bodyHtml: "<h2>Summary</h2><p>All checks passed.</p>",
      category: "pull-request",
      status: "closed",
      mode: "live",
      warning: "Warning",
      publishedAt: "2026-08-31T10:00:00Z",
    },
  );
  assert.equal(sources.findings.rows[0]["workflow-role"], "worker");
  assert.deepEqual(
    {
      category: sources.outcomes.rows[1]["outcome-category"],
      role: sources.outcomes.rows[1]["workflow-role"],
      state: sources.outcomes.rows[1]["outcome-state"],
    },
    { category: "noop", role: "worker", state: "ignored" },
  );
});

test("dashboard source bridge preserves firewall evidence states, policy attribution, and workflow-scoped drift", () => {
    const firewall = (overrides = {}) => ({
      available: true,
      analysis: null,
      observations: [],
      policyManifest: null,
      firewallExpected: true,
      firewallEnabled: true,
      firewallEvidenceAvailable: true,
      firewallEvidenceState: "available",
      firewallEvidenceCompleteness: "complete",
      firewallEvidenceFreshness: "fresh",
      firewallEvidenceError: "",
      firewallEvidenceSource: "firewall-audit",
      firewallEvidenceReference: "sandbox/firewall/audit/audit.jsonl",
      firewallEvidenceHorizonStart: "2026-08-10T00:00:00Z",
      firewallEvidenceHorizonEnd: "2026-09-03T05:00:00Z",
      awfVersion: "0.28.12",
      ...overrides,
    });
    const security = (firewallTelemetry) => ({
      firewall: firewallTelemetry,
      accessControl: { available: false },
      integrity: { available: false },
      mcp: { available: false, servers: [], calls: [], failures: [] },
      threatDetection: { available: false },
    });
    const common = {
      repository: "githubnext/gh-aw-cao",
      workflowPath: ".github/workflows/security.lock.yml",
      conclusion: "success",
      mode: "review",
    };
    const sources = buildDashboardLanguageSources({
      deployed: {
        generatedAt: "2026-09-03T06:00:00Z",
        discovery: { complete: true },
        runHealth: { available: true, complete: true },
        bundles: [],
        workflows: [],
      },
      usage: {
        available: true,
        complete: true,
        securityAvailable: true,
        securityComplete: false,
        firewallRequestedHorizonStart: "2026-08-04T06:00:00Z",
        firewallRequestedHorizonEnd: "2026-09-03T06:00:00Z",
        firewallEvidenceHorizonStart: "2026-08-10T00:00:00Z",
        firewallEvidenceHorizonEnd: "2026-09-03T05:00:00Z",
        firewallLastSuccessfulCollectionAt: "2026-09-03T06:00:00Z",
        runs: [],
        securityRuns: [
          {
            ...common,
            runId: 40,
            createdAt: "2026-09-01T05:00:00Z",
            security: security(firewall({
              observations: [
                { observedAt: "2026-09-01T05:01:00Z", domain: "api.github.com", host: "api.github.com", port: 443, protocol: "https", decision: "allowed" },
                { observedAt: "2026-09-01T05:02:00Z", domain: "old.example", host: "old.example", port: 443, protocol: "https", decision: "allowed" },
              ],
            })),
          },
          {
            ...common,
            runId: 41,
            createdAt: "2026-09-02T05:00:00Z",
            security: security(firewall({
              observations: [
                { observedAt: "2026-09-02T05:01:00Z", domain: "api.github.com", host: "api.github.com", port: 443, protocol: "https", decision: "denied" },
                { observedAt: "2026-09-02T05:02:00Z", domain: "new.example", host: "new.example", port: 443, protocol: "https", decision: "allowed" },
              ],
              policyManifest: {
                version: 1,
                generatedAt: "2026-09-02T04:00:00Z",
                rules: [{
                  id: "new-domain",
                  order: 1,
                  action: "allow",
                  aclName: "new_domain",
                  protocol: "https",
                  domains: ["new.example"],
                  description: "Approved destination",
                }],
              },
            })),
          },
          {
            ...common,
            workflowPath: ".github/workflows/other.lock.yml",
            runId: 42,
            createdAt: "2026-09-02T06:00:00Z",
            security: security(firewall({
              observations: [
                { observedAt: "2026-09-02T06:01:00Z", domain: "new.example", host: "new.example", port: 443, protocol: "https", decision: "allowed" },
              ],
            })),
          },
          {
            ...common,
            runId: 43,
            createdAt: "2026-09-03T05:00:00Z",
            security: security(firewall({
              available: false,
              observations: [],
              firewallEvidenceAvailable: false,
              firewallEvidenceState: "unavailable",
              firewallEvidenceCompleteness: "unknown",
              firewallEvidenceFreshness: "unknown",
              firewallEvidenceError: "Artifact download failed.",
            })),
          },
        ],
      },
      operationalValues: { records: [] },
      report: { generatedAt: "2026-09-03T06:00:00Z", records: [] },
    });

    const observations = sources["firewall-observations"];
    assert.equal(observations.metadata.completeness, "partial");
    assert.equal(observations.metadata["coverage-start"], "2026-08-10T00:00:00Z");
    assert.ok(observations.rows.some((row) => row.run === "41"
      && row.domain === "api.github.com"
      && row["drift-state"] === "decision-changed"
      && row["previous-decision"] === "allowed"
      && row["current-decision"] === "denied"));
    assert.ok(observations.rows.some((row) => row.run === "41"
      && row.domain === "new.example"
      && row["drift-state"] === "newly-allowed"
      && row["policy-rule-id"] === "new-domain"));
    assert.ok(observations.rows.some((row) => row.run === "41"
      && row.domain === "old.example"
      && row["drift-state"] === "removed"));
    assert.ok(observations.rows.some((row) => row.run === "42"
      && row.domain === "new.example"
      && row["drift-state"] === "unknown"));
    assert.ok(observations.rows.some((row) => row.run === "43"
      && row["review-state"] === "evidence-missing"
      && row["request-count"] === null));
    assert.ok(sources["firewall-policy-rules"].rows.some((row) => row["rule-id"] === "new-domain"
      && row["domain-pattern"] === "new.example"
      && row["hit-count"] === 1));
});
