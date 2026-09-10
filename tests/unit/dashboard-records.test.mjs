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
const publicRepositoryMetadata = {
  private: false,
  visibility: "public",
  default_branch: "main",
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
    if (url.pathname === "/repos/acme/control" || url.pathname === "/repos/acme/service") value = publicRepositoryMetadata;
    else if (url.pathname === "/repos/github/gh-aw/releases/latest") value = { tag_name: "v0.89.0" };
    else if (url.pathname === "/repos/acme/control/issues") value = [issue];
    else if (url.pathname.endsWith("/issues")) value = [];
    else if (url.pathname.endsWith("/issues/comments")) value = [];
    else if (url.pathname.endsWith("/actions/artifacts")) value = { artifacts: [] };
    else if (url.pathname.endsWith("/actions/workflows")) value = { workflows: [] };
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
      workflows: [{
        repository: "acme/control",
        path: ".github/workflows/maintenance-worker.lock.yml",
        name: "Maintenance / Worker",
        runHealth: { runRecords: [{
          repository: "acme/control",
          runId: 42,
          displayTitle: "Maintenance / Worker · live",
          conclusion: "success",
        }] },
      }],
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
    if (url.pathname === "/repos/acme/control") value = publicRepositoryMetadata;
    else if (url.pathname === "/repos/github/gh-aw/releases/latest") value = { tag_name: "v0.89.0" };
    else if (url.pathname === "/repos/acme/control/issues") value = [issue];
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
    if (url.pathname === "/repos/acme/control" || url.pathname === "/repos/acme/service") value = publicRepositoryMetadata;
    else if (url.pathname === "/repos/github/gh-aw/releases/latest") value = { tag_name: "v0.89.0" };
    else if (url.pathname === "/repos/acme/control/issues") value = [issue];
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

test("dashboard records refuse private inventory data on public Pages", async () => {
  const collectForVisibility = (visibility) => collectDashboardRecords({
    repository: "acme/control",
    token: "test-token",
    controlSettings: { allowed_repositories: [`acme/${visibility}`] },
    inventory,
    deployedInventory: { includePrivate: true, workflows: [{ repository: "acme/control" }] },
    fetchImpl: async (input) => {
      const url = new URL(input);
      if (url.pathname === "/repos/acme/control") {
        return new Response(JSON.stringify(publicRepositoryMetadata), { status: 200 });
      }
      if (url.pathname === `/repos/acme/${visibility}`) {
        return new Response(JSON.stringify({
          private: visibility === "private",
          visibility,
          default_branch: "main",
        }), { status: 200 });
      }
      if (url.pathname === "/repos/acme/control/pages") {
        return new Response(JSON.stringify({ public: true }), { status: 200 });
      }
      throw new Error(`Unexpected request: ${url}`);
    },
  });
  await assert.rejects(() => collectForVisibility("private"), /Refusing to publish non-public repository data/);
  await assert.rejects(() => collectForVisibility("internal"), /Refusing to publish non-public repository data/);
});

test("dashboard records do not request repository visibility before durable outputs", async () => {
  let privateDataRequested = false;
  const hiddenIssue = {
    number: 10,
    title: "[Maintenance] Hidden target",
    body: "target repository: `acme/private`",
    body_html: "<p>Hidden target</p>",
    state: "open",
    html_url: "https://github.com/acme/control/issues/10",
    url: "https://api.github.com/repos/acme/control/issues/10",
    created_at: "2026-09-07T10:00:00Z",
    updated_at: "2026-09-07T11:00:00Z",
  };
  const output = await collectDashboardRecords({
    repository: "acme/control",
    token: "test-token",
    controlSettings: { allowed_repositories: ["acme/private"] },
    inventory,
    deployedInventory: { workflows: [{ repository: "acme/control" }] },
    fetchImpl: async (input) => {
      const url = new URL(input);
      if (url.pathname === "/repos/acme/control") {
        return new Response(JSON.stringify(publicRepositoryMetadata), { status: 200 });
      }
      if (url.pathname === "/repos/acme/private") {
        return new Response(JSON.stringify({ message: "Unavailable" }), { status: 503 });
      }
      if (url.pathname === "/repos/github/gh-aw/releases/latest") {
        return new Response(JSON.stringify({ tag_name: "v0.89.0" }), { status: 200 });
      }
      if (url.pathname.startsWith("/repos/acme/private/")) privateDataRequested = true;
      if (url.pathname.startsWith("/repos/acme/control/")) {
        if (url.pathname.endsWith("/issues")) {
          return new Response(JSON.stringify([hiddenIssue]), { status: 200 });
        }
        return url.pathname.endsWith("/actions/artifacts")
          ? new Response(JSON.stringify({ artifacts: [] }), { status: 200 })
          : new Response("[]", { status: 200 });
      }
      throw new Error(`Unexpected request: ${url}`);
    },
  });
  assert.equal(privateDataRequested, true);
  assert.deepEqual(output.records.map((record) => record.id), ["acme/control-issue-10"]);
  assert.equal(Object.hasOwn(output, "workflowDiscovery"), false);
});

test("dashboard records avoid repository and workflow enrichment APIs", async () => {
  const requests = [];
  const output = await collectDashboardRecords({
    repository: "acme/control",
    token: "test-token",
    controlSettings: { allowed_repositories: ["acme/service"] },
    inventory,
    deployedInventory: {
      workflows: [{ repository: "acme/control", runHealth: { runRecords: [] } }],
      allowedRepositories: ["acme/service"],
    },
    fetchImpl: async (input) => {
      const url = new URL(input);
      requests.push(url.pathname);
      const value = url.pathname.endsWith("/actions/artifacts") ? { artifacts: [] } : [];
      return new Response(JSON.stringify(value), { status: 200 });
    },
  });

  assert.deepEqual(output.records, []);
  assert.equal(Object.hasOwn(output, "remoteWorkflows"), false);
  assert.equal(Object.hasOwn(output, "workflowDiscovery"), false);
  assert.ok(requests.every((pathname) => (
    pathname.endsWith("/issues")
    || pathname.endsWith("/issues/comments")
    || pathname.endsWith("/actions/artifacts")
  )));
});

test("dashboard records ignore indexer repository details when choosing report repositories", async () => {
  const requests = [];
  await collectDashboardRecords({
    repository: "acme/control",
    token: "test-token",
    controlSettings: { allowed_repositories: ["acme/service"] },
    inventory,
    deployedInventory: {
      workflows: [{ repository: "acme/control", runHealth: { runRecords: [] } }],
      allowedRepositories: ["acme/legacy"],
    },
    fetchImpl: async (input) => {
      const url = new URL(input);
      requests.push(url.pathname);
      const value = url.pathname.endsWith("/actions/artifacts") ? { artifacts: [] } : [];
      return new Response(JSON.stringify(value), { status: 200 });
    },
  });

  assert.ok(requests.some((pathname) => pathname.startsWith("/repos/acme/service/")));
  assert.equal(requests.some((pathname) => pathname.startsWith("/repos/acme/legacy/")), false);
  assert.equal(requests.includes("/repos/acme/control"), false);
  assert.equal(requests.includes("/repos/acme/service"), false);
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

test("dashboard records retain only confirmed-public snapshots when a refresh is rate limited", async () => {
  const refresh = (previousSnapshot) => collectDashboardRecords({
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
  const publicSnapshot = {
    generatedAt: "2026-09-02T23:00:00Z",
    records: [{ id: "retained-record" }],
    workflowDiscovery: {
      complete: true,
      repositoriesExpected: 1,
      repositoriesObserved: 1,
      workflowsObserved: 1,
      failures: [],
    },
    containsPrivateData: false,
  };
  const retained = await refresh(publicSnapshot);
  assert.deepEqual(retained.records, publicSnapshot.records);
  assert.equal(retained.stale, true);
  assert.equal(retained.snapshotAgeSeconds, 3600);
  assert.equal(Object.hasOwn(retained, "workflowDiscovery"), false);

  const privateSnapshot = {
    ...publicSnapshot,
    containsPrivateData: true,
  };
  const rejected = await refresh(privateSnapshot);
  assert.deepEqual(rejected.records, []);
  assert.equal(rejected.stale, false);
});
