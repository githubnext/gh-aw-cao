import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const executeFile = promisify(execFile);
const cao = path.resolve("activity/cao.mjs");

test("discover-workflows collects a bounded repository set locally", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cao-discovery-"));
  const workflowDirectory = path.join(root, ".github", "workflows");
  const inventoryPath = path.join(root, "inventory.json");
  const outputPath = path.join(root, "inventory-sources.json");
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.url);
    const payload = request.url === "/repos/github/gh-aw/releases?per_page=100&page=1"
      ? [{ tag_name: "v0.89.15", prerelease: false, draft: false }]
      : request.url?.includes("/actions/workflows")
        ? {
            total_count: 1,
            workflows: [{
              id: 1,
              name: "CI",
              path: ".github/workflows/ci.yml",
              state: "active",
            }],
          }
        : {
            full_name: request.url?.slice("/repos/".length),
            visibility: "private",
          };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(payload));
  });

  try {
    await mkdir(workflowDirectory, { recursive: true });
    await writeFile(path.join(root, "aw.yml"), "name: Fixture\nincludes: []\n");
    await writeFile(path.join(workflowDirectory, "cao.json"), JSON.stringify({
      version: 1,
      "control-plane": { packages: {} },
    }));
    await writeFile(path.join(workflowDirectory, "ci.md"), "---\nname: CI\n---\n");
    const settingsPath = path.join(root, "control-settings.json");
    await writeFile(settingsPath, JSON.stringify({
      allowed_repositories: ["acme/app"],
      packages: {},
      policy_document: {
        "control-plane": {
          inventory: { "max-scan-repositories": 2 },
        },
      },
    }));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();

    const { stdout } = await executeFile(cao, [
      "discover-workflows",
      "--root", root,
      "--control-settings", settingsPath,
      "--inventory", inventoryPath,
      "--output", outputPath,
      "--repo", "acme/control",
    ], {
      env: {
        ...process.env,
        GH_TOKEN: "test-token",
        GITHUB_API_URL: `http://127.0.0.1:${port}`,
      },
    });

    assert.match(stdout, /Repository discovery selected 1 repositories/);
    assert.match(stdout, /Workflow discovery for acme\/app: complete/);
    assert.match(stdout, /Workflow discovery for acme\/control: complete/);
    const result = JSON.parse(stdout.slice(stdout.lastIndexOf("\n{") + 1));
    assert.deepEqual(result, {
      command: "discover-workflows",
      repositories: 2,
      packages: 0,
      workflows: 3,
    });
    const sources = JSON.parse(await readFile(outputPath, "utf8"));
    assert.equal(sources.repositories.rows.length, 2);
    assert.equal(sources.workflows.rows.filter((workflow) => workflow["workflow-name"] === "CI").length, 3);
    assert.equal(requests.filter((url) => url?.includes("/actions/workflows")).length, 2);
    assert.equal(requests.filter((url) => url?.startsWith("/repos/acme/") && !url.includes("/actions/")).length, 1);
  } finally {
    server.close();
    await rm(root, { recursive: true, force: true });
  }
});
