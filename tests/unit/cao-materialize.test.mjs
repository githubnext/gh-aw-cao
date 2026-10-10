import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { parse } from "yaml";
import {
  extractCaoArchive,
  materializeCaoFromSource,
  planCaoMaterialization,
  verifyCaoRuntime,
} from "../../.github/workflows/shared/materialize-cao.mjs";

const sourceRoot = path.resolve(import.meta.dirname, "..", "..");

function filesBelow(root, prefix = "") {
  return readdirSync(path.join(root, prefix)).flatMap((name) => {
    const relative = path.join(prefix, name);
    return statSync(path.join(root, relative)).isDirectory()
      ? filesBelow(root, relative)
      : [relative.split(path.sep).join("/")];
  });
}

function tarArchive(entries) {
  const blocks = [];
  for (const { name, content = "", directory = false } of entries) {
    const data = Buffer.from(content);
    const header = Buffer.alloc(512);
    header.write(name);
    header.write(data.length.toString(8).padStart(11, "0"), 124);
    header[156] = directory ? 53 : 48;
    blocks.push(header, data, Buffer.alloc((512 - data.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

test("Windows CAO extraction does not invoke tar and rejects unsafe archive paths", () => {
  const destination = mkdtempSync(path.join(tmpdir(), "cao-materialize-windows-"));
  const archive = path.join(destination, "cao.tar.gz");
  try {
    writeFileSync(archive, tarArchive([
      { name: "cao-root/", directory: true },
      { name: "cao-root/file.txt", content: "CAO" },
    ]));
    extractCaoArchive(archive, destination, true);
    assert.equal(readFileSync(path.join(destination, "cao-root", "file.txt"), "utf8"), "CAO");

    writeFileSync(archive, tarArchive([{ name: "../escape.txt", content: "unsafe" }]));
    assert.throws(() => extractCaoArchive(archive, destination, true), /unsafe entry path/);
  } finally {
    rmSync(destination, { force: true, recursive: true });
  }
});

test("CAO materialization preserves canonical source paths", async () => {
  const destination = mkdtempSync(path.join(tmpdir(), "cao-materialize-layout-"));
  try {
    const installedCaoSkills = ["setup-cao", "debug-cao"].map((skill) =>
      path.join(destination, ".github", "skills", skill, "SKILL.md")
    );
    const consumerSkill = path.join(destination, ".github", "skills", "consumer-skill", "SKILL.md");
    const consumerExtension = path.join(destination, "com.github.copilot", "extensions", "consumer-extension", "extension.mjs");
    const consumerSpecification = path.join(destination, "specs", "consumer.md");
    for (const installedCaoSkill of installedCaoSkills) {
      mkdirSync(path.dirname(installedCaoSkill), { recursive: true });
      writeFileSync(installedCaoSkill, "installed");
    }
    mkdirSync(path.dirname(consumerSkill), { recursive: true });
    writeFileSync(consumerSkill, "consumer-owned");
    for (const file of [consumerExtension, consumerSpecification]) {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, "consumer-owned");
    }

    materializeCaoFromSource("root", sourceRoot, destination);
    materializeCaoFromSource("dependabot", sourceRoot, destination);
    const staleRootFile = path.join(destination, "activity", "removed-runtime.mjs");
    const staleCampaignFile = path.join(destination, "dependabot", "removed-runtime.mjs");
    const staleExtensionFile = path.join(destination, "com.github.copilot", "extensions", "cao-dashboard", "removed-canvas.mjs");
    const intelligenceDeclaration = path.join(destination, ".github", "cao", "intelligence", "dependabot.json");
    writeFileSync(staleRootFile, "stale");
    mkdirSync(path.dirname(staleCampaignFile), { recursive: true });
    writeFileSync(staleCampaignFile, "stale");
    writeFileSync(staleExtensionFile, "stale");
    writeFileSync(intelligenceDeclaration, "stale");

    materializeCaoFromSource("root", sourceRoot, destination);
    materializeCaoFromSource("dependabot", sourceRoot, destination);

    verifyCaoRuntime("activity", destination);
    verifyCaoRuntime("dashboard", destination);
    assert.equal(existsSync(staleRootFile), false);
    assert.equal(existsSync(staleCampaignFile), false);
    assert.equal(existsSync(staleExtensionFile), false);
    assert.ok(existsSync(path.join(destination, "activity", "cao.mjs")));
    const cliModules = filesBelow(sourceRoot, "activity/cli");
    assert.deepEqual(filesBelow(destination, "activity/cli").sort(), cliModules.sort());
    for (const module of cliModules) {
      const installedPath = path.join(destination, module);
      const content = readFileSync(installedPath);
      assert.deepEqual(content, readFileSync(path.join(sourceRoot, module)));
      rmSync(installedPath);
      assert.throws(() => verifyCaoRuntime("activity", destination), {
        message: `CAO activity runtime is incomplete at its canonical source paths: ${module}`,
      });
      writeFileSync(installedPath, content);
    }
    assert.ok(existsSync(path.join(destination, "activity", "normalized-phase.mjs")));
    assert.ok(existsSync(path.join(destination, "dashboard", "site", "package.json")));
    assert.ok(existsSync(path.join(destination, "skills", "setup-cao", "SKILL.md")));
    assert.ok(existsSync(path.join(destination, "dependabot", "cao.json")));
    assert.equal(
      readFileSync(intelligenceDeclaration, "utf8"),
      readFileSync(path.join(sourceRoot, "dependabot", "intelligence.json"), "utf8"),
    );
    assert.ok(existsSync(path.join(destination, ".github", "actions", "setup-cao-runtime", "action.yml")));
    assert.ok(existsSync(path.join(destination, ".github", "actions", "setup-gh-aw", "action.yml")));
    assert.ok(existsSync(path.join(destination, ".github", "cao", "instructions.md")));
    assert.ok(existsSync(path.join(destination, ".github", "workflows", "shared", "activity-cache.md")));
    assert.ok(existsSync(path.join(destination, ".github", "workflows", "shared", "control.md")));
    assert.ok(existsSync(path.join(destination, ".github", "workflows", "shared", "review-bundle.md")));
    assert.match(readFileSync(path.join(destination, "cao.sh"), "utf8"), /activity\/cao\.mjs/);
    const trackedDashboardFiles = spawnSync(
      "git",
      ["-C", sourceRoot, "ls-files", "--", "dashboard"],
      { encoding: "utf8" },
    ).stdout.trim().split("\n");
    assert.deepEqual(
      filesBelow(destination, "dashboard").sort(),
      trackedDashboardFiles.sort(),
    );
    const extensionDirectory = "com.github.copilot/extensions/cao-dashboard";
    const trackedExtensionFiles = spawnSync(
      "git",
      ["-C", sourceRoot, "ls-files", "--", extensionDirectory],
      { encoding: "utf8" },
    ).stdout.trim().split("\n");
    assert.deepEqual(filesBelow(destination, extensionDirectory).sort(), trackedExtensionFiles.sort());
    for (const file of ["plugin.json", "specs/dashboard-data.md", ...trackedExtensionFiles]) {
      assert.deepEqual(
        readFileSync(path.join(destination, file)),
        readFileSync(path.join(sourceRoot, file)),
      );
    }
    const { bundledResources, resolveBundledResource } = await import(
      pathToFileURL(path.join(destination, extensionDirectory, "bundled-resources.mjs")).href
    );
    for (const [name, resource] of Object.entries(bundledResources)) {
      assert.equal(await resolveBundledResource(name), realpathSync(path.join(destination, resource)));
    }
    const { executeDashboardQueryRequest, readDashboardDataSpecification } = await import(
      pathToFileURL(path.join(destination, extensionDirectory, "dashboard-agent-tools.mjs")).href
    );
    assert.deepEqual(JSON.parse(await executeDashboardQueryRequest({
      queries: [{ name: "failed", from: "runs", filter: { predicates: [{ field: "conclusion", equals: "failure" }] } }],
      sources: { runs: [{ conclusion: "failure" }, { conclusion: "success" }] },
    })).failed.rows, [{ conclusion: "failure" }]);
    assert.equal(JSON.parse(await readDashboardDataSpecification({
      startLine: 1,
      endLine: 5,
    })).endLine, 5);
    assert.equal(existsSync(path.join(destination, ".github", "aw", "instructions.md")), false);
    assert.equal(existsSync(path.join(destination, ".github", "aw", "activity")), false);
    assert.equal(existsSync(path.join(destination, ".github", "aw", "dashboard")), false);
    assert.equal(existsSync(path.join(destination, ".github", "aw", "dependabot")), false);
    for (const installedCaoSkill of installedCaoSkills) {
      assert.equal(existsSync(installedCaoSkill), false);
    }
    assert.equal(readFileSync(consumerSkill, "utf8"), "consumer-owned");
    for (const file of [consumerExtension, consumerSpecification]) {
      assert.equal(readFileSync(file, "utf8"), "consumer-owned");
    }
  } finally {
    rmSync(destination, { force: true, recursive: true });
  }
});

test("CAO materialization validates the complete source bundle before replacing runtime files", () => {
  const source = mkdtempSync(path.join(tmpdir(), "cao-materialize-incomplete-"));
  const destination = mkdtempSync(path.join(tmpdir(), "cao-materialize-existing-"));
  const existingRuntime = path.join(destination, "activity", "existing-runtime.mjs");
  try {
    mkdirSync(path.dirname(existingRuntime), { recursive: true });
    writeFileSync(existingRuntime, "existing");

    assert.throws(
      () => materializeCaoFromSource("root", source, destination),
      /missing required resource: activity/,
    );
    assert.equal(readFileSync(existingRuntime, "utf8"), "existing");
  } finally {
    rmSync(source, { force: true, recursive: true });
    rmSync(destination, { force: true, recursive: true });
  }
});

for (const missingResource of [
  "plugin.json",
  "com.github.copilot/extensions/cao-dashboard",
  "specs/dashboard-data.md",
]) {
  test(`CAO materialization rejects a bundle missing ${missingResource} before replacement`, () => {
    const source = mkdtempSync(path.join(tmpdir(), "cao-materialize-incomplete-plugin-"));
    const destination = mkdtempSync(path.join(tmpdir(), "cao-materialize-existing-plugin-"));
    try {
      const [{ resources }] = planCaoMaterialization([{
        name: "githubnext/gh-aw-cao",
        record: { resolvedCommit: "1".repeat(40) },
      }], "root");
      for (const resource of resources) {
        if (resource === missingResource) continue;
        const target = path.join(source, resource);
        if (statSync(path.join(sourceRoot, resource)).isDirectory()) {
          mkdirSync(target, { recursive: true });
        } else {
          mkdirSync(path.dirname(target), { recursive: true });
          writeFileSync(target, "source");
        }
      }
      const existingRuntime = path.join(destination, "activity", "existing-runtime.mjs");
      const existingExtension = path.join(destination, "com.github.copilot", "extensions", "cao-dashboard", "extension.mjs");
      for (const file of [existingRuntime, existingExtension]) {
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, "existing");
      }
      assert.throws(
        () => materializeCaoFromSource("root", source, destination),
        { message: `CAO source revision is missing required resource: ${missingResource}` },
      );
      for (const file of [existingRuntime, existingExtension]) {
        assert.equal(readFileSync(file, "utf8"), "existing");
      }
    } finally {
      rmSync(source, { force: true, recursive: true });
      rmSync(destination, { force: true, recursive: true });
    }
  });
}

test("CAO materialization rejects paths outside a campaign slug", () => {
  assert.throws(
    () => materializeCaoFromSource("../outside", sourceRoot, sourceRoot),
    /Invalid CAO campaign name/,
  );
});

test("root materialization preserves exact focused package revisions", () => {
  const rootRevision = "1".repeat(40);
  const activityRevision = "2".repeat(40);
  const plans = planCaoMaterialization([
    {
      name: "githubnext/gh-aw-cao",
      record: { resolvedCommit: rootRevision },
    },
    {
      name: "githubnext/gh-aw-cao/activity",
      record: { resolvedCommit: activityRevision },
    },
  ], "root");

  assert.deepEqual(
    plans.map(({ campaign, revision, resources }) => ({ campaign, revision, resources })),
    [
      {
        campaign: "root",
        revision: rootRevision,
        resources: [
          "dashboard",
          "skills",
          "cao.sh",
          "plugin.json",
          "com.github.copilot/extensions/cao-dashboard",
          "specs/dashboard-data.md",
          ".github/actions/setup-cao-runtime",
          ".github/actions/setup-gh-aw",
          ".github/cao/instructions.md",
          ".github/workflows/shared/activity-cache.md",
          ".github/workflows/shared/control.md",
          ".github/workflows/shared/review-bundle.md",
        ],
      },
      {
        campaign: "activity",
        revision: activityRevision,
        resources: ["activity"],
      },
    ],
  );
});

test("root installation provides every local action used by its installed workflows", () => {
  const installed = new Set();
  const workflows = [];
  const visit = (manifestPath) => {
    const manifest = parse(readFileSync(path.join(sourceRoot, manifestPath), "utf8"));
    for (const { destination } of manifest.resources ?? []) installed.add(destination);
    for (const include of manifest.includes ?? []) {
      if (path.posix.basename(include) === "aw.yml") visit(include);
      else workflows.push(include);
    }
  };
  visit("aw.yml");
  const [{ resources }] = planCaoMaterialization([{
    name: "githubnext/gh-aw-cao",
    record: { resolvedCommit: "1".repeat(40) },
  }], "root");
  const provided = (file) =>
    installed.has(file) || resources.some((resource) => file === resource || file.startsWith(`${resource}/`));

  assert.ok(workflows.length > 0);
  for (const workflow of workflows) {
    const source = readFileSync(path.join(sourceRoot, workflow), "utf8");
    for (const [, action] of source.matchAll(/^\s*(?:-\s+)?uses:\s*\.\/([^\s#]+)/gm)) {
      const directory = action.replace(/\/+$/, "");
      assert.ok(
        provided(`${directory}/action.yml`) || provided(`${directory}/action.yaml`),
        `${workflow} uses ./${directory}, which root installation does not provide`,
      );
    }
  }
});

test("CAO materialization requires immutable resolved commit provenance", () => {
  assert.throws(
    () => planCaoMaterialization([{
      name: "githubnext/gh-aw-cao",
      record: { source: "githubnext/gh-aw-cao@v1.2.3" },
    }], "root"),
    /must contain a full resolvedCommit SHA/,
  );
});
