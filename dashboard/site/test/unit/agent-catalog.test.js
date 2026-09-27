import { describe, expect, it } from "vitest";

import {
  agentCatalog,
  describePage,
  describeQuery,
  listPages,
  listQueries,
  queriesForPage,
  queryExecutionRequirements,
  queryParameters,
} from "../../src/agent/catalog.js";
import {
  NamedQueryError,
  resolveNamedQueryParameters,
} from "../../src/agent/query-executor.js";

const document = {
  dashboard: {
    navigation: [{ pages: ["insights", "configuration"] }],
    queries: [
      {
        name: "usage-base",
        intent: "Reuse shared usage stages.",
        from: "runs",
      },
      {
        name: "usage-by-workflow",
        intent: "Show observed AI Credit usage by workflow.",
        description: "Usage grouped by workflow.",
        from: "usage-base",
      },
      {
        name: "configuration-policy",
        intent: "Show control-repository configuration.",
        from: "work-items",
      },
    ],
    views: [
      {
        id: "shared-usage",
        data: {
          source: "usage-by-workflow",
          arguments: [{ name: "repository", field: "repository" }],
        },
      },
    ],
    pages: [
      {
        id: "insights",
        title: "Insights",
        description: "Inspect usage.",
        views: ["shared-usage"],
      },
      {
        id: "configuration",
        title: "Configuration",
        views: [{ data: { source: "configuration-policy" } }],
      },
      {
        id: "hidden",
        title: "Hidden",
        views: [{ data: { source: "usage-by-workflow" } }],
      },
    ],
  },
};

describe("agent catalog", () => {
  it("discovers agent-facing pages deterministically", () => {
    const pages = listPages(document);
    expect(pages.map((page) => page.id)).toEqual(["insights", "configuration"]);
  });

  it("omits pages that are not reachable from navigation", () => {
    expect(listPages(document).some((page) => page.id === "hidden")).toBe(false);
  });

  it("relates pages to the queries they render", () => {
    expect(queriesForPage(document, "insights")).toEqual(["usage-by-workflow"]);
    expect(describePage(document, "insights")?.queries).toEqual([
      "usage-by-workflow",
    ]);
  });

  it("preserves query intent and description", () => {
    const query = describeQuery(document, "usage-by-workflow");
    expect(query?.intent).toBe("Show observed AI Credit usage by workflow.");
    expect(query?.description).toBe("Usage grouped by workflow.");
    expect(query?.["used-by-pages"]).toEqual(["insights"]);
  });

  it("derives query parameters from the views that bind them", () => {
    expect(queryParameters(document, "usage-by-workflow")).toEqual([
      { name: "repository", field: "repository" },
    ]);
    expect(queryParameters(document, "configuration-policy")).toEqual([]);
  });

  it("resolves transitive source requirements", () => {
    const execution = queryExecutionRequirements(document, "usage-by-workflow");
    expect(execution.local).toBe(true);
    expect(execution.backend).toBe("sqlite");
    expect(execution.requirements).toEqual(["runs"]);
  });

  it("classifies queries that cannot run against the local projection", () => {
    const execution = queryExecutionRequirements(
      document,
      "configuration-policy",
    );
    expect(execution.local).toBe(false);
    expect(execution.reason).toMatch(/work-items/);
  });

  it("reports unknown queries instead of guessing", () => {
    const execution = queryExecutionRequirements(document, "missing");
    expect(execution.local).toBe(false);
    expect(describeQuery(document, "missing")).toBe(null);
  });

  it("lists queries deterministically", () => {
    expect(listQueries(document).map((query) => query.id)).toEqual([
      "usage-base",
      "usage-by-workflow",
      "configuration-policy",
    ]);
  });

  it("exposes one catalog for every transport", () => {
    const catalog = agentCatalog(document);
    expect(Object.keys(catalog).sort()).toEqual([
      "dashboard",
      "pages",
      "queries",
    ]);
    expect(catalog.pages).toEqual(listPages(document));
    expect(catalog.queries).toEqual(listQueries(document));
  });
});

describe("named query parameters", () => {
  it("maps declared parameters onto their query fields", () => {
    expect(
      resolveNamedQueryParameters(document, "usage-by-workflow", {
        repository: "githubnext/gh-aw-cao",
      }),
    ).toEqual([
      {
        name: "repository",
        field: "repository",
        value: "githubnext/gh-aw-cao",
      },
    ]);
  });

  it("rejects undeclared parameters", () => {
    expect(() =>
      resolveNamedQueryParameters(document, "usage-by-workflow", {
        nope: "value",
      }),
    ).toThrow(NamedQueryError);
  });

  it("rejects oversized parameter values", () => {
    expect(() =>
      resolveNamedQueryParameters(document, "usage-by-workflow", {
        repository: "x".repeat(1024),
      }),
    ).toThrow(NamedQueryError);
  });

  it("rejects unknown query identifiers", () => {
    expect(() =>
      resolveNamedQueryParameters(document, "missing", { any: "value" }),
    ).toThrow(NamedQueryError);
  });
});
