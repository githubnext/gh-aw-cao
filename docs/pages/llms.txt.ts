import type { APIRoute } from "astro";
import { getCollection } from "astro:content";
import { catalogEntries } from "../lib/catalog";

const documentationOrder = [
  "getting-started",
  "architecture",
  "configuration",
  "authentication",
  "rollout-and-routing",
  "execution-and-safety",
  "orchestrators-and-workers",
  "deployment-and-governance",
  "operations",
  "dashboard-language-specification",
] as const;

function link(title: string, url: URL, description: string): string {
  return `- [${title}](${url}): ${description}`;
}

export const GET: APIRoute = async ({ url }) => {
  const baseUrl = new URL(".", url);
  const docs = await getCollection("docs");
  const docsById = new Map(docs.map((entry) => [entry.id, entry]));
  const documentation = documentationOrder.map((id) => {
    const entry = docsById.get(id);
    if (!entry) throw new Error(`Missing documentation page for llms.txt: ${id}`);

    return link(
      entry.data.title,
      new URL(`${id}/`, baseUrl),
      entry.data.description ?? "",
    );
  });
  const campaigns = catalogEntries.map((entry) =>
    link(entry.name, new URL(`catalog/${entry.slug}/`, baseUrl), entry.description)
  );

  const body = [
    "# Central Agentic Ops",
    "",
    "> Enterprise control planes for GitHub Agentic Workflows.",
    "",
    "Central Agentic Ops provides an open-source operation catalog and a governed model for running trusted workflows across many repositories from one private control plane.",
    "",
    "## Documentation",
    "",
    ...documentation,
    "",
    "## Operation Campaigns",
    "",
    link(
      "Campaign catalog",
      new URL("catalog/", baseUrl),
      "Browse the operations available for installation into a control plane.",
    ),
    ...campaigns,
    "",
    "## Source",
    "",
    link(
      "GitHub repository",
      new URL("https://github.com/githubnext/gh-aw-cao"),
      "Read the source, campaign manifests, workflow definitions, and contribution history.",
    ),
    "",
  ].join("\n");

  return new Response(body, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
};