import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { validateAgentDocs } from "../../scripts/validate-agent-docs.mjs";

const roots = [];
const pagesBase = "https://githubnext.github.io/gh-aw-cao";
const taskRoutes = [
  ["Set up a CAO control plane", "setup-cao"],
  ["Debug a CAO failure", "debug-cao"],
  ["Add an existing campaign", "add-cao-campaign"],
  ["Create a new campaign", "create-cao-campaign"],
  ["Analyze CAO activity", "analyze-cao"],
  ["Use or extend the CAO CLI", "cao-cli"],
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
  const docs = path.join(root, "docs");
  await mkdir(docs, { recursive: true });
  const skills = path.join(root, "skills");
  await mkdir(skills, { recursive: true });
  const summaries = [];
  for (const route of Object.keys(routeTypes)) {
    const directory = path.join(dist, route);
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, "index.html"),
      `<head><link rel="describedby" href="/gh-aw-cao/agent/llms.txt"><link rel="index" type="application/json" href="/gh-aw-cao/agent/resources.json"><link rel="alternate" type="application/json" href="/gh-aw-cao/${route}/index.json"></head>`,
    );
    const sourceContent = `# ${route}\n`;
    const sourcePath = `docs/${route}.md`;
    await writeFile(path.join(root, sourcePath), sourceContent);
    const interfaces = route === "dashboard" ? {
      cli: [{
        command: "cao",
        subcommand: "pages",
        arguments: { positional: ["overview"], options: { "--json": true } },
        readOnly: true,
      }],
      mcp: [
        {
          transport: "cli",
          capability: "cao_catalog",
          arguments: { kind: "pages", id: "overview" },
          readOnly: true,
        },
        { transport: "web", capability: "cao_overview", resourceId: "overview", readOnly: true },
      ],
    } : undefined;
    await writeFile(path.join(directory, "index.json"), JSON.stringify({
      schemaVersion: "1",
      id: route,
      type: routeTypes[route],
      title: route,
      url: `${pagesBase}/${route}/`,
      source: {
        repository: "githubnext/gh-aw-cao",
        path: sourcePath,
        url: `https://github.com/githubnext/gh-aw-cao/blob/main/${sourcePath}`,
      },
      links: [{ rel: "canonical", href: `${pagesBase}/${route}/` }],
      provenance: { repository: "githubnext/gh-aw-cao", generator: "test", generatorVersion: "1" },
      freshness: { generatedAt: "2026-09-27T23:00:00.000Z" },
      integrity: {
        algorithm: "sha256",
        sourceDigest: createHash("sha256").update(sourceContent).digest("hex"),
      },
      ...(interfaces ? {
        interfaces,
        recommendedInterface: {
          default: "web-mcp",
          alternatives: ["cli", "cli-mcp"],
        },
      } : {}),
    }));
    summaries.push({
      id: route,
      type: routeTypes[route],
      url: `${pagesBase}/${route}/`,
      agent: `${pagesBase}/${route}/index.json`,
      ...(interfaces ? { interfaces: ["cli", "cli-mcp", "web-mcp"] } : {}),
    });
  }
  const indexSource = "# Central Agentic Ops\n";
  await writeFile(path.join(docs, "README.md"), indexSource);
  await writeFile(
    path.join(dist, "index.html"),
    '<head><link rel="describedby" href="/gh-aw-cao/agent/llms.txt"><link rel="index" type="application/json" href="/gh-aw-cao/agent/resources.json"><link rel="alternate" type="application/json" href="/gh-aw-cao/index.json"></head>',
  );
  await writeFile(path.join(dist, "index.json"), JSON.stringify({
    schemaVersion: "1",
    id: "index",
    type: "overview",
    title: "Central Agentic Ops",
    url: `${pagesBase}/`,
    source: {
      repository: "githubnext/gh-aw-cao",
      path: "docs/README.md",
      url: "https://github.com/githubnext/gh-aw-cao/blob/main/docs/README.md",
    },
    links: [{ rel: "canonical", href: `${pagesBase}/` }],
    provenance: { repository: "githubnext/gh-aw-cao", generator: "test", generatorVersion: "1" },
    freshness: { generatedAt: "2026-09-27T23:00:00.000Z" },
    integrity: {
      algorithm: "sha256",
      sourceDigest: createHash("sha256").update(indexSource).digest("hex"),
    },
  }));
  summaries.push({
    id: "index",
    type: "overview",
    url: `${pagesBase}/`,
    agent: `${pagesBase}/index.json`,
  });
  const skillLinks = taskRoutes.map(
    ([task, skill]) =>
      `- [${task}](https://github.com/githubnext/gh-aw-cao/blob/main/skills/${skill}/SKILL.md)`,
  );
  for (const [, skill] of taskRoutes) {
    await mkdir(path.join(skills, skill), { recursive: true });
    await writeFile(path.join(skills, skill, "SKILL.md"), `# ${skill}\n`);
  }
  await writeFile(path.join(dist, "llms.txt"), [
    "# Central Agentic Ops",
    `- [Abridged](${pagesBase}/llms-small.txt)`,
    `- [Full](${pagesBase}/llms-full.txt)`,
    `- [Scoped resources](${pagesBase}/agent/llms.txt)`,
    `- [Machine resources](${pagesBase}/agent/resources.json)`,
    `- [Dashboard agent guide](${pagesBase}/cao/llms.txt)`,
    ...skillLinks,
  ].join("\n"));
  await writeFile(path.join(dist, "llms-small.txt"), "# Compact\nUseful.");
  await writeFile(path.join(dist, "llms-full.txt"), [
    "# Complete",
    "Broad content.",
    "# Activity cache compression analysis",
    "# Campaign rhythm",
    "# Dashboard view catalog",
    ...Object.keys(routeTypes).map((route) => `# ${route}`),
    "# Central Agentic Ops",
  ].join("\n\n"));
  await mkdir(path.join(dist, "agent"), { recursive: true });
  await writeFile(path.join(dist, "agent", "resources.json"), JSON.stringify({
    schemaVersion: "1",
    resources: summaries.sort((left, right) => left.id.localeCompare(right.id)),
  }));
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
  assert.ok((await validateAgentDocs({ root })).some((error) =>
    error.includes("unresolved") || error.includes("missing JSON resource")
  ));
});

test("rejects a missing required route", async () => {
  const root = await createFixture();
  const indexPath = path.join(root, "dist", "llms.txt");
  const index = await import("node:fs/promises").then(({ readFile }) => readFile(indexPath, "utf8"));
  await writeFile(indexPath, index.replace(
    "- [Analyze CAO activity](https://github.com/githubnext/gh-aw-cao/blob/main/skills/analyze-cao/SKILL.md)\n",
    "",
  ));
  assert.ok((await validateAgentDocs({ root })).some((error) => error.includes("Analyze CAO activity")));
});

test("rejects an ambiguous one-hop task route", async () => {
  const root = await createFixture();
  const indexPath = path.join(root, "dist", "llms.txt");
  const index = await readFile(indexPath, "utf8");
  await writeFile(indexPath, index.replace(
    "skills/analyze-cao/SKILL.md)",
    "skills/analyze-cao/SKILL.md) [debug](https://github.com/githubnext/gh-aw-cao/blob/main/skills/debug-cao/SKILL.md)",
  ));
  assert.ok((await validateAgentDocs({ root })).some((error) => error.includes("only the analyze-cao skill")));
});

test("rejects oversized routing, context, and skill entry points", async () => {
  const root = await createFixture();
  await writeFile(path.join(root, "dist", "llms-small.txt"), "x".repeat(65 * 1024));
  await writeFile(path.join(root, "skills", "cao-cli", "SKILL.md"), "x".repeat(13 * 1024));
  const errors = await validateAgentDocs({ root });
  assert.ok(errors.some((error) => error.includes("llms-small.txt exceeds")));
  assert.ok(errors.some((error) => error.includes("cao-cli/SKILL.md exceeds")));
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
    trackedFiles: ["llms.txt", "docs/agent-index.json", "public/agent/resources.json"],
  });
  assert.equal(errors.filter((error) => error.includes("must not be committed")).length, 3);
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

test("rejects source integrity and resource-index drift", async () => {
  const root = await createFixture();
  await writeFile(path.join(root, "docs", "architecture.md"), "# changed\n");
  const indexPath = path.join(root, "dist", "agent", "resources.json");
  const index = JSON.parse(await readFile(indexPath, "utf8"));
  index.resources.reverse();
  await writeFile(indexPath, JSON.stringify(index));
  const errors = await validateAgentDocs({ root });
  assert.ok(errors.some((error) => error.includes("source integrity does not match")));
  assert.ok(errors.some((error) => error.includes("sorted by identifier")));
});

test("rejects unregistered operational bindings", async () => {
  const root = await createFixture();
  const resourcePath = path.join(root, "dist", "dashboard", "index.json");
  const resource = JSON.parse(await readFile(resourcePath, "utf8"));
  resource.interfaces.cli[0].subcommand = "invented";
  resource.interfaces.mcp[1].capability = "cao_invented";
  await writeFile(resourcePath, JSON.stringify(resource));
  const errors = await validateAgentDocs({ root });
  assert.ok(errors.some((error) => error.includes("unregistered CLI command")));
  assert.ok(errors.some((error) => error.includes("unregistered WebMCP capability")));
});

test("rejects MCP arguments that do not satisfy the registered tool schema", async () => {
  const root = await createFixture();
  const resourcePath = path.join(root, "dist", "dashboard", "index.json");
  const resource = JSON.parse(await readFile(resourcePath, "utf8"));
  delete resource.interfaces.mcp[0].arguments.kind;
  await writeFile(resourcePath, JSON.stringify(resource));
  const errors = await validateAgentDocs({ root });
  assert.ok(errors.some((error) => error.includes("invalid CLI MCP arguments")));
});

test("rejects an HTML route whose JSON resource and index entry both disappear", async () => {
  const root = await createFixture();
  await rm(path.join(root, "dist", "architecture", "index.json"));
  const indexPath = path.join(root, "dist", "agent", "resources.json");
  const index = JSON.parse(await readFile(indexPath, "utf8"));
  index.resources = index.resources.filter((resource) => resource.id !== "architecture");
  await writeFile(indexPath, JSON.stringify(index));
  const errors = await validateAgentDocs({ root });
  assert.ok(errors.some((error) => error.includes("advertises a missing JSON resource")));
});
