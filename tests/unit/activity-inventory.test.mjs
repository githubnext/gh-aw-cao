import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { discoverInventory } from "../../activity/inventory.mjs";

test("projects installed package revisions and local compiler metadata", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "activity-inventory-"));
  const workflows = path.join(root, ".github", "workflows");
  const packages = path.join(root, ".github", "aw", "packages");
  const sourceRevision = "1".repeat(40);
  const packageRevision = "2".repeat(40);
  try {
    await mkdir(workflows, { recursive: true });
    await mkdir(packages, { recursive: true });
    await writeFile(path.join(workflows, "cao.json"), JSON.stringify({
      "control-plane": {
        packages: {
          dependabot: { enabled: true, mode: "review" },
        },
      },
    }));
    await writeFile(path.join(workflows, "dependabot.md"), `---
name: Dependabot
source: githubnext/gh-aw-cao@${sourceRevision}
---
`);
    await writeFile(
      path.join(workflows, "dependabot.lock.yml"),
      '# gh-aw-metadata: {"compiler_version":"0.89.15","strict":true}\n',
    );
    await writeFile(path.join(packages, "dependabot.json"), JSON.stringify({
      schemaVersion: 1,
      package: "githubnext/gh-aw-cao/dependabot",
      source: `githubnext/gh-aw-cao/dependabot@${packageRevision}`,
      resolvedCommit: packageRevision,
      installer: "gh-aw v0.89.15",
      files: [],
    }));

    const inventory = discoverInventory(root);

    assert.deepEqual(inventory.packages, [{
      id: "dependabot",
      name: "dependabot",
      package: "githubnext/gh-aw-cao/dependabot",
      source: `githubnext/gh-aw-cao/dependabot@${packageRevision}`,
      resolvedCommit: packageRevision,
      installer: "gh-aw v0.89.15",
    }]);
    assert.equal(inventory.workflows[0].source, `githubnext/gh-aw-cao@${sourceRevision}`);
    assert.equal(inventory.workflows[0].version, sourceRevision);
    assert.equal(inventory.workflows[0].ghAwVersion, "v0.89.15");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
