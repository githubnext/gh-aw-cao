import type { APIRoute } from "astro";
import { getCollection } from "astro:content";
import { starlightAgentConfig } from "virtual:starlight-agent/config";
import { createAgentResourceSummary, normalizedBase } from "./resource";

export const prerender = true;

export const GET: APIRoute = async ({ site }) => {
  if (!site) return new Response("Astro site URL is required", { status: 500 });
  const entries = (await getCollection(
    "docs",
    (entry) => !entry.data.draft && !starlightAgentConfig.excludedIds.includes(entry.id),
  )).sort((left, right) => left.id.localeCompare(right.id));
  const context = { site, base: normalizedBase(import.meta.env.BASE_URL) };
  const body = {
    schemaVersion: "1",
    resources: entries.map((entry) => createAgentResourceSummary(entry, context)),
  };
  return new Response(`${JSON.stringify(body, null, 2)}\n`, {
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
};
