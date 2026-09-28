import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
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
  for (const { name, content = "" } of entries) {
    const data = Buffer.from(content);
    const header = Buffer.alloc(512);
    header.write(name);
    header.write(data.length.toString(8).padStart(11, "0"), 124);
    header[156] = 48;
    blocks.push(header, data, Buffer.alloc((512 - data.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

test("Windows CAO extraction does not invoke tar and rejects unsafe archive paths", () => {
  const destination = mkdtempSync(path.join(tmpdir(), "cao-materialize-windows-"));
  const archive = path.join(destination, "cao.tar.gz");
  try {
    writeFileSync(archive, tarArchive([{ name: "cao-root/file.txt", content: "CAO" }]));
    extractCaoArchive(archive, destination, true);
    assert.equal(readFileSync(path.join(destination, "cao-root", "file.txt"), "utf8"), "CAO");

    writeFileSync(archive, tarArchive([{ name: "../escape.txt", content: "unsafe" }]));
    assert.throws(() => extractCaoArchive(archive, destination, true), /unsafe entry path/);
  } finally {
    rmSync(destination, { force: true, recursive: true });
  }
});

test("CAO materialization preserves canonical source paths", () => {
  const destination = mkdtempSync(path.join(tmpdir(), "cao-materialize-layout-"));
  try {
    const installedCaoSkills = ["setup-cao", "debug-cao"].map((skill) =>
      path.join(destination, ".github", "skills", skill, "SKILL.md")
    );
    const consumerSkill = path.join(destination, ".github", "skills", "consumer-skill", "SKILL.md");
    for (const installedCaoSkill of installedCaoSkills) {
      mkdirSync(path.dirname(installedCaoSkill), { recursive: true });
      writeFileSync(installedCaoSkill, "installed");
    }
    mkdirSync(path.dirname(consumerSkill), { recursive: true });
    writeFileSync(consumerSkill, "consumer-owned");

    materializeCaoFromSource("root", sourceRoot, destination);
    materializeCaoFromSource("dependabot", sourceRoot, destination);
    const staleRootFile = path.join(destination, "activity", "removed-runtime.mjs");
    const staleCampaignFile = path.join(destination, "dependabot", "removed-runtime.mjs");
    writeFileSync(staleRootFile, "stale");
    mkdirSync(path.dirname(staleCampaignFile), { recursive: true });
    writeFileSync(staleCampaignFile, "stale");

    materializeCaoFromSource("root", sourceRoot, destination);
    materializeCaoFromSource("dependabot", sourceRoot, destination);

    verifyCaoRuntime("activity", destination);
    verifyCaoRuntime("dashboard", destination);
    assert.equal(existsSync(staleRootFile), false);
    assert.equal(existsSync(staleCampaignFile), false);
    assert.ok(existsSync(path.join(destination, "activity", "cao.mjs")));
    assert.ok(existsSync(path.join(destination, "dashboard", "site", "package.json")));
    assert.ok(existsSync(path.join(destination, "skills", "setup-cao", "SKILL.md")));
    assert.ok(existsSync(path.join(destination, "dependabot", "cao.json")));
    assert.ok(existsSync(path.join(destination, ".github", "actions", "setup-cao-runtime", "action.yml")));
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
    assert.equal(existsSync(path.join(destination, ".github", "aw", "instructions.md")), false);
    assert.equal(existsSync(path.join(destination, ".github", "aw", "activity")), false);
    assert.equal(existsSync(path.join(destination, ".github", "aw", "dashboard")), false);
    assert.equal(existsSync(path.join(destination, ".github", "aw", "dependabot")), false);
    for (const installedCaoSkill of installedCaoSkills) {
      assert.equal(existsSync(installedCaoSkill), false);
    }
    assert.equal(readFileSync(consumerSkill, "utf8"), "consumer-owned");
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
          ".github/actions/setup-cao-runtime",
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

test("CAO materialization requires immutable resolved commit provenance", () => {
  assert.throws(
    () => planCaoMaterialization([{
      name: "githubnext/gh-aw-cao",
      record: { source: "githubnext/gh-aw-cao@v1.2.3" },
    }], "root"),
    /must contain a full resolvedCommit SHA/,
  );
});
