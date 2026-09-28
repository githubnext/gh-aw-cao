import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { validateAgentDocs } from "../../scripts/validate-agent-docs.mjs";

const roots = [];
const pagesBase = "https://githubnext.github.io/gh-aw-cao";
const routeNames = [
  "architecture",
  "cao-cli",
  "author-your-first-operation",
  "control-policy-specification",
  "activity",
  "dashboard",
];
const skillNames = [
  "setup-cao",
  "debug-cao",
  "add-cao-campaign",
  "create-cao-campaign",
  "analyze-cao",
  "cao-cli",
];
const routeTypes = {
  architecture: "architecture",
  "cao-cli": "cli-reference",
  "author-your-first-operation": "campaign-guide",
  "control-policy-specification": "documentation",
  activity: "data-collection",
  dashboard: "dashboard",
  "dashboard-data-model": "data-model",
  "dashboard-language": "query-language",
  operations: "operations",
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "cao-agent-docs-"));
  roots.push(root);
  const dist = path.join(root, "dist");
  await mkdir(dist, { recursive: true });
  for (const route of Object.keys(routeTypes)) {
    const directory = path.join(dist, route);
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, "index.html"),
      `<head><link rel="describedby" href="/gh-aw-cao/agent/llms.txt"><link rel="alternate" type="application/json" href="/gh-aw-cao/${route}/index.json"></head>`,
    );
    await writeFile(path.join(directory, "index.json"), JSON.stringify({
      schemaVersion: "1",
      id: route,
      type: routeTypes[route],
      title: route,
      url: `${pagesBase}/${route}/`,
      links: [{ rel: "canonical", href: `${pagesBase}/${route}/` }],
      provenance: { repository: "githubnext/gh-aw-cao", generator: "test", generatorVersion: "1" },
      freshness: { generatedAt: "2026-09-27T23:00:00.000Z" },
    }));
  }
  await writeFile(
    path.join(dist, "index.html"),
    '<head><link rel="describedby" href="/gh-aw-cao/agent/llms.txt"><link rel="alternate" type="application/json" href="/gh-aw-cao/index.json"></head>',
  );
  await writeFile(path.join(dist, "index.json"), JSON.stringify({
    schemaVersion: "1",
    id: "index",
    type: "overview",
    title: "Central Agentic Ops",
    url: `${pagesBase}/`,
    links: [{ rel: "canonical", href: `${pagesBase}/` }],
    provenance: { repository: "githubnext/gh-aw-cao", generator: "test", generatorVersion: "1" },
    freshness: { generatedAt: "2026-09-27T23:00:00.000Z" },
  }));
  const routeLinks = routeNames.map((route) => `- [${route}](${pagesBase}/${route}/)`);
  const skillLinks = skillNames.map(
    (skill) => `- [${skill}](https://github.com/githubnext/gh-aw-cao/blob/main/skills/${skill}/SKILL.md)`,
  );
  await writeFile(path.join(dist, "llms.txt"), [
    "# Central Agentic Ops",
    `- [Abridged](${pagesBase}/llms-small.txt)`,
    `- [Full](${pagesBase}/llms-full.txt)`,
    `- [Scoped resources](${pagesBase}/agent/llms.txt)`,
    `- [Dashboard agent guide](${pagesBase}/cao/llms.txt)`,
    ...routeLinks,
    ...skillLinks,
  ].join("\n"));
  await writeFile(path.join(dist, "llms-small.txt"), "# Compact\nUseful.");
  await writeFile(path.join(dist, "llms-full.txt"), [
    "# Complete",
    "Broad content.",
    "# Activity cache compression analysis",
    "# Campaign rhythm",
    "# Dashboard view catalog",
  ].join("\n\n"));
  await mkdir(path.join(dist, "agent"), { recursive: true });
  await writeFile(path.join(dist, "agent", "llms.txt"), [
    "# Agent resources",
    `- [Dashboard agent guide](${pagesBase}/cao/llms.txt)`,
    ...Object.keys(routeTypes).flatMap((route) => [
      `- [${route}](${pagesBase}/${route}/)`,
      `- [${route} metadata](${pagesBase}/${route}/index.json)`,
    ]),
  ].join("\n"));
  return root;
}

test("accepts structurally valid generated agent documentation", async () => {
  const root = await createFixture();
  assert.deepEqual(await validateAgentDocs({ root }), []);
});

test("rejects a missing generated artifact", async () => {
  const root = await createFixture();
  await rm(path.join(root, "dist", "llms-small.txt"));
  assert.ok((await validateAgentDocs({ root })).some((error) => error.includes("llms-small.txt must exist")));
});

test("rejects an unresolved internal link", async () => {
  const root = await createFixture();
  await rm(path.join(root, "dist", "dashboard"), { recursive: true });
  assert.ok((await validateAgentDocs({ root })).some((error) => error.includes("unresolved internal link")));
});

test("rejects a missing required route", async () => {
  const root = await createFixture();
  const indexPath = path.join(root, "dist", "llms.txt");
  const index = await import("node:fs/promises").then(({ readFile }) => readFile(indexPath, "utf8"));
  await writeFile(indexPath, index.replace(`- [activity](${pagesBase}/activity/)\n`, ""));
  assert.ok((await validateAgentDocs({ root })).some((error) => error.includes("/activity/")));
});

test("requires the separately assembled dashboard agent guide", async () => {
  const root = await createFixture();
  const indexPath = path.join(root, "dist", "llms.txt");
  const index = await import("node:fs/promises").then(({ readFile }) => readFile(indexPath, "utf8"));
  await writeFile(indexPath, index.replace(`- [Dashboard agent guide](${pagesBase}/cao/llms.txt)\n`, ""));
  assert.ok((await validateAgentDocs({ root })).some((error) =>
    error.includes("dashboard agent access guide")
  ));
});

test("rejects development paths and credential-like content", async () => {
  const root = await createFixture();
  await writeFile(
    path.join(root, "dist", "llms-small.txt"),
    "[local](http://localhost:4321/docs)\nghp_abcdefghijklmnopqrstuvwxyz123456",
  );
  const errors = await validateAgentDocs({ root });
  assert.ok(errors.some((error) => error.includes("development-machine")));
  assert.ok(errors.some((error) => error.includes("credential-like")));
});

test("rejects committed generated indexes", async () => {
  const root = await createFixture();
  const errors = await validateAgentDocs({
    root,
    trackedFiles: ["llms.txt", "docs/agent-index.json"],
  });
  assert.equal(errors.filter((error) => error.includes("must not be committed")).length, 2);
});

test("rejects invalid freshness and missing provenance", async () => {
  const root = await createFixture();
  const resourcePath = path.join(root, "dist", "architecture", "index.json");
  const resource = JSON.parse(await import("node:fs/promises").then(({ readFile }) => readFile(resourcePath, "utf8")));
  resource.provenance = {};
  resource.freshness.generatedAt = "not-a-date";
  await writeFile(resourcePath, JSON.stringify(resource));
  const errors = await validateAgentDocs({ root });
  assert.ok(errors.some((error) => error.includes("repository provenance")));
  assert.ok(errors.some((error) => error.includes("invalid generatedAt")));
});
