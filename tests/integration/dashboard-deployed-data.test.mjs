import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import "fake-indexeddb/auto";
import { readRunTimeline } from "../../dashboard/report/aic-usage.mjs";
import { loadDashboardSources } from "../../dashboard/site/src/source-loader.js";
import { ingestDashboardSources } from "../../dashboard/site/src/data/ingest/coordinator.js";
import { runId, sourceId } from "../../dashboard/site/src/data/model/ids.js";
import {
  DATABASE_NAME,
  deleteCanonicalDatabase,
  readCollection,
} from "../../dashboard/site/src/data/storage/indexeddb.js";

const deployedSourcesUrl = process.env.DASHBOARD_DATA_URL
  || "https://githubnext.github.io/gh-aw-cao/cao/gh-aw-logs.jsonl";
const deployedLogsUrl = process.env.GH_AW_LOGS_URL
  || new URL("gh-aw-logs.jsonl", deployedSourcesUrl).href;

function sorted(values) {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function runAttempt(row) {
  const attempt = Number(row["run-attempt"] ?? row.attempt);
  return Number.isInteger(attempt) && attempt > 0 ? attempt : 1;
}

function assertPublishedEventsStored(sourceEvents, databaseEvents, label, predicate) {
  const published = sourceEvents.filter(predicate);
  if (published.length === 0) return;
  const storedById = new Map(databaseEvents.map((event) => [event.id, event]));
  for (const event of published) {
    const stored = storedById.get(String(event.event));
    assert.deepEqual(
      { id: stored?.id, source: stored?.source, type: stored?.type },
      { id: String(event.event), source: event["event-source"], type: event["event-type"] },
      `${label} event ${event.event} was not preserved`,
    );
  }
}

function collectFirewallArtifacts(cachedJson, outputDirectory, runUrl) {
  return new Promise((resolve, reject) => {
    const child = spawn("gh", [
      "aw", "logs",
      "--stdin",
      "--audit",
      "--artifacts", "firewall",
      "--cached-jsonl", cachedJson,
      "--output", outputDirectory,
      "--summary-file", "",
    ], {
      env: process.env,
      stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`gh aw logs exited with ${code}: ${stderr.trim()}`));
    });
    child.stdin.end(`${runUrl}\n`);
  });
}

test("deployed dashboard sources populate canonical workflows, runs, and events", async () => {
  await deleteCanonicalDatabase(indexedDB);
  try {
    const sources = await loadDashboardSources(
      (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(60_000) }),
      deployedSourcesUrl,
    );
    await ingestDashboardSources(indexedDB, sources);

    const expectedWorkflows = new Set(sources.workflows.rows.map((row) => sourceId(
      "workflow",
      "dashboard-sources",
      `${row.organization}/${row.repository}:${row.workflow}`.toLowerCase(),
    )));
    const expectedRuns = new Set(sources.runs.rows.map((row) => runId(
      row.run,
      runAttempt(row),
    )));
    const expectedEvents = new Set(sources.events.rows.map((row) => String(row.event)));
    console.error("Deployed source row counts:", Object.fromEntries(
      ["repositories", "workflows", "runs", "job-performance", "sessions", "events", "work-items", "security-findings"]
        .map((source) => [source, sources[source]?.rows?.length ?? 0]),
    ));
    const [repositories, workflows, runs, jobs, sessions, events] = await Promise.all([
      readCollection(indexedDB, "repositories"),
      readCollection(indexedDB, "workflows"),
      readCollection(indexedDB, "runs"),
      readCollection(indexedDB, "jobs"),
      readCollection(indexedDB, "sessions"),
      readCollection(indexedDB, "events"),
    ]);
    for (const [table, entries] of Object.entries({
      repositories,
      workflows,
      runs,
      jobs,
      sessions,
      events,
    })) {
      console.error(`Canonical ${table} rows: ${entries.length}`);
      assert.ok(entries.length > 0, `canonical ${table} table must contain an entry`);
    }

    assert.ok(expectedWorkflows.size > 0, "deployed data must contain workflows");
    assert.ok(expectedRuns.size > 0, "deployed data must contain runs");
    assert.ok(expectedEvents.size > 0, "deployed data must contain events");
    assert.deepEqual(sorted(workflows.map(({ id }) => id)), sorted(expectedWorkflows));
    assert.deepEqual(sorted(runs.map(({ id }) => id)), sorted(expectedRuns));
    assert.deepEqual(sorted(events.map(({ id }) => id)), sorted(expectedEvents));

    assertPublishedEventsStored(
      sources.events.rows,
      events,
      "firewall",
      (event) => event["event-source"] === "firewall" || /^net_/.test(String(event["event-type"])),
    );
    assertPublishedEventsStored(
      sources.events.rows,
      events,
      "tool",
      (event) => /tool/.test(String(event["event-type"])),
    );
    assertPublishedEventsStored(
      sources.events.rows,
      events,
      "GitHub API rate-limit",
      (event) => {
        const identity = [
          event["event-source"],
          event["event-type"],
          event["event-summary"],
        ].join(" ").toLowerCase();
        return /github[-_ ]?api/.test(identity) && /rate[-_ ]?limit/.test(identity);
      },
    );
  } finally {
    await deleteCanonicalDatabase(indexedDB);
  }
});

test("deployed gh-aw logs produce the published firewall events", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "deployed-firewall-"));
  try {
    const [sources, logsResponse] = await Promise.all([
      loadDashboardSources(
        (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(60_000) }),
        deployedSourcesUrl,
      ),
      fetch(deployedLogsUrl, { signal: AbortSignal.timeout(60_000) }),
    ]);
    assert.equal(logsResponse.ok, true, `failed to download ${deployedLogsUrl}: ${logsResponse.status}`);
    const logs = (await logsResponse.text()).split(/\r?\n/).filter(Boolean).map(JSON.parse);
    assert.ok(logs.length > 0, "deployed gh-aw logs must contain runs");

    const firewallEvents = sources.events.rows.filter(
      (event) => event["event-source"] === "firewall" || /^net_/.test(String(event["event-type"])),
    );
    assert.ok(firewallEvents.length > 0, "deployed events must contain firewall events");
    const run = logs.find((candidate) => firewallEvents.some(
      (event) => String(event.run) === String(candidate.database_id ?? candidate.run_id ?? candidate.id),
    ));
    assert.ok(run, "deployed gh-aw logs must contain a run with published firewall events");

    const runId = String(run.database_id ?? run.run_id ?? run.id);
    const published = firewallEvents.filter((event) => String(event.run) === runId);
    const repository = String(run.repository ?? run.repository_name ?? "");
    assert.match(repository, /^[^/]+\/[^/]+$/, `run ${runId} must identify its repository`);

    const cachedJson = path.join(root, "gh-aw-logs.jsonl");
    const outputDirectory = path.join(root, "logs");
    await writeFile(cachedJson, logs.map(JSON.stringify).join("\n") + "\n");
    await collectFirewallArtifacts(
      cachedJson,
      outputDirectory,
      `https://github.com/${repository}/actions/runs/${runId}`,
    );

    const collected = (await readRunTimeline(
      outputDirectory,
      runId,
      String(published[0].session),
    )).filter((event) => event.source === "firewall");
    assert.ok(collected.length > 0, `gh aw logs must collect firewall events for run ${runId}`);
    const collectedPayload = collected.map((event) => ({
      event: sourceId("event", "gh-aw-logs", event.sourceId),
      source: event.source,
      type: event.type,
      summary: event.summary,
      status: event.status,
      payloadRef: event.payloadRef,
      sourceSequence: event.sourceSequence,
    })).toSorted((left, right) => left.event.localeCompare(right.event));
    const publishedPayload = published.map((event) => ({
      event: String(event.event),
      source: event["event-source"],
      type: event["event-type"],
      summary: event["event-summary"],
      status: event["event-status"],
      payloadRef: event["payload-ref"],
      sourceSequence: event["source-sequence"],
    })).toSorted((left, right) => left.event.localeCompare(right.event));
    assert.deepEqual(collectedPayload, publishedPayload);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
