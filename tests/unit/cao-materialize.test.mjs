import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  materializeCaoFromSource,
  planCaoMaterialization,
  verifyCaoRuntime,
} from "../../.github/workflows/shared/materialize-cao.mjs";

const sourceRoot = path.resolve(import.meta.dirname, "..", "..");

test("CAO materialization preserves canonical source paths", () => {
  const destination = mkdtempSync(path.join(tmpdir(), "cao-materialize-layout-"));
  try {
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
    assert.ok(existsSync(path.join(destination, "dependabot", "cao.json")));
    assert.ok(existsSync(path.join(destination, ".github", "actions", "setup-cao-runtime", "action.yml")));
    assert.ok(existsSync(path.join(destination, ".github", "cao", "instructions.md")));
    assert.match(readFileSync(path.join(destination, "cao.sh"), "utf8"), /activity\/cao\.mjs/);
    assert.equal(existsSync(path.join(destination, ".github", "aw", "instructions.md")), false);
    assert.equal(existsSync(path.join(destination, ".github", "aw", "activity")), false);
    assert.equal(existsSync(path.join(destination, ".github", "aw", "dashboard")), false);
    assert.equal(existsSync(path.join(destination, ".github", "aw", "dependabot")), false);
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
          "cao.sh",
          ".github/actions/setup-cao-runtime",
          ".github/cao/instructions.md",
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
