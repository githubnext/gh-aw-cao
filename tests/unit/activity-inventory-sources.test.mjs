import assert from "node:assert/strict";
import test from "node:test";
import {
  buildInventoryDashboardSources,
  discoverRepositories,
  discoverWorkflowRegistries,
} from "../../activity/inventory-sources.mjs";
import { adaptDashboardSources } from "../../dashboard/site/src/data/adapters/dashboard-sources.js";
import { adaptGhAwLogs } from "../../dashboard/site/src/data/adapters/gh-aw-logs.js";
import { normalize } from "../../dashboard/site/src/data/normalize/index.js";

function workflow(id, path, overrides = {}) {
  return {
    id,
    name: `Workflow ${id}`,
    path,
    state: "active",
    html_url: `https://github.com/acme/app/actions/workflows/${id}`,
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-16T00:00:00Z",
    ...overrides,
  };
}

test("discovers public workflow registry metadata and disabled state", async () => {
  const registries = await discoverWorkflowRegistries([{ full_name: "acme/app" }], {
    token: "test-token",
    fetchImplementation: async (url) => {
      assert.match(String(url), /repos\/acme\/app\/actions\/workflows\?per_page=100&page=1$/);
      return new Response(JSON.stringify({
        total_count: 2,
        workflows: [
          workflow(101, ".github/workflows/ci.yml", { name: "CI" }),
          workflow(102, ".github/workflows/release.yml", {
            name: "Release",
            state: "disabled_manually",
          }),
        ],
      }));
    },
  });
  const sources = buildInventoryDashboardSources({
    repository: "acme/control",
    generatedAt: "2026-09-17T00:00:00Z",
    inventory: { workflows: [], bundles: [] },
    controlSettings: {},
    discoveredRepositories: [{ full_name: "acme/app", visibility: "public" }],
    workflowRegistries: registries,
  });

  assert.equal(sources.workflows.metadata.completeness, "complete");
  assert.equal(sources.workflows.metadata["coverage-expected"], 1);
  assert.equal(sources.workflows.metadata["coverage-observed"], 1);
  assert.deepEqual(sources.workflows.rows.map((row) => ({
    repository: `${row.organization}/${row.repository}`,
    name: row["workflow-name"],
    path: row.workflow,
    active: row["workflow-active"],
    role: row["workflow-role"],
    id: row["workflow-id"],
    href: row["workflow-link"]?.href,
  })), [
    {
      repository: "acme/app",
      name: "CI",
      path: ".github/workflows/ci.yml",
      active: "true",
      role: "standalone",
      id: "101",
      href: "https://github.com/acme/app/actions/workflows/101",
    },
    {
      repository: "acme/app",
      name: "Release",
      path: ".github/workflows/release.yml",
      active: "false",
      role: "standalone",
      id: "102",
      href: "https://github.com/acme/app/actions/workflows/102",
    },
  ]);
});

test("paginates workflow registries until total_count is observed", async () => {
  const requestedPages = [];
  const registries = await discoverWorkflowRegistries([{ full_name: "acme/app" }], {
    token: "test-token",
    fetchImplementation: async (url) => {
      const page = Number(new URL(String(url)).searchParams.get("page"));
      requestedPages.push(page);
      const workflows = page === 1
        ? Array.from({ length: 100 }, (_, index) => workflow(index + 1, `.github/workflows/job-${index + 1}.yml`))
        : [workflow(101, ".github/workflows/job-101.yml")];
      return new Response(JSON.stringify({ total_count: 101, workflows }));
    },
  });

  assert.deepEqual(requestedPages, [1, 2]);
  assert.equal(registries[0].state, "complete");
  assert.equal(registries[0].pages, 2);
  assert.equal(registries[0].workflows.length, 101);
});

test("excludes deleted workflows without degrading registry completeness", async () => {
  const registries = await discoverWorkflowRegistries([{ full_name: "acme/app" }], {
    token: "test-token",
    fetchImplementation: async () => new Response(JSON.stringify({
      total_count: 1,
      workflows: [workflow(101, ".github/workflows/deleted.yml", { state: "deleted" })],
    })),
  });

  assert.equal(registries[0].state, "complete");
  assert.equal(registries[0].observed, 1);
  assert.deepEqual(registries[0].workflows, []);
});

test("includes the control repository when target discovery omits it", async () => {
  const requestedRepositories = [];
  const registries = await discoverWorkflowRegistries([{ full_name: "acme/app" }], {
    token: "test-token",
    controlRepository: "acme/control",
    fetchImplementation: async (url) => {
      const repository = String(url).match(/repos\/([^/]+\/[^/]+)\/actions/)?.[1];
      assert.ok(repository);
      requestedRepositories.push(repository);
      return new Response(JSON.stringify({ total_count: 0, workflows: [] }));
    },
  });

  assert.deepEqual(requestedRepositories, ["acme/app", "acme/control"]);
  assert.deepEqual(registries.map((registry) => registry.repository), ["acme/app", "acme/control"]);
});

test("represents inaccessible repositories and workflow registries as partial evidence", async () => {
  const discoveredRepositories = await discoverRepositories({
    allowed_repositories: ["acme/app", "acme/private"],
    policy_document: { "control-plane": { inventory: { "max-scan-repositories": 10 } } },
  }, {
    token: "test-token",
    fetchImplementation: async (url) => String(url).endsWith("/repos/acme/private")
      ? new Response("", { status: 404 })
      : new Response(JSON.stringify({ full_name: "acme/app", visibility: "public" })),
  });
  const registries = await discoverWorkflowRegistries(discoveredRepositories, {
    token: "test-token",
    fetchImplementation: async (url) => String(url).includes("/repos/acme/private/")
      ? new Response("", { status: 404 })
      : new Response(JSON.stringify({
          total_count: 1,
          workflows: [workflow(101, ".github/workflows/ci.yml", { name: "CI" })],
        })),
  });
  const sources = buildInventoryDashboardSources({
    repository: "acme/control",
    generatedAt: "2026-09-17T00:00:00Z",
    inventory: { workflows: [], bundles: [] },
    controlSettings: {},
    discoveredRepositories,
    workflowRegistries: registries,
  });

  assert.equal(sources.repositories.metadata.availability, "available");
  assert.equal(sources.repositories.metadata.completeness, "partial");
  assert.equal(sources.repositories.metadata["coverage-expected"], 2);
  assert.equal(sources.repositories.metadata["coverage-observed"], 1);
  assert.equal(sources.repositories.metadata["repository-failures"][0].repository, "acme/private");
  assert.equal(sources.workflows.metadata.availability, "available");
  assert.equal(sources.workflows.metadata.completeness, "partial");
  assert.equal(sources.workflows.metadata["coverage-expected"], 2);
  assert.equal(sources.workflows.metadata["coverage-observed"], 1);
  assert.equal(sources.workflows.metadata["repository-failures"][0].repository, "acme/private");
  assert.deepEqual(sources.workflows.rows.map((row) => `${row.organization}/${row.repository}`), ["acme/app"]);
});

test("merges control registry metadata without replacing package ownership", () => {
  const generatedAt = "2026-09-17T00:00:00Z";
  const sources = buildInventoryDashboardSources({
    repository: "acme/control",
    generatedAt,
    inventory: {
      workflows: [{
        id: "worker",
        name: "Declared Worker",
        role: "worker",
        sourcePath: ".github/workflows/worker.md",
        compiled: true,
        maxAiCredits: 25,
      }],
      bundles: [{
        id: "operations",
        controlPackage: "operations",
        name: "Operations",
        workflow: ".github/workflows/orchestrator.md",
        compiled: true,
        missingWorkers: [],
        workers: [{
          id: "worker",
          sourcePath: ".github/workflows/worker.md",
          compiled: true,
          maxAiCredits: 25,
        }],
      }],
    },
    controlSettings: {
      allowed_repositories: ["acme/control"],
      packages: {
        operations: {
          mode: "review",
          worker_policies: { worker: { enabled: true } },
        },
      },
      policy_resolution: { status: "available" },
    },
    discoveredRepositories: [{ full_name: "acme/control", visibility: "private" }],
    workflowRegistries: [{
      repository: "acme/control",
      expected: 1,
      observed: 1,
      pages: 1,
      state: "complete",
      failure: null,
      workflows: [{
        repository: "acme/control",
        id: 501,
        name: "Registered Worker",
        path: ".github/workflows/worker.lock.yml",
        state: "disabled_inactivity",
        htmlUrl: "https://github.com/acme/control/actions/workflows/501",
        createdAt: null,
        updatedAt: null,
      }],
    }],
  });

  assert.equal(sources.workflows.rows.length, 1);
  assert.deepEqual(sources.workflows.rows[0], {
    organization: "acme",
    repository: "control",
    package: "operations",
    "package-name": "Operations",
    "package-icon": "package",
    "package-aic-allowance": 25,
    "package-worker-count": 1,
    "package-inventory-warnings": 0,
    "max-ai-credits": 25,
    "inventory-ready": true,
    "admission-status": "authorized",
    "admission-reason": "authorized",
    workflow: ".github/workflows/worker.md",
    "workflow-name": "Registered Worker",
    "workflow-role": "worker",
    "workflow-active": "false",
    "rollout-mode": "review",
    "observed-at": generatedAt,
    "workflow-registry-state": "disabled_inactivity",
    "workflow-id": "501",
    "workflow-link": {
      relation: "workflow",
      href: "https://github.com/acme/control/actions/workflows/501",
      label: "View Registered Worker",
    },
  });
});

test("preserves an unknown registry state instead of inferring active from compilation", () => {
  const sources = buildInventoryDashboardSources({
    repository: "acme/control",
    generatedAt: "2026-09-17T00:00:00Z",
    inventory: {
      workflows: [{
        id: "worker",
        name: "Declared Worker",
        sourcePath: ".github/workflows/worker.md",
        compiled: true,
      }],
      bundles: [],
    },
    controlSettings: {},
    discoveredRepositories: [{ full_name: "acme/control", visibility: "private" }],
    workflowRegistries: [{
      repository: "acme/control",
      expected: 1,
      observed: 1,
      pages: 1,
      state: "complete",
      failure: null,
      workflows: [{
        repository: "acme/control",
        id: 501,
        name: "Registered Worker",
        path: ".github/workflows/worker.lock.yml",
        state: "unknown",
        htmlUrl: "https://github.com/acme/control/actions/workflows/501",
        createdAt: null,
        updatedAt: null,
      }],
    }],
  });

  assert.equal(sources.workflows.rows[0]["workflow-active"], "unknown");
});

test("does not infer active state when registry evidence is unavailable", () => {
  const sources = buildInventoryDashboardSources({
    repository: "acme/control",
    generatedAt: "2026-09-17T00:00:00Z",
    inventory: {
      workflows: [{
        id: "worker",
        name: "Declared Worker",
        sourcePath: ".github/workflows/worker.md",
        compiled: true,
      }],
      bundles: [],
    },
    controlSettings: {},
    discoveredRepositories: [{ full_name: "acme/control", visibility: "private" }],
    workflowRegistries: [{
      repository: "acme/control",
      expected: null,
      observed: 0,
      pages: 0,
      state: "unavailable",
      failure: {
        repository: "acme/control",
        state: "unavailable",
        "failure-class": "permission",
        status: 403,
        reason: "Unable to discover workflows for acme/control: 403",
      },
      workflows: [],
    }],
  });

  assert.equal(sources.workflows.rows[0]["workflow-active"], "unknown");
});

test("remote registry and run-derived workflows share one canonical identity", () => {
  const generatedAt = "2026-09-17T00:00:00Z";
  const sources = buildInventoryDashboardSources({
    repository: "acme/control",
    generatedAt,
    inventory: { workflows: [], bundles: [] },
    controlSettings: {},
    discoveredRepositories: [{ full_name: "acme/app", visibility: "public" }],
    workflowRegistries: [{
      repository: "acme/app",
      expected: 1,
      observed: 1,
      pages: 1,
      state: "complete",
      failure: null,
      workflows: [{
        repository: "acme/app",
        id: 101,
        name: "CI",
        path: ".github/workflows/ci.yml",
        state: "active",
        htmlUrl: "https://github.com/acme/app/actions/workflows/101",
        createdAt: null,
        updatedAt: null,
      }],
    }],
  });
  const inventoryObservations = adaptDashboardSources(sources).observations;
  const runObservations = adaptGhAwLogs({
    observedAt: generatedAt,
    repository: { githubId: 1, owner: "acme", name: "app", visibility: "public" },
    workflow: { githubId: 101, name: "CI run", path: ".github/workflows/ci.yml", state: "unknown" },
    run: {
      githubRunId: 9001,
      attempt: 1,
      event: "push",
      status: "completed",
      conclusion: "success",
    },
    files: [],
  }).observations;
  const canonical = normalize([...runObservations, ...inventoryObservations], {
    sourcePrecedence: { "gh-aw-logs": 1, "dashboard-sources": 2 },
  });

  assert.equal(canonical.workflows.length, 1);
  assert.equal(canonical.workflows[0].name, "CI");
  assert.equal(canonical.workflows[0].path, ".github/workflows/ci.yml");
  assert.equal(canonical.workflows[0].state, "active");
  assert.equal(canonical.workflows[0].githubId, "101");
  assert.equal(canonical.workflows[0].registryState, "active");
  assert.equal(canonical.runs[0].workflowId, canonical.workflows[0].id);
});
