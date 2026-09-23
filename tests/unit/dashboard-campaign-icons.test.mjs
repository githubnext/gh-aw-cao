import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);

test("configured campaign icons are used by campaign dashboard menu entries when present", async () => {
  const policy = JSON.parse(await readFile(new URL(".github/workflows/cao.json", root), "utf8"));
  const campaigns = policy["control-plane"].campaigns;

  for (const [campaignName, campaignPolicy] of Object.entries(campaigns)) {
    if (["activity", "dashboard"].includes(campaignName)) continue;
    assert.equal(typeof campaignPolicy.icon, "string", `${campaignName} must configure an Octicon`);
    const dashboardUrl = new URL(`${campaignName}/dashboard.json`, root);
    const exists = await access(dashboardUrl).then(() => true, (error) => {
      if (error?.code === "ENOENT") return false;
      throw error;
    });
    if (!exists) continue;
    const campaignDashboard = JSON.parse(await readFile(dashboardUrl, "utf8"));
    assert.equal(
      campaignDashboard.dashboard.pages[0]?.icon,
      campaignPolicy.icon,
      `${campaignName} dashboard menu must use its configured Octicon`,
    );
  }
});
