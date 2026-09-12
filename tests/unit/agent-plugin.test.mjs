import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const root = new URL("../../", import.meta.url);

test("Agent Plugins manifest exposes portable skills and Copilot namespace", async () => {
  const manifest = JSON.parse(await readFile(new URL("plugin.json", root), "utf8"));

  assert.equal(
    manifest.$schema,
    "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  );
  assert.equal(manifest.name, "central-agentic-ops");
  assert.match(manifest.description, /analyze activity data/);
  assert.match(manifest.description, /local CAO dashboard previews/);
  assert.deepEqual(manifest.extensions, { "com.github.copilot": {} });
  await readFile(new URL("skills/create-ops-package/SKILL.md", root), "utf8");
  await readFile(new URL("skills/analyze-agentic-ops/SKILL.md", root), "utf8");
});

test("Copilot extension uses the current Canvas provider contract", async () => {
  const extensionRoot = new URL(
    "com.github.copilot/extensions/cao-dashboard/",
    root,
  );
  const metadata = JSON.parse(
    await readFile(new URL("copilot-extension.json", extensionRoot), "utf8"),
  );
  const source = await readFile(
    new URL("extension.mjs", extensionRoot),
    "utf8",
  );

  assert.deepEqual(metadata, { name: "cao-dashboard", version: 1 });
  assert.match(source, /@github\/copilot-sdk\/extension/);
  assert.match(source, /joinSession\(\{\s*canvases:/);
  assert.match(source, /createCanvas\(\{/);
  assert.match(source, /context\.session\?\.workingDirectory/);
  assert.match(source, /startLocalDashboardPreview/);
  assert.match(source, /onClose:/);
  assert.match(source, /additionalProperties: false/);
  assert.doesNotMatch(source, /github\.io|https:/);
});
