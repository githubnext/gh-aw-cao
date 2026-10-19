import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { gunzipSync, gzipSync } from "node:zlib";
import { isIsoUtc, isRepository } from "../.github/skills/add-operational-value/scripts/common.mjs";
import { readJsonArchive, writeJsonArchive } from "../.github/skills/add-operational-value/scripts/json-archive.mjs";

const execute = promisify(execFile);
const hash = value => createHash("sha256").update(value).digest("hex");
const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
const limits = { maxDecodedBytes: 32 * 1024 * 1024, maxParts: 256 };
const indexName = "discussions.json.gz";
const indexRead = directory => JSON.parse(gunzipSync(readFileSync(path.join(directory, indexName))));
const indexWrite = (directory, value) => {
  const target = path.join(directory, indexName), temporary = `${target}.tmp`;
  writeFileSync(temporary, gzipSync(`${JSON.stringify(value)}\n`));
  renameSync(temporary, target);
};

function query(repository, after) {
  const [owner, name] = repository.split("/");
  return `query { repository(owner:${JSON.stringify(owner)},name:${JSON.stringify(name)}) {
    databaseId discussions(first:100,after:${JSON.stringify(after)},orderBy:{field:CREATED_AT,direction:DESC}) {
      nodes { id number url title body createdAt updatedAt }
      pageInfo { hasNextPage endCursor }
    }
  } }`;
}

function decodePage(packet, index, ids, numbers) {
  if (typeof packet.body !== "string" || hash(packet.body) !== packet.sha256 || !isIsoUtc(packet.observedAt)) {
    throw new Error("Discussion original response digest or acquisition time changed");
  }
  const document = JSON.parse(packet.body);
  if (document.errors?.length || document.data?.repository?.databaseId !== index.repositoryId) {
    throw new Error(`Invalid Discussion response: ${JSON.stringify(document.errors ?? "repository identity mismatch")}`);
  }
  const connection = document.data.repository.discussions;
  if (!Array.isArray(connection?.nodes) || connection.nodes.length > 100
    || typeof connection.pageInfo?.hasNextPage !== "boolean"
    || (connection.pageInfo.hasNextPage && (!connection.nodes.length
      || typeof connection.pageInfo.endCursor !== "string" || !connection.pageInfo.endCursor))) {
    throw new Error("Malformed Discussion cursor page");
  }
  for (const row of connection.nodes) {
    if (typeof row.id !== "string" || !row.id || !Number.isSafeInteger(row.number) || row.number < 1
      || row.url !== `https://github.com/${index.repository}/discussions/${row.number}`
      || typeof row.title !== "string" || typeof row.body !== "string"
      || !isIsoUtc(row.createdAt) || !isIsoUtc(row.updatedAt)
      || ids.has(row.id) || numbers.has(row.number)) {
      throw new Error("Malformed, repeated or out-of-scope Discussion identity");
    }
    ids.add(row.id);
    numbers.add(row.number);
  }
  return connection;
}

export function readDiscussionHistory(directory) {
  const index = indexRead(directory);
  if (index.schemaVersion !== 1 || index.kind !== "workflow-discussion-history"
    || !isRepository(index.repository) || !Number.isSafeInteger(index.repositoryId) || index.repositoryId < 1
    || !isIsoUtc(index.until) || !Array.isArray(index.pages) || typeof index.complete !== "boolean") {
    throw new Error("Invalid Discussion inventory index");
  }
  const receipt = readJsonArchive(path.join(directory, "repository.json.gz"), limits);
  if (typeof receipt.body !== "string" || hash(receipt.body) !== receipt.sha256 || !isIsoUtc(receipt.observedAt)) {
    throw new Error("Discussion repository response digest or acquisition time changed");
  }
  const repository = JSON.parse(receipt.body);
  if (repository.id !== index.repositoryId || repository.full_name !== index.repository) {
    throw new Error("Discussion repository receipt identity changed");
  }
  const ids = new Set(), numbers = new Set(), discussions = [];
  let cursor = null, complete = false, scanned = 0;
  for (const [position, page] of index.pages.entries()) {
    if (page.file !== `page-${String(position + 1).padStart(5, "0")}.json.gz` || complete) {
      throw new Error("Invalid Discussion page order");
    }
    const packet = readJsonArchive(path.join(directory, page.file), limits);
    if (packet.sha256 !== page.sha256 || packet.query !== query(index.repository, cursor)) {
      throw new Error("Discussion page query or digest changed");
    }
    const connection = decodePage(packet, index, ids, numbers);
    if (connection.pageInfo.hasNextPage && connection.pageInfo.endCursor === cursor) {
      throw new Error("Non-advancing Discussion cursor");
    }
    const retained = connection.nodes.filter(row => row.createdAt < index.until);
    if (page.count !== retained.length) throw new Error("Discussion retained count changed");
    discussions.push(...retained.map(row => ({ ...row, observedAt: packet.observedAt, original: page.file })));
    scanned += connection.nodes.length;
    cursor = connection.pageInfo.endCursor;
    complete = !connection.pageInfo.hasNextPage;
  }
  if (index.complete !== complete || index.after !== cursor || index.scanned !== scanned
    || index.retained !== discussions.length || index.excludedAfterCutoff !== scanned - discussions.length) {
    throw new Error("Discussion inventory totals or checkpoint changed");
  }
  return { index, discussions };
}

export async function collectDiscussionHistory(options, request, clock = now) {
  const { repository, until, outputDirectory, resume = false, requestBudget = 200 } = options;
  if (!isRepository(repository) || !isIsoUtc(until)
    || !Number.isSafeInteger(requestBudget) || requestBudget < 2 || requestBudget > 2000) {
    throw new Error("Invalid Discussion scope, cutoff or bounded request budget");
  }
  mkdirSync(outputDirectory, { recursive: true });
  const existing = existsSync(path.join(outputDirectory, indexName));
  if (existing && !resume) throw new Error("Discussion inventory exists; explicitly --resume or use a new directory");
  let index = existing ? readDiscussionHistory(outputDirectory).index : null;
  if (index && (index.repository !== repository || index.until !== until)) throw new Error("Discussion resume scope mismatch");
  const metadataBody = await request(`repos/${repository}`);
  const metadata = JSON.parse(metadataBody);
  if (metadata.full_name !== repository || !Number.isSafeInteger(metadata.id) || metadata.id < 1
    || index && metadata.id !== index.repositoryId) throw new Error("Discussion repository identity changed");
  if (!index) {
    const observedAt = clock();
    if (!isIsoUtc(observedAt)) throw new Error("Invalid Discussion acquisition clock");
    writeJsonArchive(path.join(outputDirectory, "repository.json.gz"),
      { body: metadataBody, sha256: hash(metadataBody), observedAt }, limits);
    index = { schemaVersion: 1, kind: "workflow-discussion-history", repository, repositoryId: metadata.id, until,
      after: null, complete: false, scanned: 0, retained: 0, excludedAfterCutoff: 0, pages: [],
      limitation: "Surviving Discussion bodies observed at acquisition, not historical originals, complete comments, accepted outcomes or authoritative workflow attribution." };
    indexWrite(outputDirectory, index);
  }
  if (index.complete) return index;
  const prior = readDiscussionHistory(outputDirectory);
  const ids = new Set(prior.discussions.map(row => row.id)), numbers = new Set(prior.discussions.map(row => row.number));
  // Excluded post-cutoff rows also participate in pagination identity checks.
  for (const page of index.pages) {
    const packet = readJsonArchive(path.join(outputDirectory, page.file), limits);
    for (const row of JSON.parse(packet.body).data.repository.discussions.nodes) {
      ids.add(row.id);
      numbers.add(row.number);
    }
  }
  for (let used = 1; used < requestBudget; used++) {
    const sourceQuery = query(repository, index.after);
    const body = await request("graphql", sourceQuery), observedAt = clock();
    const packet = { body, sha256: hash(body), observedAt, query: sourceQuery };
    const connection = decodePage(packet, index, ids, numbers);
    if (connection.pageInfo.hasNextPage && connection.pageInfo.endCursor === index.after) {
      throw new Error("Non-advancing Discussion cursor");
    }
    const retained = connection.nodes.filter(row => row.createdAt < until);
    const file = `page-${String(index.pages.length + 1).padStart(5, "0")}.json.gz`;
    writeJsonArchive(path.join(outputDirectory, file), packet, limits);
    index = { ...index, after: connection.pageInfo.endCursor, complete: !connection.pageInfo.hasNextPage,
      scanned: index.scanned + connection.nodes.length, retained: index.retained + retained.length,
      excludedAfterCutoff: index.excludedAfterCutoff + connection.nodes.length - retained.length,
      pages: [...index.pages, { file, sha256: packet.sha256, count: retained.length }] };
    indexWrite(outputDirectory, index);
    if (index.complete) return index;
  }
  throw new Error("Discussion request budget exhausted; preserved checkpoint can --resume");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2), options = {};
  while (args[0]?.startsWith("--")) {
    const key = args.shift();
    if (key === "--until") options.until = args.shift();
    else if (key === "--resume") options.resume = true;
    else if (key === "--request-budget") options.requestBudget = Number(args.shift());
    else throw new Error(`Unknown Discussion option: ${key}`);
  }
  if (args.length !== 2) throw new Error("usage: collect-workflow-discussions.mjs --until UTC [--resume] [--request-budget N] OWNER/REPO OUTPUT_DIRECTORY");
  [options.repository, options.outputDirectory] = args;
  const result = await collectDiscussionHistory(options, async (endpoint, sourceQuery) => {
    const { stdout } = await execute("gh", sourceQuery ? ["api", "graphql", "-f", `query=${sourceQuery}`] : ["api", endpoint],
      { encoding: "utf8", timeout: 60000, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, GH_PAGER: "cat" } });
    return stdout;
  });
  console.log(JSON.stringify({ complete: result.complete, pages: result.pages.length, retained: result.retained }));
}
