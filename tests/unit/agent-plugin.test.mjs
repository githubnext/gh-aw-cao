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
  for (const skillName of ["setup-cao", "create-cao-package", "analyze-cao", "cao-cli"]) {
    const skill = await readFile(
      new URL(`skills/${skillName}/SKILL.md`, root),
      "utf8",
    );
    assert.match(skill, new RegExp(`^---\\nname: ${skillName}\\n`));
  }
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
  assert.match(source, /joinSession\(\{[\s\S]*canvases:/);
  assert.match(source, /createCanvas\(\{/);
  assert.match(source, /context\.session\?\.workingDirectory/);
  assert.match(source, /startLocalDashboardPreview/);
  assert.match(source, /requestedEnvironmentVariables: \["GH_TOKEN", "GITHUB_TOKEN"\]/);
  assert.match(source, /executeDashboardCommand/);
  assert.match(source, /cao_dashboard_execute_query/);
  assert.match(source, /cao_dashboard_read_data_specification/);
  assert.match(source, /onSessionStart:/);
  assert.match(source, /onClose:/);
  assert.match(source, /additionalProperties: false/);
  assert.doesNotMatch(source, /github\.io|https:/);
});
