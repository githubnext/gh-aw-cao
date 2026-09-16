import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import YAML from "yaml";

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
  for (const skillName of [
    "setup-cao",
    "add-cao-package",
    "create-cao-package",
    "analyze-cao",
    "cao-cli",
  ]) {
    const skill = await readFile(
      new URL(`skills/${skillName}/SKILL.md`, root),
      "utf8",
    );
    assert.match(skill, new RegExp(`^---\\nname: ${skillName}\\n`));
  }
});

test("add-cao-package requires discovery, consent, and review-safe installation", async () => {
  const skill = await readFile(
    new URL("skills/add-cao-package/SKILL.md", root),
    "utf8",
  );

  assert.match(skill, /same commit/);
  assert.match(skill, /Exclude packages with `private: true`/);
  assert.match(skill, /no more than three installable packages/);
  assert.match(skill, /explicit approval/);
  assert.match(skill, /cao\.mjs add githubnext\/gh-aw-cao\/<package-slug>@<catalog-commit>/);
  assert.match(skill, /must remain in review/);
  assert.match(skill, /did not broaden or change/);
});

test("experimental Codebase Model skill remains repository-local", async () => {
  const skill = await readFile(
    new URL(".github/skills/codebase-model/SKILL.md", root),
    "utf8",
  );

  assert.match(skill, /^---\r?\n/);
  assert.match(skill, /\bname:\s*codebase-model\b/);
  assert.match(skill, /ARCHITECTURE\.md/);
  await assert.rejects(
    readFile(new URL("skills/codebase-model/SKILL.md", root), "utf8"),
    { code: "ENOENT" },
  );
});

test("Codebase Model declares the supported schema version", async () => {
  const model = YAML.parse(await readFile(new URL("CODEBASE.yml", root), "utf8"));

  assert.equal(model.spec, "cbm/v0.1");
  for (const category of [
    "project",
    "structure",
    "architecture",
    "components",
    "dependencies",
    "boundaries",
    "invariants",
    "flows",
    "generation",
    "commands",
    "validation",
  ]) {
    assert.ok(model[category], `missing ${category}`);
  }
  for (const [name, references] of Object.entries(model.validation)) {
    if (!name.endsWith("_refs")) continue;
    for (const reference of references) {
      const command = reference
        .split(".")
        .reduce((value, key) => value?.[key], model);
      assert.ok(command, `unresolved command reference: ${reference}`);
    }
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
