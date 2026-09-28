import type { APIRoute, GetStaticPaths } from "astro";
import { getCollection } from "astro:content";
import { starlightAgentConfig } from "virtual:starlight-agent/config";
import {
  createAgentResource,
  normalizedBase,
  resolveBuildProvenance,
} from "./resource";

export const prerender = true;

export const getStaticPaths: GetStaticPaths = async () => {
  const entries = await getCollection(
    "docs",
    (entry) => !entry.data.draft && !starlightAgentConfig.excludedIds.includes(entry.id),
  );
  return entries.map((entry) => ({
    params: { slug: entry.id === "index" ? undefined : entry.id },
    props: { id: entry.id },
  }));
};

export const GET: APIRoute = async ({ props, site }) => {
  if (!site) return new Response("Astro site URL is required", { status: 500 });
  const entries = await getCollection(
    "docs",
    (entry) => !entry.data.draft && !starlightAgentConfig.excludedIds.includes(entry.id),
  );
  const entry = entries.find((candidate) => candidate.id === props.id);
  if (!entry) return new Response("Resource not found", { status: 404 });
  const provenance = resolveBuildProvenance();
  const resource = createAgentResource(entry, {
    site,
    base: normalizedBase(import.meta.env.BASE_URL),
    ...starlightAgentConfig,
    ...provenance,
    generatedAt: starlightAgentConfig.generatedAt,
    knownIds: new Set(entries.map((candidate) => candidate.id)),
  });
  return new Response(`${JSON.stringify(resource, null, 2)}\n`, {
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
};
