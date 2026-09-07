import assert from "node:assert/strict";
import test from "node:test";
import { collectDashboardRecords } from "../../dashboard/report/records.mjs";

const inventory = {
  schemaVersion: 1,
  workflows: [],
  bundles: [{
    id: "maintenance",
    name: "Maintenance",
    controlPackage: "maintenance",
    workers: [{ id: "maintenance-worker", name: "Worker" }],
  }],
  standalone: [],
};

test("dashboard records retain durable-output target and run attribution", async () => {
  const issue = {
    number: 7,
    title: "[Maintenance] Update available",
    body: "### Worker\n\ntarget repository: `acme/service`\n\nGenerated from [Worker](https://github.com/acme/control/actions/runs/42)",
    body_html: "<p>Update available</p>",
    state: "open",
    html_url: "https://github.com/acme/service/issues/7",
    url: "https://api.github.com/repos/acme/service/issues/7",
    created_at: "2026-09-01T10:00:00Z",
    updated_at: "2026-09-01T11:00:00Z",
  };
  const fetchImpl = async (input) => {
    const url = new URL(input);
    let value;
    if (url.pathname === "/repos/acme/control/issues") value = [issue];
    else if (url.pathname.endsWith("/issues")) value = [];
    else if (url.pathname.endsWith("/issues/comments")) value = [];
    else if (url.pathname.endsWith("/actions/artifacts")) value = { artifacts: [] };
    else if (url.pathname.endsWith("/actions/workflows")) value = { workflows: [] };
    else if (url.pathname.endsWith("/actions/runs/42")) value = {
      name: "Maintenance / Worker",
      path: ".github/workflows/maintenance-worker.lock.yml",
      display_title: "Maintenance / Worker · live",
      conclusion: "success",
    };
    else throw new Error(`Unexpected request: ${url}`);
    return new Response(JSON.stringify(value), { status: 200 });
  };

  const output = await collectDashboardRecords({
    repository: "acme/control",
    token: "test-token",
    controlSettings: {
      allowed_repositories: ["acme/service"],
      packages: { maintenance: { mode: "review" } },
    },
    inventory,
    deployedInventory: {
      workflows: [{ repository: "acme/control" }],
      allowedRepositories: ["acme/service"],
    },
    fetchImpl,
    generatedAt: "2026-09-01T12:00:00Z",
  });

  assert.equal(output.generatedAt, "2026-09-01T12:00:00Z");
  assert.deepEqual(output.records.map((record) => ({
    id: record.id,
    repository: record.repository,
    runtimeRepository: record.runtimeRepository,
    workflowPath: record.workflowPath,
    workflow: record.workflow,
    mode: record.mode,
    conclusion: record.conclusion,
  })), [{
    id: "acme/control-issue-7",
    repository: "acme/service",
    runtimeRepository: "acme/control",
    workflowPath: ".github/workflows/maintenance-worker.lock.yml",
    workflow: "Maintenance / Worker",
    mode: "live",
    conclusion: "success",
  }]);
});

test("dashboard records attribute issues from the gh-aw workflow XML marker", async () => {
  const issue = {
    number: 9,
    title: "[Maintenance] Preview finding",
    body: [
      "A current report issue.",
      "",
      "<!-- gh-aw-workflow-id: maintenance-worker -->",
    ].join("\n"),
    body_html: "<p>A current report issue.</p>",
    state: "open",
    html_url: "https://github.com/acme/control/issues/9",
    url: "https://api.github.com/repos/acme/control/issues/9",
    created_at: "2026-09-03T10:00:00Z",
    updated_at: "2026-09-03T11:00:00Z",
  };
  const fetchImpl = async (input) => {
    const url = new URL(input);
    let value;
    if (url.pathname === "/repos/acme/control/issues") value = [issue];
    else if (url.pathname.endsWith("/issues")) value = [];
    else if (url.pathname.endsWith("/issues/comments")) value = [];
    else if (url.pathname.endsWith("/actions/artifacts")) value = { artifacts: [] };
    else throw new Error(`Unexpected request: ${url}`);
    return new Response(JSON.stringify(value), { status: 200 });
  };

  const output = await collectDashboardRecords({
    repository: "acme/control",
    token: "test-token",
    controlSettings: {
      allowed_repositories: ["acme/control"],
      packages: { maintenance: { mode: "review" } },
    },
    inventory: {
      ...inventory,
      workflows: [{
        id: "maintenance-worker",
        name: "Maintenance worker",
        sourcePath: ".github/workflows/maintenance-worker.md",
      }],
    },
    deployedInventory: {
      workflows: [{ repository: "acme/control" }],
      allowedRepositories: ["acme/control"],
    },
    fetchImpl,
    generatedAt: "2026-09-03T12:00:00Z",
  });

  assert.deepEqual(output.records.map((record) => ({
    bundle: record.bundle,
    workflowId: record.workflowId,
    workflowPath: record.workflowPath,
    workflow: record.workflow,
  })), [{
    bundle: "maintenance",
    workflowId: "maintenance-worker",
    workflowPath: ".github/workflows/maintenance-worker.md",
    workflow: "Maintenance worker",
  }]);
});

test("dashboard records retain report model and agent metadata when available", async () => {
  const issue = {
    number: 8,
    title: "[Maintenance] Model metadata",
    body: [
      "### Worker",
      "",
      "target repository: `acme/service`",
      "<!-- aw:engine=copilot -->",
      "<!-- aw:engine-version=0.87.9 -->",
      "<!-- aw:requested-model=gpt-5.6-sol -->",
      "<!-- aw:resolved-model=gpt-5.6-sol-fast -->",
      "",
      "Generated from [Worker](https://github.com/acme/control/actions/runs/43)",
    ].join("\n"),
    body_html: "<p>Model metadata</p>",
    state: "open",
    html_url: "https://github.com/acme/service/issues/8",
    url: "https://api.github.com/repos/acme/service/issues/8",
    created_at: "2026-09-02T10:00:00Z",
    updated_at: "2026-09-02T11:00:00Z",
  };
  const fetchImpl = async (input) => {
    const url = new URL(input);
    let value;
    if (url.pathname === "/repos/acme/control/issues") value = [issue];
    else if (url.pathname.endsWith("/issues")) value = [];
    else if (url.pathname.endsWith("/issues/comments")) value = [];
    else if (url.pathname.endsWith("/actions/artifacts")) value = { artifacts: [] };
    else if (url.pathname.endsWith("/actions/workflows")) value = { workflows: [] };
    else if (url.pathname.endsWith("/actions/runs/43")) value = {
      name: "Maintenance / Worker",
      path: ".github/workflows/maintenance-worker.lock.yml",
      display_title: "Maintenance / Worker · review",
      conclusion: "success",
    };
    else throw new Error(`Unexpected request: ${url}`);
    return new Response(JSON.stringify(value), { status: 200 });
  };

  const output = await collectDashboardRecords({
    repository: "acme/control",
    token: "test-token",
    controlSettings: {
      allowed_repositories: ["acme/service"],
      packages: { maintenance: { mode: "review" } },
    },
    inventory,
    deployedInventory: {
      workflows: [{ repository: "acme/control" }],
      allowedRepositories: ["acme/service"],
    },
    fetchImpl,
    generatedAt: "2026-09-02T12:00:00Z",
  });

  assert.deepEqual(
    {
      engine: output.records[0].engine,
      engineVersion: output.records[0].engineVersion,
      requestedModel: output.records[0].requestedModel,
      resolvedModel: output.records[0].resolvedModel,
    },
    {
      engine: "copilot",
      engineVersion: "0.87.9",
      requestedModel: "gpt-5.6-sol",
      resolvedModel: "gpt-5.6-sol-fast",
    },
  );
});

test("dashboard records cannot widen checked-in repository policy", async () => {
  await assert.rejects(() => collectDashboardRecords({
    repository: "acme/control",
    token: "test-token",
    controlSettings: { allowed_repositories: ["acme/service"] },
    inventory,
    deployedInventory: { workflows: [] },
    requestedRepositories: ["acme/other"],
  }), /cannot widen checked-in control policy/);
});

test("dashboard records discover gh-aw workflows in allowed repositories", async () => {
  const fetchImpl = async (input) => {
    const url = new URL(input);
    if (url.pathname === "/repos/acme/service/actions/workflows") {
      return new Response(JSON.stringify({
        workflows: [
          { name: "Remote agent", path: ".github/workflows/remote-agent.lock.yml", state: "active", html_url: "https://github.com/acme/service/actions/workflows/remote-agent.lock.yml" },
          { name: "CI", path: ".github/workflows/ci.yml", state: "active", html_url: "https://github.com/acme/service/actions/workflows/ci.yml" },
        ],
      }), { status: 200 });
    }
    if (url.pathname.endsWith("/issues") || url.pathname.endsWith("/issues/comments")) {
      return new Response("[]", { status: 200 });
    }
    if (url.pathname.endsWith("/actions/artifacts")) {
      return new Response(JSON.stringify({ artifacts: [] }), { status: 200 });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  const output = await collectDashboardRecords({
    repository: "acme/control",
    token: "test-token",
    controlSettings: { allowed_repositories: ["acme/service"] },
    inventory,
    deployedInventory: { workflows: [{ repository: "acme/control" }] },
    fetchImpl,
    generatedAt: "2026-09-07T12:00:00Z",
  });

  assert.deepEqual(output.remoteWorkflows.map((workflow) => ({
    repository: workflow.repository,
    path: workflow.path,
    name: workflow.name,
    role: workflow.role,
  })), [{
    repository: "acme/service",
    path: ".github/workflows/remote-agent.lock.yml",
    name: "Remote agent",
    role: "standalone",
  }]);
  assert.deepEqual(output.workflowDiscovery, {
    complete: true,
    repositoriesExpected: 1,
    repositoriesObserved: 1,
    workflowsObserved: 1,
    failures: [],
  });
});

test("dashboard records stop on a GitHub rate limit and return a renderable error", async () => {
  const requests = [];
  const logs = [];
  const originalLog = console.log;
  console.log = (line) => logs.push(line);
  try {
    const output = await collectDashboardRecords({
      repository: "acme/control",
      token: "test-token",
      controlSettings: { allowed_repositories: ["acme/service"] },
      inventory,
      deployedInventory: {
        workflows: [{ repository: "acme/service" }],
        allowedRepositories: ["acme/service"],
      },
      fetchImpl: async (input) => {
        requests.push(input);
        return new Response(JSON.stringify({ message: "API rate limit exceeded" }), {
          status: 403,
          headers: {
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": "1788393600",
          },
        });

        test("dashboard records retain the prior snapshot when a refresh is rate limited", async () => {
          const previousSnapshot = {
            generatedAt: "2026-09-02T23:00:00Z",
            records: [{ id: "retained-record" }],
          };
          const output = await collectDashboardRecords({
            repository: "acme/control",
            token: "test-token",
            controlSettings: { allowed_repositories: ["acme/service"] },
            inventory,
            deployedInventory: { workflows: [{ repository: "acme/service" }] },
            previousSnapshot,
            generatedAt: "2026-09-03T00:00:00Z",
            fetchImpl: async () => new Response(JSON.stringify({ message: "API rate limit exceeded" }), {
              status: 403,
              headers: {
                "x-ratelimit-remaining": "0",
                "x-ratelimit-reset": "1788397200",
              },
            }),
          });

          assert.deepEqual(output.records, previousSnapshot.records);
          assert.equal(output.stale, true);
          assert.equal(output.partial, true);
          assert.equal(output.errorEndpoint, "/repos/acme/control/issues?state=all&sort=updated&direction=desc&per_page=100&page=1");
          assert.equal(output.rateLimitResetAt, "2026-09-03T01:00:00.000Z");
          assert.equal(output.snapshotAgeSeconds, 3600);
        });
      },
      generatedAt: "2026-09-02T23:00:00Z",
    });

    assert.equal(output.generatedAt, "2026-09-02T23:00:00Z");
    assert.deepEqual(output.records, []);
    assert.equal(output.errorStatus, 403);
    assert.match(output.error, /GitHub API rate limit exceeded/);
    assert.match(output.error, /Retry after 2026-09-03T00:00:00.000Z/);
    assert.match(output.error, /rate-limits-for-the-rest-api/);
    assert.ok(logs.some((line) => line.startsWith("::warning::GitHub API rate limit exceeded")));
    assert.ok(requests.every((request) => !request.includes("page=2")));
  } finally {
    console.log = originalLog;
  }
});
