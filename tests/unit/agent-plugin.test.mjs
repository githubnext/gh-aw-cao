import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  normalizeRepository,
  pagesUrlForRepository,
  repositoryFromRemote,
  resolveDashboardUrl,
} from "../../com.github.copilot/extensions/cao-dashboard/dashboard-url.mjs";

const root = new URL("../../", import.meta.url);

test("Agent Plugins manifest exposes the portable skill and Copilot canvas", async () => {
  const manifest = JSON.parse(await readFile(new URL("plugin.json", root), "utf8"));
  const packageJson = JSON.parse(
    await readFile(new URL("package.json", root), "utf8"),
  );

  assert.equal(
    manifest.$schema,
    "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  );
  assert.equal(manifest.name, "central-agentic-ops");
  assert.equal(
    packageJson.main,
    "com.github.copilot/extensions/cao-dashboard/extension.mjs",
  );
  await readFile(new URL("skills/create-ops-package/SKILL.md", root), "utf8");
  await readFile(new URL(packageJson.main, root), "utf8");
});

test("Claude Code manifest and marketplace expose the plugin", async () => {
  const manifest = JSON.parse(
    await readFile(new URL(".claude-plugin/plugin.json", root), "utf8"),
  );
  const marketplace = JSON.parse(
    await readFile(new URL(".claude-plugin/marketplace.json", root), "utf8"),
  );

  assert.equal(manifest.name, "central-agentic-ops");
  assert.equal(
    marketplace.$schema,
    "https://json.schemastore.org/claude-code-marketplace.json",
  );
  assert.deepEqual(
    marketplace.plugins.map(({ name, source }) => ({ name, source })),
    [{ name: "central-agentic-ops", source: "./" }],
  );
});

test("repository parsing accepts common GitHub remotes", () => {
  assert.equal(normalizeRepository("githubnext/gh-aw-cao"), "githubnext/gh-aw-cao");
  assert.equal(
    repositoryFromRemote("git@github.com:githubnext/gh-aw-cao.git"),
    "githubnext/gh-aw-cao",
  );
  assert.equal(
    repositoryFromRemote("https://github.com/octo-org/control-plane.git"),
    "octo-org/control-plane",
  );
  assert.equal(repositoryFromRemote("https://example.com/owner/repo"), undefined);
});

test("Pages URLs handle CAO catalog, control, and account sites", () => {
  assert.equal(
    pagesUrlForRepository("githubnext/gh-aw-cao"),
    "https://githubnext.github.io/gh-aw-cao/cao/",
  );
  assert.equal(
    pagesUrlForRepository("octo-org/control-plane"),
    "https://octo-org.github.io/control-plane/",
  );
  assert.equal(
    pagesUrlForRepository("octocat/octocat.github.io"),
    "https://octocat.github.io/",
  );
  assert.equal(
    pagesUrlForRepository("octo-org/control-plane", "/ops/current/"),
    "https://octo-org.github.io/control-plane/ops/current/",
  );
});

test("dashboard resolution supports explicit and detected targets", async () => {
  assert.equal(
    await resolveDashboardUrl({ url: "https://cao.example.test/dashboard" }),
    "https://cao.example.test/dashboard",
  );
  assert.equal(
    await resolveDashboardUrl(
      {},
      {
        environment: {},
        readRemote: async () => "git@github.com:octo-org/control-plane.git\n",
      },
    ),
    "https://octo-org.github.io/control-plane/",
  );
  await assert.rejects(
    resolveDashboardUrl({ url: "http://cao.example.test" }),
    /must use HTTPS/,
  );
  assert.throws(
    () => pagesUrlForRepository("octo-org/control-plane", "../private"),
    /safe relative URL path/,
  );
});
