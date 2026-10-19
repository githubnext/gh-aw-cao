import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { retain, hash, gitHash } from "./collect-smoke-copilot-small.mjs";
import { readOutputHistory } from "../.github/skills/add-operational-value/scripts/collect-output-history.mjs";

export const workflows = ["claude", "gemini", "kiro", "opencode", "cursor", "crush"].map(name => `smoke-${name}`);
export const revision = "c86377ec47b38f0b5af463277ee55d1d03d08da8";
export const cutoff = "2026-10-18T15:00:12Z";
export const defaultProof = "docs/operational-value/proof/native-smoke-capabilities";
const save = (root, name, value) => {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  writeFileSync(path.join(root, name), name.endsWith(".gz") ? gzipSync(bytes) : bytes);
};

export function discovery(history) {
  const { index, entities } = readOutputHistory(history);
  if (!index.complete || index.repository !== "github/gh-aw" || index.repositoryId !== 1036865607
    || index.until !== cutoff || index.sourceRevision !== revision || index.partitions.length !== 346
    || entities.length !== 58048) throw new Error("Frozen discovery identity mismatch");
  return { index, cohorts: Object.fromEntries(workflows.map(workflow => {
    const direct = entities.filter(row => row.workflowReference?.workflowId === workflow || row.unverifiedWorkflowId === workflow);
    const runs = [...new Map(direct.filter(row => row.workflowReference?.runId).map(row =>
      [row.workflowReference.runId, { runId: row.workflowReference.runId, at: row.createdAt }])).values()]
      .sort((a, b) => a.at.localeCompare(b.at));
    return [workflow, { direct, runs, limitations: "Discovery candidates, not native outcomes; Discussions/comments not inventoried." }];
  })) };
}

export function captureSources(cache, root, heads) {
  const git = args => execFileSync("git", [`--git-dir=${cache}`, ...args], {
    env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" },
    maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
  });
  if (git(["remote", "get-url", "origin"]).toString().trim() !== "https://github.com/github/gh-aw.git") {
    throw new Error("Wrong public source repository");
  }
  const objects = new Map(), missing = [], profiles = [], adoptions = {};
  const object = (type, id) => {
    if (objects.has(id)) return;
    try {
      const bytes = git(["cat-file", type, id]);
      if (gitHash(type, bytes) !== id) throw new Error("Git object hash mismatch");
      objects.set(id, { type, id, original: retain(root, bytes) });
    } catch (error) {
      if (error.status !== 128) throw error;
      missing.push({ type, id });
    }
  };
  const source = (commit, file) => {
    object("commit", commit);
    if (!objects.has(commit)) return { status: "missing-commit" };
    const segments = file.split("/");
    for (let depth = 0; depth < segments.length; depth++) {
      const parent = depth ? segments.slice(0, depth).join("/") : "";
      const id = git(["rev-parse", `${commit}:${parent}`]).toString().trim();
      object("tree", id);
    }
    let id;
    try { id = git(["rev-parse", "--verify", `${commit}:${file}`]).toString().trim(); }
    catch (error) { if (error.status !== 128) throw error; return { status: "absent" }; }
    object("blob", id);
    return { status: objects.has(id) ? "retained" : "missing-blob", id };
  };
  for (const workflow of workflows) {
    const file = `.github/workflows/${workflow}.md`;
    const additions = git(["log", "--diff-filter=A", "--format=%H", revision, "--", file])
      .toString().trim().split("\n").filter(Boolean);
    const commit = additions.at(-1);
    if (!commit) throw new Error(`Missing actual adoption: ${workflow}`);
    const parent = git(["rev-parse", `${commit}^`]).toString().trim();
    const adopted = source(commit, file), baseline = source(parent, file);
    if (!["retained", "missing-blob"].includes(adopted.status) || baseline.status !== "absent") {
      throw new Error(`Unverified adoption boundary ${workflow}: ${JSON.stringify({ adopted, baseline })}`);
    }
    const iso = id => {
      const text = git(["cat-file", "commit", id]).toString();
      const seconds = text.match(/^committer .* (\d+) [+-]\d{4}$/m)?.[1];
      if (!seconds) throw new Error("Missing immutable commit date");
      return new Date(Number(seconds) * 1000).toISOString().replace(".000Z", "Z");
    };
    adoptions[workflow] = { commit, adoptedAt: iso(commit), baselineCommit: parent, baselineAt: iso(parent) };
    const paths = [file, file.replace(".md", ".lock.yml")];
    for (const head of [...new Set([revision, commit, parent, ...(heads[workflow] ?? [])])]) {
      const queue = [...paths], resolved = {};
      while (queue.length) {
        const item = queue.shift();
        if (Object.hasOwn(resolved, item)) continue;
        resolved[item] = source(head, item);
        if (item.endsWith(".md") && resolved[item].status === "retained") {
          const text = git(["cat-file", "blob", resolved[item].id]).toString();
          for (const match of text.matchAll(/^\s*-\s+(?:uses:\s*)?(shared\/[\w/.-]+\.md)\s*$/gm)) {
            queue.push(`.github/workflows/${match[1]}`);
          }
        }
      }
      profiles.push({ workflow, commit: head, paths: resolved });
    }
  }
  return { revision, adoptions, profiles, objects: [...objects.values()], missing };
}

export function provider(root) {
  const packetFile = path.join(root, "acquisition.json");
  const packet = existsSync(packetFile) ? JSON.parse(readFileSync(packetFile)) : { requests: [] };
  const request = (endpoint, workflow = null) => {
    const previous = packet.requests.find(row => row.endpoint === endpoint);
    if (previous) return previous;
    if (!/^repos\/github\/gh-aw(?:\/|$)/.test(endpoint)) throw new Error("Out-of-scope acquisition");
    const acquiredAt = new Date().toISOString();
    const bytes = execFileSync("gh", ["api", "--include", endpoint], {
      maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
    });
    const separator = bytes.indexOf("\r\n\r\n") >= 0 ? "\r\n\r\n" : "\n\n";
    const offset = bytes.indexOf(separator);
    if (offset < 0) throw new Error("Missing provider headers");
    const header = bytes.subarray(0, offset).toString(), body = bytes.subarray(offset + separator.length);
    const status = Number(header.match(/^HTTP\/[\d.]+ (\d+)/)?.[1]);
    if (status !== 200) throw new Error(`Unexpected acquisition status ${status}`);
    const receipt = { endpoint, workflow, status, acquiredAt, bodySha256: hash(body),
      original: retain(root, body), headers: header.split(/\r?\n/).filter(line =>
        /^(HTTP\/|date:|x-github-request-id:|content-type:)/i.test(line)) };
    packet.requests.push(receipt);
    save(root, "acquisition.json", packet);
    return receipt;
  };
  const json = receipt => JSON.parse(readFileSyncBody(root, receipt));
  const metadata = json(request("repos/github/gh-aw"));
  if (metadata.id !== 1036865607 || metadata.full_name !== "github/gh-aw" || metadata.private !== false) {
    throw new Error("Public authority not established");
  }
  return { request, json };
}

export function acquire(root, selected) {
  const { request, json } = provider(root);
  for (const [workflow, runs] of Object.entries(selected)) for (const id of runs) {
    const base = `repos/github/gh-aw/actions/runs/${id}`;
    const run = json(request(base, workflow));
    if (run.repository?.id !== 1036865607 || run.repository?.private !== false
      || run.path !== `.github/workflows/${workflow}.lock.yml` || run.created_at >= cutoff) throw new Error("Selected run identity mismatch");
    request(`${base}/attempts/${run.run_attempt}/jobs?per_page=100`, workflow);
    request(`${base}/attempts/${run.run_attempt}/logs`, workflow);
    const artifacts = json(request(`${base}/artifacts?per_page=100`, workflow));
    if (artifacts.total_count !== artifacts.artifacts.length) throw new Error("Artifact pagination gap");
    for (const artifact of artifacts.artifacts.filter(row => !row.expired
      && /^(agent|agent-stdio|agent-session|agent-artifacts|agent-logs)$/.test(row.name))) {
      request(`repos/github/gh-aw/actions/artifacts/${artifact.id}/zip`, workflow);
    }
  }
}

export function repairSources(root) {
  const { request, json } = provider(root);
  const sources = JSON.parse(readFileSync(path.join(root, "sources.json")));
  const objects = new Map(sources.objects.map(row => [row.id, row]));
  const blob = (id, bytes) => {
    if (gitHash("blob", bytes) !== id) throw new Error("Acquired blob Git identity mismatch");
    const row = { type: "blob", id, original: retain(root, bytes) };
    objects.set(id, row);
    return bytes.toString();
  };
  for (const row of [...new Map(sources.missing.map(row => [row.id, row])).values()]) {
    if (row.type !== "blob") continue;
    const data = json(request(`repos/github/gh-aw/git/blobs/${row.id}`));
    if (data.sha !== row.id || data.encoding !== "base64") throw new Error("Unexpected blob receipt");
    blob(row.id, Buffer.from(data.content, "base64"));
  }
  for (const profile of sources.profiles) {
    const queue = Object.keys(profile.paths);
    const visited = new Set();
    while (queue.length) {
      const file = queue.shift();
      if (visited.has(file)) continue;
      visited.add(file);
      const row = profile.paths[file];
      let text;
      if (!row || row.status === "missing-commit") {
        const endpoint = `repos/github/gh-aw/contents/${file}?ref=${profile.commit}`;
        const data = json(request(endpoint, profile.workflow));
        if (data.path !== file || data.type !== "file" || data.encoding !== "base64") throw new Error("Unexpected immutable content receipt");
        text = blob(data.sha, Buffer.from(data.content, "base64"));
        profile.paths[file] = { status: "retained", id: data.sha, resolutionEndpoint: endpoint };
      } else if (objects.has(row.id)) {
        text = readOriginalForAcquisition(root, objects.get(row.id).original).toString();
        row.status = "retained";
      }
      if (file.endsWith(".md") && text) for (const match of text.matchAll(/^\s*-\s+(?:uses:\s*)?(shared\/[\w/.-]+\.md)\s*$/gm)) {
        const imported = `.github/workflows/${match[1]}`;
        if (!profile.paths[imported]) queue.push(imported);
      }
    }
  }
  sources.objects = [...objects.values()];
  sources.missing = sources.missing.filter(row => !objects.has(row.id));
  save(root, "sources.json", sources);
}

function readFileSyncBody(root, receipt) {
  // The same custody reader is used for acquisition resumption and offline replay.
  return readOriginalForAcquisition(root, receipt.original);
}
import { readOriginal as readOriginalForAcquisition } from "./native-smoke-copilot-small.mjs";

function main() {
  const args = process.argv.slice(2), options = {};
  while (args.length) {
    const flag = args.shift();
    if (!["--root", "--history", "--git", "--acquire", "--repair"].includes(flag) || !args.length) throw new Error("Invalid collector arguments");
    options[flag] = args.shift();
  }
  const root = path.resolve(options["--root"] ?? defaultProof);
  if (!existsSync(path.join(root, "acceptance.json"))) throw new Error("Acceptance must be frozen first");
  mkdirSync(root, { recursive: true });
  if (options["--history"]) save(root, "discovery.json.gz", discovery(options["--history"]));
  if (options["--acquire"]) acquire(root, JSON.parse(readFileSync(options["--acquire"])));
  if (options["--git"]) {
    const packet = existsSync(path.join(root, "acquisition.json")) ? JSON.parse(readFileSync(path.join(root, "acquisition.json"))) : { requests: [] };
    const heads = Object.fromEntries(workflows.map(workflow => [workflow, packet.requests.filter(row =>
      row.workflow === workflow && /^repos\/github\/gh-aw\/actions\/runs\/\d+$/.test(row.endpoint))
      .map(row => JSON.parse(readFileSyncBody(root, row)).head_sha)]));
    save(root, "sources.json", captureSources(options["--git"], root, heads));
  }
  if (options["--repair"]) repairSources(root);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
