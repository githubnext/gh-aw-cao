import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { generateDashboardStressData } from "../helpers/dashboard-stress-data.mjs";

test("stress shards are deterministic and parametric", async () => {
  const root = await mkdtemp(join(tmpdir(), "cao-dashboard-stress-"));
  const first = join(root, "first");
  const second = join(root, "second");
  try {
    const options = {
      repositories: 4,
      runs: 8,
      derivedEventsPerRun: 7,
      shards: 3,
      workflows: 2,
    };
    const firstManifest = await generateDashboardStressData({ ...options, outputDirectory: first });
    const secondManifest = await generateDashboardStressData({ ...options, outputDirectory: second });
    assert.deepEqual(firstManifest, secondManifest);
    assert.deepEqual(firstManifest.expected, {
      repositories: 4,
      runs: 8,
      jobs: 8,
      sessions: 8,
      events: 56,
    });
    assert.equal(firstManifest.files.length, 3);
    for (const file of firstManifest.files) {
      assert.equal(
        await readFile(join(first, file.name), "utf8"),
        await readFile(join(second, file.name), "utf8"),
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
