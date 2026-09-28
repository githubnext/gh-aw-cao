import assert from "node:assert/strict";
import test from "node:test";

import { buildAgentSummary } from "../../activity/agent-summary.mjs";

test("agent summary deterministically exposes bounded common metrics and freshness", () => {
  const metadata = {
    availability: "available",
    completeness: "complete",
    freshness: "fresh",
    "as-of": "2026-09-27T00:00:00Z",
  };
  const sources = {
    campaigns: {
      metadata,
      rows: [
        { campaign: "zeta", "campaign-name": "Zeta", "campaign-enabled": false, "campaign-mode": "review" },
        { campaign: "alpha", "campaign-name": "Alpha", "campaign-enabled": false, "campaign-mode": "live" },
        { campaign: "beta", "campaign-name": "Beta", "campaign-enabled": true, "campaign-mode": "review" },
      ],
    },
    workflows: {
      metadata,
      rows: [
        { "workflow-active": "true" },
        { "workflow-active": "false" },
        { "workflow-active": "unknown" },
      ],
    },
    repositories: { metadata, rows: [{ repository: "one" }, { repository: "two" }] },
  };

  assert.deepEqual(buildAgentSummary(sources), {
    schemaVersion: 1,
    generatedAt: "2026-09-27T00:00:00Z",
    source: "inventory-sources.json",
    campaigns: {
      total: 3,
      enabled: 1,
      disabled: 2,
      disabledCampaigns: [
        { id: "alpha", name: "Alpha" },
        { id: "zeta", name: "Zeta" },
      ],
      modes: { review: 2, live: 1, unknown: 0 },
    },
    workflows: { total: 3, active: 1, disabled: 1, unknown: 1 },
    repositories: { total: 2 },
    freshness: {
      campaigns: { availability: "available", completeness: "complete", freshness: "fresh", asOf: "2026-09-27T00:00:00Z" },
      repositories: { availability: "available", completeness: "complete", freshness: "fresh", asOf: "2026-09-27T00:00:00Z" },
      workflows: { availability: "available", completeness: "complete", freshness: "fresh", asOf: "2026-09-27T00:00:00Z" },
    },
  });
});
