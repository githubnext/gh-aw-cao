import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

function rows(source) {
  return Array.isArray(source?.rows) ? source.rows : [];
}

function count(values, expected) {
  return values.filter((value) => value === expected).length;
}

export function buildAgentSummary(sources) {
  const campaigns = rows(sources?.campaigns);
  const workflows = rows(sources?.workflows);
  const repositories = rows(sources?.repositories);
  const generatedAt = sources?.campaigns?.metadata?.["as-of"]
    ?? sources?.workflows?.metadata?.["as-of"]
    ?? sources?.repositories?.metadata?.["as-of"]
    ?? null;
  const campaignModes = campaigns.map((campaign) => campaign["campaign-mode"]);
  const workflowStates = workflows.map((workflow) => workflow["workflow-active"]);

  return {
    schemaVersion: 1,
    generatedAt,
    source: "inventory-sources.json",
    campaigns: {
      total: campaigns.length,
      enabled: count(campaigns.map((campaign) => campaign["campaign-enabled"]), true),
      disabled: count(campaigns.map((campaign) => campaign["campaign-enabled"]), false),
      disabledCampaigns: campaigns
        .filter((campaign) => campaign["campaign-enabled"] === false)
        .map((campaign) => ({
          id: campaign.campaign,
          name: campaign["campaign-name"] ?? campaign.campaign,
        }))
        .sort((left, right) => String(left.id).localeCompare(String(right.id))),
      modes: {
        review: count(campaignModes, "review"),
        live: count(campaignModes, "live"),
        unknown: count(campaignModes, "unknown"),
      },
    },
    workflows: {
      total: workflows.length,
      active: count(workflowStates, "true"),
      disabled: count(workflowStates, "false"),
      unknown: count(workflowStates, "unknown"),
    },
    repositories: { total: repositories.length },
    freshness: Object.fromEntries(
      ["campaigns", "repositories", "workflows"].map((name) => {
        const metadata = sources?.[name]?.metadata ?? {};
        return [name, {
          availability: metadata.availability ?? "unavailable",
          completeness: metadata.completeness ?? "unknown",
          freshness: metadata.freshness ?? "unknown",
          asOf: metadata["as-of"] ?? null,
        }];
      }),
    ),
  };
}

export async function writeAgentSummary(inputPath, outputPath) {
  const sources = JSON.parse(await readFile(inputPath, "utf8"));
  const summary = buildAgentSummary(sources);
  await writeFile(outputPath, `${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const [inputPath, outputPath] = process.argv.slice(2);
  if (!inputPath || !outputPath) {
    throw new Error("usage: node activity/agent-summary.mjs INVENTORY_SOURCES OUTPUT");
  }
  await writeAgentSummary(inputPath, outputPath);
}
