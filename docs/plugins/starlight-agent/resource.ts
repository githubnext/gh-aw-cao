import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

type AgentBinding =
  | { kind: "dashboard-catalog" }
  | { kind: "dashboard-page"; id: string }
  | { kind: "dashboard-query"; id: string };

type AgentMetadata = {
  type?: string;
  prominent?: boolean;
  dataUpdatedAt?: string;
  binding?: AgentBinding;
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

function relatedId(entryId: string, href: string, knownIds: Set<string>, base: string): string | undefined {
  if (/^(?:[a-z]+:|#)/i.test(href)) return undefined;
  const withoutFragment = href.split(/[?#]/, 1)[0];
  let candidate;
  if (withoutFragment.startsWith("/")) {
    const basePath = cleanBase(base);
    candidate = withoutFragment.startsWith(basePath)
      ? withoutFragment.slice(basePath.length)
      : withoutFragment.replace(/^\/+/, "");
    candidate = candidate.replace(/\/+$/g, "");
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
    const id = relatedId(entry.id, match[1], context.knownIds, context.base);
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

function sourceIntegrity(entry: ResourceEntry) {
  if (!entry.filePath) return undefined;
  try {
    return {
      algorithm: "sha256",
      sourceDigest: createHash("sha256").update(readFileSync(entry.filePath)).digest("hex"),
    };
  } catch {
    return undefined;
  }
}

function interfacesFor(binding?: AgentBinding) {
  if (!binding) return undefined;
  if (binding.kind === "dashboard-catalog") {
    return {
      cli: [
        {
          command: "cao",
          subcommand: "pages",
          arguments: { positional: [], options: { "--json": true } },
          purpose: "Discover agent-facing dashboard pages.",
          readOnly: true,
        },
        {
          command: "cao",
          subcommand: "queries",
          arguments: { positional: [], options: { "--json": true } },
          purpose: "Discover named dashboard queries.",
          readOnly: true,
        },
      ],
      mcp: [{
        transport: "cli",
        server: "cao",
        capability: "cao_catalog",
        purpose: "Discover dashboard pages and named queries.",
        readOnly: true,
      }],
    };
  }

  const resourceId = binding.id;
  if (binding.kind === "dashboard-query") {
    return {
      cli: [
        {
          command: "cao",
          subcommand: "query-info",
          arguments: { positional: [resourceId], options: { "--json": true } },
          resourceId,
          purpose: "Inspect this named dashboard query.",
          readOnly: true,
        },
        {
          command: "cao",
          subcommand: "query",
          arguments: { positional: [resourceId], options: {} },
          resourceId,
          purpose: "Execute this named dashboard query.",
          readOnly: true,
        },
      ],
      mcp: [{
        transport: "cli",
        server: "cao",
        capability: "cao_query",
        arguments: { id: resourceId },
        resourceId,
        purpose: "Execute this named dashboard query against a local snapshot.",
        readOnly: true,
      }],
    };
  }

  const capability = `cao_${resourceId.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "")}`;
  return {
    cli: [{
      command: "cao",
      subcommand: "pages",
      arguments: { positional: [resourceId], options: { "--json": true } },
      resourceId,
      purpose: "Inspect this dashboard page and its named queries.",
      readOnly: true,
    }],
    mcp: [
      {
        transport: "cli",
        server: "cao",
        capability: "cao_catalog",
        arguments: { kind: "pages", id: resourceId },
        resourceId,
        purpose: "Inspect this dashboard page through the local MCP server.",
        readOnly: true,
      },
      {
        transport: "web",
        server: "cao-dashboard",
        capability,
        arguments: {},
        resourceId,
        purpose: "Read this page through the hosted dashboard.",
        readOnly: true,
      },
    ],
  };
}

function recommendedInterface(binding?: AgentBinding) {
  if (binding?.kind === "dashboard-page") {
    return {
      default: "web-mcp",
      alternatives: ["cli", "cli-mcp"],
      reason: "Use WebMCP in a supported dashboard browser; use CLI or CLI MCP for a local snapshot.",
    };
  }
  if (binding) {
    return {
      default: "cli",
      alternatives: ["cli-mcp"],
      reason: "Use the CLI with shell access; use CLI MCP when only tool access is available.",
    };
  }
  return undefined;
}

export function resolveBuildProvenance(filePath?: string) {
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
      const relativeSource = filePath
        ? path.relative(process.cwd(), filePath).replaceAll("\\", "/")
        : undefined;
      sourceCommittedAt = new Date(execFileSync(
        "git",
        relativeSource
          ? ["log", "-1", "--format=%cI", commit, "--", relativeSource]
          : ["show", "-s", "--format=%cI", commit],
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
  const binding = entry.data.agent?.binding;
  const integrity = sourceIntegrity(entry);
  const interfaces = interfacesFor(binding);
  const recommendation = recommendedInterface(binding);
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
    ...(source ? {
      source: {
        repository: context.repository ?? "unknown",
        path: source,
        ...(context.repository ? {
          url: `https://github.com/${context.repository}/blob/${context.commit ?? "main"}/${source}`,
        } : {}),
      },
    } : {}),
    links,
    provenance,
    freshness,
    ...(integrity ? { integrity } : {}),
    ...(interfaces ? { interfaces } : {}),
    ...(recommendation ? { recommendedInterface: recommendation } : {}),
  };
}

export function createAgentResourceSummary(entry: ResourceEntry, context: Pick<ResourceContext, "site" | "base">) {
  const root = new URL(context.base, context.site);
  const binding = entry.data.agent?.binding;
  return {
    id: entry.id,
    type: entry.data.agent?.type ?? "documentation",
    url: new URL(pagePath(entry.id), root).href,
    agent: new URL(resourcePath(entry.id), root).href,
    ...(binding ? {
      interfaces: binding.kind === "dashboard-page"
        ? ["cli", "cli-mcp", "web-mcp"]
        : ["cli", "cli-mcp"],
    } : {}),
  };
}

export function normalizedBase(base: string): string {
  return cleanBase(base);
}
