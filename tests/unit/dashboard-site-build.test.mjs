import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { promisify } from "node:util";
import {
  buildDashboardSite,
  embedDashboardVersion,
  filterExperimentalDashboardViews,
  loadDashboardControlSettings,
} from "../../dashboard/site/scripts/build.mjs";
import { validateDashboardAgentArtifacts } from "../../dashboard/site/scripts/llms.mjs";

const execFileAsync = promisify(execFile);

async function builtSiteSha(destination) {
  const index = await readFile(new URL("index.html", destination), "utf8");
  return index.match(/src="\.\/src\/main\.js\?sha=([a-f0-9]{64})"/)?.[1];
}

test("dashboard site filters experimental views unless explicitly enabled", () => {
  const document = {
    "language-version": "0.1.0",
    dashboard: {
      pages: [{ id: "stable" }, { id: "preview" }],
      navigation: [
        { label: "Main", pages: ["stable"] },
        { label: "Preview", experimental: true, pages: ["preview"] },
      ],
      callouts: [
        { id: "stable-callout", "navigation-page": "stable" },
        { id: "preview-callout", "navigation-page": "preview" },
      ],
    },
  };

  const filtered = filterExperimentalDashboardViews(document);
  assert.deepEqual(filtered.dashboard.pages, [{ id: "stable" }]);
  assert.deepEqual(filtered.dashboard.navigation, [{ label: "Main", pages: ["stable"] }]);
  assert.deepEqual(filtered.dashboard.callouts, [{ id: "stable-callout", "navigation-page": "stable" }]);
  assert.equal(filterExperimentalDashboardViews(document, true), document);
});

test("dashboard site embeds a validated commit SHA", () => {
  const html = '<meta name="dashboard-version" content="development">';
  const commitSha = "0123456789abcdef0123456789abcdef01234567";
  assert.equal(
    embedDashboardVersion(html, commitSha),
    `<meta name="dashboard-version" content="${commitSha}">`,
  );
  assert.throws(
    () => embedDashboardVersion(html, "not-a-commit"),
    /dashboard commit SHA must be a 40-character lowercase hexadecimal string/,
  );
});

test("dashboard build accepts resolved settings and extracts composed policy settings", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dashboard-control-settings-"));
  try {
    const resolvedSettings = path.join(root, "control-settings.json");
    await writeFile(resolvedSettings, '{"web":{"experimental":true}}\n');
    assert.deepEqual(await loadDashboardControlSettings(resolvedSettings), {
      web: { experimental: true },
    });

    const railwaySettings = path.resolve(".github/workflows/cao.railway.json");
    const composedSettings = await loadDashboardControlSettings(railwaySettings);
    assert.equal(composedSettings.web.experimental, true);
    assert.equal(composedSettings.web.host.target.name, "railway");
    assert.ok(composedSettings.campaigns);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dashboard site ignores the legacy flat dashboards directory", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dashboard-site-layout-"));
  const repositoryRoot = path.join(root, "repository");
  const destination = path.join(root, "output");

  try {
    await mkdir(path.join(repositoryRoot, "dashboards"), { recursive: true });
    await writeFile(path.join(repositoryRoot, "dashboards", "legacy.json"), "not valid dashboard JSON");
    await buildDashboardSite({ destination, repositoryRoot, controlSettings: { campaigns: {} } });
    assert.ok(JSON.parse(await readFile(path.join(destination, "dashboard.json"), "utf8")).dashboard);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("docs dashboard installs renderer assets without experimental campaign pages", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dashboard-site-build-"));
  const destination = pathToFileURL(`${root}/cao/`);
  const controlSettings = {
    web: { experimental: true, favicon: "https://example.com/dashboard.svg" },
    campaigns: { "uk-ai-advisory": {}, dependabot: {} },
  };

  try {
    await buildDashboardSite({ destination, controlSettings });
    const dashboard = JSON.parse(await readFile(new URL("dashboard.json", destination), "utf8"));
    const pageIds = dashboard.dashboard.pages.map(({ id }) => id);
    assert.ok(!pageIds.includes("uk-ai-advisory-dashboard"));
    assert.ok(!pageIds.includes("dependabot-dashboard"));
    assert.ok(!pageIds.includes("ambient-context-dashboard"));
    assert.match(
      await readFile(new URL("index.html", destination), "utf8"),
      /<link rel="icon" href="https:\/\/example\.com\/dashboard\.svg">/,
    );
    const builtIndex = await readFile(new URL("index.html", destination), "utf8");
    assert.match(builtIndex, /<link rel="alternate" type="text\/plain" href="\.\/llms\.txt"/);
    assert.match(builtIndex, /<a href="\.\/llms\.txt">Agent access guide<\/a>/);
    const llms = await readFile(new URL("llms.txt", destination), "utf8");
    for (const section of [
      "## Choose the cheapest access path",
      "## Skills",
      "## Published Activity artifacts",
      "## Targeted queries with MCP",
      "## Bulk analysis with CAO CLI and SQLite",
      "## Schema and freshness",
    ]) {
      assert.match(llms, new RegExp(section));
    }
    assert.match(llms, /raw\.githubusercontent\.com\/githubnext\/gh-aw-cao\/main\/skills\/debug-cao\/SKILL\.md/);
    assert.match(llms, /\[Agent summary\]\(\.\/agent-summary\.json\)/);
    const mainHash = builtIndex.match(/<script type="module" src="\.\/src\/main\.js\?sha=([a-f0-9]{64})"><\/script>/)?.[1];
    assert.ok(mainHash, "entry module includes the site content SHA");
    assert.match(
      builtIndex,
      new RegExp(`<script type="module" src="./src/main\\.js\\?sha=${mainHash}"></script>`),
    );
    assert.match(
      await readFile(new URL("src/main.js", destination), "utf8"),
      /sourceMappingURL=main\.js\.map/,
    );
    assert.match(
      await readFile(new URL("src/data-worker.js", destination), "utf8"),
      /sourceMappingURL=data-worker\.js\.map/,
    );
    const mainSourceMap = JSON.parse(await readFile(new URL("src/main.js.map", destination), "utf8"));
    const workerSourceMap = JSON.parse(await readFile(new URL("src/data-worker.js.map", destination), "utf8"));
    assert.ok(mainSourceMap.sources.some((source) => source.endsWith("/src/dashboard-app.js")));
    assert.ok(workerSourceMap.sources.some((source) => source.endsWith("/src/data-worker.js")));
    assert.equal(mainSourceMap.sources.length, mainSourceMap.sourcesContent.length);
    assert.equal(workerSourceMap.sources.length, workerSourceMap.sourcesContent.length);
    await assert.rejects(readFile(new URL("src/presenter.js", destination), "utf8"), { code: "ENOENT" });
    await assert.rejects(readFile(new URL("src/octicons.svg", destination), "utf8"), { code: "ENOENT" });
    assert.match(
      await readFile(new URL("src/main.js", destination), "utf8"),
      /octicon-rocket/,
      "bundled JavaScript includes Octicon glyphs",
    );
    await assert.rejects(readFile(new URL("uk-ai-advisory-dashboard/index.html", destination), "utf8"), { code: "ENOENT" });
    await assert.rejects(readFile(new URL("dependabot-dashboard/index.html", destination), "utf8"), { code: "ENOENT" });
    assert.match(
      await readFile(new URL("service-worker.js", destination), "utf8"),
      /periodicsync/,
    );
    const webManifest = JSON.parse(await readFile(new URL("manifest.webmanifest", destination), "utf8"));
    assert.equal(webManifest.scope, "./");
    assert.equal(webManifest.display, "standalone");
    assert.equal(webManifest.icons.length, 3);
    assert.match(
      await readFile(new URL("service-worker.js", destination), "utf8"),
      new RegExp(`const VERSION = '${mainHash}';`),
    );

    await assert.rejects(
      readFile(new URL("README.md", destination), "utf8"),
      (error) => error?.code === "ENOENT",
      "build copied a dashboard development-only source",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dashboard cache hashes are stable and change with assembled site content", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dashboard-site-cache-hash-"));
  const firstDestination = pathToFileURL(`${root}/first/`);
  const secondDestination = pathToFileURL(`${root}/second/`);
  const changedDestination = pathToFileURL(`${root}/changed/`);
  const controlSettings = { web: { favicon: "https://example.com/dashboard.svg" } };

  try {
    await buildDashboardSite({ destination: firstDestination, controlSettings });
    await buildDashboardSite({ destination: secondDestination, controlSettings });
    await buildDashboardSite({
      destination: changedDestination,
      controlSettings: { web: { favicon: "https://example.com/changed.svg" } },
    });

    const firstSha = await builtSiteSha(firstDestination);
    const secondSha = await builtSiteSha(secondDestination);
    const changedSha = await builtSiteSha(changedDestination);
    assert.ok(firstSha, "first build includes a cache hash");
    assert.equal(secondSha, firstSha, "identical content produces the same cache hash");
    assert.notEqual(changedSha, firstSha, "changed content produces a different cache hash");
    assert.match(await readFile(new URL("src/main.js", changedDestination), "utf8"), /sourceMappingURL=main\.js\.map/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dashboard agent guide describes and validates the assembled public artifacts", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dashboard-agent-guide-"));
  const activityDataPath = path.join(root, "activity");
  const destination = path.join(root, "cao");
  const artifacts = {
    "agent-summary.json": '{"schemaVersion":1,"generatedAt":"2026-09-27T00:00:00Z"}\n',
    "inventory-sources.json": "{}\n",
    "payload-hashes.json": "{}\n",
    "gh-aw-logs.sqlite": "sqlite fixture",
  };

  try {
    await mkdir(activityDataPath);
    for (const [name, content] of Object.entries(artifacts)) {
      await writeFile(path.join(activityDataPath, name), content);
    }
    await buildDashboardSite({ destination, activityDataPath, controlSettings: { campaigns: {} } });
    for (const [name, content] of Object.entries(artifacts)) {
      await writeFile(path.join(destination, name), content);
    }
    await execFileAsync(process.execPath, [
      path.resolve("dashboard/site/scripts/llms.mjs"),
      "generate",
      path.join(destination, "llms.txt"),
      destination,
    ]);
    await execFileAsync(process.execPath, [
      path.resolve("dashboard/site/scripts/llms.mjs"),
      "validate",
      destination,
      path.resolve("."),
    ]);
    await validateDashboardAgentArtifacts({
      sitePath: destination,
      repositoryPath: path.resolve("."),
    });
    const llms = await readFile(path.join(destination, "llms.txt"), "utf8");
    assert.match(llms, /Agent summary.*57 bytes/);
    assert.doesNotMatch(llms, /(?:token|secret|password|private[-_ ]key)\s*[:=]\s*\S+/i);

    await assert.rejects(
      execFileAsync(process.execPath, [
        path.resolve("dashboard/site/scripts/llms.mjs"),
        "validate",
        path.join(root, "missing"),
        path.resolve("."),
      ]),
      (error) => error?.code !== 0,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
