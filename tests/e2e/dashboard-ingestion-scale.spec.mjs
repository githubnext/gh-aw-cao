import { expect, test } from "@playwright/test";
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { adaptCachedGhAwJsonl } from "../../dashboard/site/src/data/adapters/gh-aw-logs.js";
import { CANONICAL_SCHEMA_VERSION } from "../../dashboard/site/src/data/model/schema.js";
import { normalize } from "../../dashboard/site/src/data/normalize/index.js";
import { syntheticGhAwLogs } from "../helpers/synthetic-gh-aw-logs.mjs";

const siteRoot = resolve("dashboard/site");
const runs = Number(process.env.DASHBOARD_INGESTION_RUNS ?? 3000);
const batch = normalize(adaptCachedGhAwJsonl(syntheticGhAwLogs({ runs })).observations);
const records = ["campaigns", "repositories", "workflows", "runs"].flatMap((collection) =>
  batch[collection].map((record) => ({ kind: "record", collection, record }))
);
const payload = Buffer.from([
  {
    kind: "metadata",
    schemaVersion: CANONICAL_SCHEMA_VERSION,
    ingestionVersion: 3,
    sourceRecords: runs,
    phase: "runs",
    records: records.length,
  },
  ...records,
].map((line) => JSON.stringify(line)).join("\n") + "\n");
const shardName = `gh-aw-logs-runs/scale-${"a".repeat(64)}-${"b".repeat(16)}.jsonl`;

/** @type {import('node:http').Server} */
let server;
let origin = "";

test.beforeAll(async () => {
  server = createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    if (pathname === "/" || pathname === "/index.html") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<main>dashboard ingestion scale</main>");
      return;
    }
    if (pathname === "/payload-hashes.json") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ [shardName]: "c".repeat(64) }));
      return;
    }
    if (pathname === `/${shardName}`) {
      response.writeHead(200, {
        "content-type": "application/x-ndjson",
        "content-length": String(payload.byteLength),
      });
      response.end(payload);
      return;
    }
    const filePath = resolve(join(siteRoot, pathname));
    if (filePath.startsWith(`${siteRoot}${sep}`) && existsSync(filePath) && statSync(filePath).isFile()) {
      response.writeHead(200, {
        "content-type": extname(filePath) === ".json" ? "application/json" : "text/javascript",
      });
      createReadStream(filePath).pipe(response);
      return;
    }
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("Not found");
  });
  await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
  const address = server.address();
  origin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

test.afterAll(async () => {
  await new Promise((closed) => server.close(closed));
});

test("ingesting a large synthetic payload terminates and clears its notification", async ({ page }) => {
  await page.goto(`${origin}/`);
  const result = await page.evaluate(async () => {
    const { loadCanonicalDashboardSources } = await import(`${location.origin}/src/data-processor.js`);
    const messages = [];
    const observer = new MutationObserver(() => {
      const text = document.querySelector(".dashboard-notification")?.textContent ?? null;
      if (text && messages.at(-1) !== text) messages.push(text);
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    const started = performance.now();
    let failure = null;
    let sources = null;
    try {
      sources = await loadCanonicalDashboardSources(
        `${location.origin}/payload-hashes.json`,
        ["runs"],
        { githubUrlBase: "https://github.com", pages: [] },
      );
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    const elapsed = Math.round(performance.now() - started);
    // Allow the dismissal transition to remove the notification element.
    await new Promise((settled) => setTimeout(settled, 1000));
    observer.disconnect();
    return {
      elapsed,
      failure,
      rows: sources?.runs?.rows?.length ?? null,
      messages,
      remainingNotifications: document.querySelectorAll(".dashboard-notification").length,
    };
  });

  expect(result.failure, `ingestion failed after ${result.elapsed}ms`).toBeNull();
  expect(result.rows).toBe(runs);
  expect(result.messages.length).toBeGreaterThan(0);
  expect(result.remainingNotifications).toBe(0);
});
