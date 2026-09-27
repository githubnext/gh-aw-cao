import { execFileSync } from "node:child_process";
import path from "node:path";

type AgentMetadata = {
  type?: string;
  prominent?: boolean;
  dataUpdatedAt?: string;
  links?: Array<{ rel: string; href: string }>;
};

type ResourceEntry = {
  id: string;
  body?: string;
  filePath?: string;
  data: {
    title: string;
    description?: string;
    agent?: AgentMetadata;
  };
};

type ResourceContext = {
  site: URL;
  base: string;
  repository?: string;
  generator: string;
  generatorVersion: string;
  generatedAt: string;
  commit?: string;
  sourceCommittedAt?: string;
  knownIds: Set<string>;
};

function cleanBase(base: string): string {
  return `/${base.split("/").filter(Boolean).join("/")}/`;
}

function resourcePath(id: string): string {
  return id === "index" ? "index.json" : `${id}/index.json`;
}

function pagePath(id: string): string {
  return id === "index" ? "" : `${id}/`;
}

function sourcePath(entry: ResourceEntry): string | undefined {
  if (!entry.filePath) return undefined;
  return path.relative(process.cwd(), entry.filePath).replaceAll("\\", "/");
}

function relatedId(entryId: string, href: string, knownIds: Set<string>): string | undefined {
  if (/^(?:[a-z]+:|#)/i.test(href)) return undefined;
  const withoutFragment = href.split(/[?#]/, 1)[0];
  let candidate;
  if (withoutFragment.startsWith("/")) {
    candidate = withoutFragment.replace(/^\/gh-aw-cao\//, "").replace(/^\/+|\/+$/g, "");
  } else {
    const parent = entryId === "index" ? "" : path.posix.dirname(entryId);
    candidate = path.posix.normalize(path.posix.join(parent, withoutFragment))
      .replace(/\.md$/, "")
      .replace(/^\.\/|\/+$/g, "");
  }
  if (!candidate) candidate = "index";
  return knownIds.has(candidate) ? candidate : undefined;
}

function markdownRelationships(entry: ResourceEntry, context: ResourceContext) {
  const links = [];
  const seen = new Set<string>();
  for (const match of (entry.body ?? "").matchAll(/(?<!!)\[[^\]]+\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const id = relatedId(entry.id, match[1], context.knownIds);
    if (!id || id === entry.id || seen.has(id)) continue;
    seen.add(id);
    links.push({
      rel: "related",
      href: new URL(resourcePath(id), new URL(context.base, context.site)).href,
    });
    if (links.length === 12) break;
  }
  return links;
}

export function resolveBuildProvenance() {
  let commit = process.env.PUBLIC_PAGES_BUILD_COMMIT?.trim();
  if (!/^[0-9a-f]{40}$/i.test(commit ?? "")) {
    try {
      commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    } catch {
      commit = undefined;
    }
  }

  let sourceCommittedAt;
  if (commit) {
    try {
      sourceCommittedAt = new Date(execFileSync(
        "git",
        ["show", "-s", "--format=%cI", commit],
        { encoding: "utf8" },
      ).trim()).toISOString();
    } catch {
      sourceCommittedAt = undefined;
    }
  }
  return { commit, sourceCommittedAt };
}

export function createAgentResource(entry: ResourceEntry, context: ResourceContext) {
  const source = sourcePath(entry);
  const root = new URL(context.base, context.site);
  const links = [
    { rel: "canonical", href: new URL(pagePath(entry.id), root).href },
    ...markdownRelationships(entry, context),
    ...(entry.data.agent?.links ?? []).map((link) => ({
      rel: link.rel,
      href: new URL(link.href, root).href,
    })),
  ];
  const provenance: Record<string, string> = {
    repository: context.repository ?? "unknown",
    generator: context.generator,
    generatorVersion: context.generatorVersion,
  };
  if (context.commit) provenance.commit = context.commit;
  if (source) {
    provenance.source = context.repository
      ? `https://github.com/${context.repository}/blob/${context.commit ?? "main"}/${source}`
      : source;
  }

  const freshness: Record<string, string> = { generatedAt: context.generatedAt };
  if (context.sourceCommittedAt) freshness.sourceCommittedAt = context.sourceCommittedAt;
  if (entry.data.agent?.dataUpdatedAt) freshness.dataUpdatedAt = entry.data.agent.dataUpdatedAt;

  return {
    schemaVersion: "1",
    id: entry.id,
    type: entry.data.agent?.type ?? "documentation",
    title: entry.data.title,
    url: new URL(pagePath(entry.id), root).href,
    ...(entry.data.description ? { description: entry.data.description } : {}),
    links,
    provenance,
    freshness,
  };
}

export function normalizedBase(base: string): string {
  return cleanBase(base);
}
