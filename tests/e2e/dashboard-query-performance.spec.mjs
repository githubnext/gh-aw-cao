import { expect, test } from "@playwright/test";
import { createServer } from "node:http";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import {
  deployedActivityShardEntries,
  deployedDashboardUrl,
  legacyPhaseJsonToJsonl,
  shouldIgnoreRequestFailure,
} from "./dashboard-deployed-refresh-helpers.mjs";
import {
  QUERY_CHUNK_SIZE,
  deployedProxyTarget,
  queryPerformanceMarkdown,
} from "./dashboard-query-performance-helpers.mjs";
import { dashboardPageSourceNames } from "../../dashboard/site/src/dashboard-chunks.js";

const outputDirectory = resolve("test-results/dashboard-query-performance");
const siteRoot = resolve("dashboard/site");
const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".webmanifest", "application/manifest+json"],
]);
const dashboardDocument = JSON.parse(
  await readFile(resolve(siteRoot, "dashboard.json"), "utf8"),
).dashboard;
const dashboardContext = {
  pages: dashboardDocument.pages,
  queries: dashboardDocument.queries,
  views: dashboardDocument.views ?? [],
};
const overviewSourceNames = dashboardPageSourceNames(
  { dashboard: dashboardDocument },
  "overview",
);
const deployedShardSources = new Map();

async function serveDashboard(request, response) {
  const requestUrl = new URL(request.url || "/", "http://127.0.0.1");
  const pathname = decodeURIComponent(requestUrl.pathname === "/" ? "/index.html" : requestUrl.pathname);
  const localPath = resolve(siteRoot, `.${pathname}`);
  if (localPath !== siteRoot && !localPath.startsWith(`${siteRoot}${sep}`)) {
    response.writeHead(403).end();
    return;
  }
  try {
    if (!(await stat(localPath)).isFile()) throw new Error("Not a file");
    response.writeHead(200, {
      "cache-control": "no-store",
      "content-type": contentTypes.get(extname(localPath)) || "application/octet-stream",
    });
    response.end(await readFile(localPath));
    return;
  } catch (error) {
    if (error?.code !== "ENOENT" && error?.message !== "Not a file") throw error;
  }

  const deployedUrl = deployedProxyTarget(
    deployedShardSources.get(pathname) ?? pathname,
    deployedDashboardUrl,
  );
  if (!deployedUrl) {
    response.writeHead(403).end();
    return;
  }
  const deployedResponse = await fetch(deployedUrl, {
    method: request.method,
    redirect: "error",
  });
  let body = request.method === "HEAD"
    ? undefined
    : Buffer.from(await deployedResponse.arrayBuffer());
  if (pathname === "/payload-hashes.json" && body) {
    const entries = deployedActivityShardEntries(JSON.parse(body.toString("utf8")));
    deployedShardSources.clear();
    for (const { name, sourceName } of entries) deployedShardSources.set(`/${name}`, `/${sourceName}`);
    body = Buffer.from(JSON.stringify(Object.fromEntries(entries.map(({ name, hash }) => [name, hash]))));
  } else if (body && deployedShardSources.get(pathname)?.endsWith(".json")) {
    body = Buffer.from(legacyPhaseJsonToJsonl(body));
  }
  const contentLength = request.method === "HEAD"
    ? deployedResponse.headers.get("content-length")
    : String(body.length);
  response.writeHead(deployedResponse.status, {
    "cache-control": "no-store",
    "content-type": deployedResponse.headers.get("content-type") || "application/octet-stream",
    ...(contentLength ? { "content-length": contentLength } : {}),
  });
  response.end(body);
}

async function startDashboardServer() {
  const server = createServer((request, response) => {
    void serveDashboard(request, response).catch((error) => {
      response.writeHead(502).end(error instanceof Error ? error.message : String(error));
    });
  });
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Unable to resolve dashboard server port.");
  return {
    server,
    url: `http://127.0.0.1:${address.port}/`,
  };
}

test("benchmarks every dashboard query against settled deployed data", async ({ page }, testInfo) => {
  await mkdir(outputDirectory, { recursive: true });
  const proxy = await startDashboardServer();
  const dashboardUrl = process.env.DASHBOARD_QUERY_PERFORMANCE_URL || proxy.url;
  const browserErrors = [];
  const failedRequests = [];
  const succeededRequests = new WeakSet();
  let resolveOverviewWorkerMetrics;
  let rejectOverviewWorkerMetrics;
  const overviewWorkerMetrics = new Promise((resolvePromise, rejectPromise) => {
    resolveOverviewWorkerMetrics = resolvePromise;
    rejectOverviewWorkerMetrics = rejectPromise;
  });
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
    if (message.type() !== "debug") return;
    void Promise.all(message.args().map((argument) => argument.jsonValue()))
      .then(([prefix, label, detail]) => {
        if (prefix === "[cao:data:performance]"
            && label === "page query"
            && detail?.viewId === "overview-performance") {
          resolveOverviewWorkerMetrics(detail);
        }
      })
      .catch(rejectOverviewWorkerMetrics);
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("requestfailed", (request) => {
    const errorText = request.failure()?.errorText || "failed";
    if (shouldIgnoreRequestFailure({
      method: request.method(),
      url: request.url(),
      errorText,
      hadSuccessResponse: succeededRequests.has(request),
    })) return;
    failedRequests.push(`${request.method()} ${request.url()}: ${errorText}`);
  });
  page.on("response", (response) => {
    if (response.status() >= 400) {
      failedRequests.push(`${response.status()} ${response.url()}`);
      return;
    }
    succeededRequests.add(response.request());
  });
  await page.addInitScript(() => {
    window.__dashboardPerformanceEvents = [];
    document.addEventListener("dashboard-data", (event) => {
      window.__dashboardPerformanceEvents.push({
        at: performance.now(),
        detail: event.detail,
      });
    });
  });

  try {
    const benchmarkUrl = new URL(dashboardUrl);
    benchmarkUrl.searchParams.set("debug", "data:performance");
    benchmarkUrl.hash = "page-overview";
    await page.goto(benchmarkUrl.href, { waitUntil: "domcontentloaded" });
    await expect(page.locator(".dashboard-root")).toBeVisible({ timeout: 120_000 });
    await expect(page.locator(".dashboard-root")).not.toHaveAttribute("aria-busy", "true", {
      timeout: 120_000,
    });
    const initialOverviewReadyMs = await page.evaluate(() => performance.now());
    await page.waitForFunction(() => {
      const events = window.__dashboardPerformanceEvents ?? [];
      return events.some(({ detail }) => detail?.kind === "refresh" && detail?.status === "completed");
    }, null, { timeout: 300_000 });
    await expect(page.locator(".dashboard-root")).not.toHaveAttribute("aria-busy", "true", {
      timeout: 120_000,
    });
    await page.evaluate(() => new Promise((resolvePromise) => {
      requestAnimationFrame(() => requestAnimationFrame(resolvePromise));
    }));

    const populateMs = await page.evaluate(() => {
      const events = window.__dashboardPerformanceEvents ?? [];
      const started = events.find(({ detail }) =>
        detail?.kind === "refresh" && detail?.status === "started"
      );
      const completed = events.findLast(({ detail }) =>
        detail?.kind === "refresh" && detail?.status === "completed"
      );
      if (!started || !completed || completed.at < started.at) {
        throw new Error("Dashboard refresh timing events are incomplete.");
      }
      return completed.at - started.at;
    });

    const indexedDbCount = await page.evaluate(async () => {
      const { countCollections, ENTITY_STORES } = await import("./src/data/storage/indexeddb.js");
      const startedAt = performance.now();
      const counts = await countCollections(indexedDB, ENTITY_STORES);
      return {
        durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
        stores: ENTITY_STORES.length,
        records: Object.values(counts).reduce((total, count) => total + count, 0),
        counts,
      };
    });

    const results = await page.evaluate(async ({ context, chunkSize }) => {
      const { loadCanonicalDashboardPage } = await import("./src/data-processor.js");
      const rounded = (value) => Math.round(value * 100) / 100;
      const timings = [];
      for (const definition of context.queries) {
        const name = definition?.name;
        if (typeof name !== "string" || !name) continue;
        let chunkStartedAt = performance.now();
        let sources = await loadCanonicalDashboardPage(
          [name],
          context,
          { [name]: { limit: chunkSize } },
        );
        const firstChunkMs = performance.now() - chunkStartedAt;
        let source = sources[name];
        if (!source) throw new Error(`Query "${name}" did not return its named source.`);
        let continuationChunkMs = null;
        if (source.continuationToken) {
          chunkStartedAt = performance.now();
          sources = await loadCanonicalDashboardPage(
            [name],
            context,
            { [name]: { limit: chunkSize, continuationToken: source.continuationToken } },
          );
          continuationChunkMs = performance.now() - chunkStartedAt;
          source = sources[name];
          if (!source) throw new Error(`Query "${name}" continuation omitted its named source.`);
        }
        const fillStartedAt = performance.now();
        const filledSources = await loadCanonicalDashboardPage([name], context);
        const filled = filledSources[name];
        if (!filled) throw new Error(`Query "${name}" fill omitted its named source.`);
        timings.push({
          query: name,
          rows: filled.rows.length,
          chunks: Math.max(1, Math.ceil(filled.rows.length / chunkSize)),
          firstChunkMs: rounded(firstChunkMs),
          continuationChunkMs: continuationChunkMs === null ? null : rounded(continuationChunkMs),
          fillIterationMs: rounded(performance.now() - fillStartedAt),
        });
      }
      return timings;
    }, { context: dashboardContext, chunkSize: QUERY_CHUNK_SIZE });
    const overviewRequest = await page.evaluate(async ({ context, sourceNames }) => {
      const { loadCanonicalDashboardPage } = await import("./src/data-processor.js");
      const startedAt = performance.now();
      const sources = await loadCanonicalDashboardPage(
        sourceNames,
        context,
        undefined,
        { pageId: "overview", viewId: "overview-performance" },
      );
      return {
        requestMs: Math.round((performance.now() - startedAt) * 100) / 100,
        returnedRows: Object.fromEntries(
          Object.entries(sources).map(([name, source]) => [name, source.rows.length]),
        ),
      };
    }, { context: dashboardContext, sourceNames: overviewSourceNames });
    const worker = await Promise.race([
      overviewWorkerMetrics,
      new Promise((_, rejectPromise) => {
        setTimeout(() => rejectPromise(new Error("Overview worker metrics were not emitted.")), 5_000);
      }),
    ]);
    const slowestSources = results
      .filter(({ query }) => overviewSourceNames.includes(query))
      .sort((left, right) => right.firstChunkMs - left.firstChunkMs)
      .slice(0, 5);

    const report = {
      generatedAt: new Date().toISOString(),
      dashboardUrl: deployedDashboardUrl,
      methodology: "Fresh Chromium profile running the checkout's dashboard and query worker; proxy current deployed data; measure native IndexedDB count() across all canonical entity stores, initial Overview readiness, and the settled Overview request by worker phase; then measure a 25-row first chunk, one continuation chunk when present, and one unpaginated fill iteration.",
      chunkSize: QUERY_CHUNK_SIZE,
      populateMs: Math.round(populateMs * 100) / 100,
      indexedDbCount,
      overview: {
        initialReadyMs: Math.round(initialOverviewReadyMs * 100) / 100,
        requestMs: overviewRequest.requestMs,
        worker,
        returnedRows: overviewRequest.returnedRows,
        slowestSources,
      },
      queries: results,
    };
    const jsonPath = resolve(outputDirectory, "summary.json");
    const markdownPath = resolve(outputDirectory, "summary.md");
    await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
    const markdown = queryPerformanceMarkdown(report);
    await writeFile(markdownPath, markdown);
    console.log(markdown);
    await testInfo.attach("dashboard-query-performance-json", {
      path: jsonPath,
      contentType: "application/json",
    });
    await testInfo.attach("dashboard-query-performance-markdown", {
      path: markdownPath,
      contentType: "text/markdown",
    });

    expect(results.map(({ query }) => query)).toEqual(
      dashboardContext.queries.map(({ name }) => name),
    );
    expect(browserErrors).toEqual([]);
    expect(failedRequests).toEqual([]);
  } finally {
    await new Promise((resolvePromise, reject) => {
      proxy.server.close((error) => error ? reject(error) : resolvePromise());
    });
  }
});
