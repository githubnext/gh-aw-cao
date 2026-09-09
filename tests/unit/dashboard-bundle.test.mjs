import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { bundleDashboards } from "../../dashboard/report/bundle-dashboards.mjs";

function document(id, navigationLabel) {
  return {
    "language-version": "0.1.0",
    dashboard: {
      id,
      title: id,
      pages: [
        {
          id,
          kind: "custom",
          views: [
            {
              id: `${id}-view`,
              data: { source: "runs" },
              mark: "metric",
              encoding: { value: { field: "run", aggregate: "count" } },
            },
          ],
        },
      ],
      navigation: [{ label: navigationLabel, pages: [id] }],
    },
  };
}

test("bundles installed package dashboards into one deterministic document", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dashboard-bundle-"));
  const output = path.join(root, "dashboard.json");
  const additions = path.join(root, "dashboards");
  await mkdir(additions);
  await writeFile(output, `${JSON.stringify(document("overview", "Explore"))}\n`);
  await writeFile(path.join(additions, "zeta.json"), `${JSON.stringify(document("zeta", "Package operations"))}\n`);
  await writeFile(path.join(additions, "alpha.json"), `${JSON.stringify(document("alpha", "Package operations"))}\n`);

  try {
    await bundleDashboards(output, additions);
    const bundled = JSON.parse(await readFile(output, "utf8"));
    assert.deepEqual(
      bundled.dashboard.pages.map(({ id }) => id),
      ["overview", "alpha", "zeta"],
    );
    assert.deepEqual(bundled.dashboard.navigation, [
      { label: "Explore", pages: ["overview"] },
      { label: "Package operations", pages: ["alpha", "zeta"] },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
