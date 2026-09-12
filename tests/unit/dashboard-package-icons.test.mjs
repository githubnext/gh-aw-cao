import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);

test("configured package icons are used by package dashboard menu entries", async () => {
  const policy = JSON.parse(await readFile(new URL(".github/workflows/cao.json", root), "utf8"));
  const packages = policy["control-plane"].packages;

  for (const [packageName, packagePolicy] of Object.entries(packages)) {
    if (["activity", "dashboard"].includes(packageName)) continue;
    assert.equal(typeof packagePolicy.icon, "string", `${packageName} must configure an Octicon`);
    const packageDashboard = JSON.parse(
      await readFile(new URL(`${packageName}/dashboard.json`, root), "utf8"),
    );
    assert.equal(
      packageDashboard.dashboard.pages[0]?.icon,
      packagePolicy.icon,
      `${packageName} dashboard menu must use its configured Octicon`,
    );
  }
});
