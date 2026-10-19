import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readJsonArchive } from "../../../../.github/skills/add-operational-value/scripts/json-archive.mjs";

export const directory = fileURLToPath(new URL(".", import.meta.url));
export const contract = JSON.parse(readFileSync(new URL("contract.json", import.meta.url)));
export const hash = value => createHash("sha256").update(value).digest("hex");

export function rawCanaryScript(source) {
  if (typeof source !== "string") throw new Error("Missing raw-canary source");
  const lines = source.split("\n"), starts = lines.flatMap((line, index) =>
    line === "  raw_mcp_canary:" ? [index] : []);
  if (starts.length !== 1) throw new Error("Missing or ambiguous protected raw-canary job");
  const tail = lines.slice(starts[0] + 1);
  const boundary = tail.findIndex(line => /^\S|^  \S/.test(line));
  const job = boundary < 0 ? tail : tail.slice(0, boundary);
  if (job.filter(line => line.trim() === "- name: Verify raw GitHub remote MCP handshake").length !== 1) {
    throw new Error("Missing or ambiguous protected raw-canary step");
  }
  const runs = job.flatMap((line, index) => /^ +run: \|[-+]?$/.test(line) ? [index] : []);
  if (runs.length !== 1) throw new Error("Unsupported raw-canary script layout");
  const indent = job[runs[0]].match(/^ */)[0].length + 2, script = [];
  for (const line of job.slice(runs[0] + 1)) {
    if (line.trim() && !line.startsWith(" ".repeat(indent))) break;
    script.push(line.slice(indent));
  }
  return script.join("\n").trimEnd();
}

export function parseRawCanaryLog(text, step) {
  if (typeof text !== "string" || !Number.isFinite(Date.parse(step?.started_at))
    || !Number.isFinite(Date.parse(step?.completed_at))) throw new Error("Malformed protected raw-step inputs");
  const start = Date.parse(step.started_at), end = Date.parse(step.completed_at) + 1000;
  const lines = text.split("\n").flatMap(line => {
    if (line.includes("\x1b")) return [];
    const match = line.match(/^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d+Z) (.*)\r?$/);
    return match && Date.parse(match[1]) >= start && Date.parse(match[1]) < end ? [match[2]] : [];
  });
  const failure = lines.find(line => /^MCP (?:initialize|ping|tools\/list|list_issues) (?:failed with HTTP|returned (?:JSON-RPC|a tool) error)/.test(line));
  if (failure) return { status: "rejected", reason: failure };
  const patterns = [
    /^MCP initialize responded with HTTP 200\.$/,
    /^##\[notice\]initialize: protocol (\d{4}-\d\d-\d\d), server (.+)$/,
    /^server capabilities: (.+)$/,
    /^##\[notice\]notifications\/initialized: HTTP (?:200|202|204)$/,
    /^MCP ping responded with HTTP 200\.$/,
    /^##\[notice\]ping: succeeded$/,
    /^MCP tools\/list responded with HTTP 200\.$/,
    /^##\[notice\]tools\/list returned ([1-9]\d*) tools$/,
    /^tools: (.+)$/,
    /^##\[notice\]tools\/list: `list_issues` is available$/,
    /^MCP list_issues responded with HTTP 200\.$/,
    /^##\[notice\]list_issues: retrieved open issues from github\/gh-aw$/,
    /^Raw GitHub remote MCP handshake succeeded with ([1-9]\d*) tools available\.$/,
  ];
  const witnesses = [];
  let position = -1;
  for (const pattern of patterns) {
    const matches = lines.flatMap((line, index) => pattern.test(line) ? [{ index, match: line.match(pattern) }] : []);
    if (matches.length !== 1 || matches[0].index <= position) {
      return { status: "unknown", reason: "Missing, conflicting or out-of-order protected runtime witness" };
    }
    position = matches[0].index;
    witnesses.push(matches[0].match);
  }
  let server, capabilities;
  try {
    server = JSON.parse(witnesses[1][2]);
    capabilities = JSON.parse(witnesses[2][1]);
  } catch {
    return { status: "unknown", reason: "Malformed protected server metadata witness" };
  }
  const names = witnesses[8][1].split(", ");
  const tools = Number(witnesses[7][1]);
  if (!Number.isFinite(Date.parse(`${witnesses[1][1]}T00:00:00Z`))
    || server?.name !== "github-mcp-server" || typeof server.version !== "string" || !server.version
    || !capabilities?.tools || typeof capabilities.tools !== "object"
    || !Number.isSafeInteger(tools) || names.length !== tools || new Set(names).size !== tools
    || !names.includes("list_issues") || Number(witnesses[12][1]) !== tools) {
    return { status: "unknown", reason: "Protected server or tool-catalog witnesses do not agree" };
  }
  return { status: "accepted", protocol: witnesses[1][1], server: server.name,
    serverVersion: server.version, tools, issueContentVerified: null, credentialClassVerified: null };
}

let retained;
export function nativeCases() {
  if (retained) return retained;
  const archive = readJsonArchive(fileURLToPath(new URL("originals.json.gz", import.meta.url)),
    { maxDecodedBytes: 32 * 1024 * 1024, maxParts: 256 });
  if (archive.contractSha256 !== hash(readFileSync(new URL("contract.json", import.meta.url)))) {
    throw new Error("Raw-canary acquisition contract changed");
  }
  const receipts = new Map();
  for (const receipt of archive.receipts) {
    const bytes = Buffer.from(receipt.bodyBase64, "base64");
    if (bytes.length !== receipt.bytes || bytes.toString("base64") !== receipt.bodyBase64
      || hash(bytes) !== receipt.sha256 || receipts.has(receipt.endpoint)) throw new Error("Raw-canary original custody changed");
    receipts.set(receipt.endpoint, bytes);
  }
  const prefix = `repos/${contract.repository}`, sourcePath = `.github/workflows/${contract.workflow}.md`;
  const get = endpoint => {
    const bytes = receipts.get(endpoint);
    if (!bytes) throw new Error(`Required raw-canary original missing: ${endpoint}`);
    return bytes;
  };
  const json = endpoint => JSON.parse(get(endpoint));
  const repository = json(prefix);
  if (repository.id !== contract.repositoryId || repository.full_name !== contract.repository
    || repository.private !== false || repository.visibility !== "public") throw new Error("Public repository authority mismatch");
  const source = (revision, extension) => {
    const original = json(`${prefix}/contents/.github/workflows/${contract.workflow}.${extension}?ref=${revision}`);
    const bytes = Buffer.from(original.content, "base64");
    const id = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    if (original.encoding !== "base64" || original.size !== bytes.length || original.sha !== id
      || original.path !== `.github/workflows/${contract.workflow}.${extension}`) throw new Error("Executed workflow blob changed");
    return bytes.toString("utf8");
  };
  const frozenScript = rawCanaryScript(source(contract.revision, "md"));
  const introduction = json(`${prefix}/git/commits/b68086a128bfe94b7d17d08821167f4915f123c4`);
  if (introduction.parents.length !== 1) throw new Error("Source introduction parent changed");
  const before = json(`${prefix}/git/commits/${introduction.parents[0].sha}`);
  const trees = [introduction, before].map(commit => {
    const tree = json(`${prefix}/git/trees/${commit.tree.sha}?recursive=1`);
    if (tree.sha !== commit.tree.sha || tree.truncated !== false) throw new Error("Incomplete source introduction tree");
    return tree.tree.filter(row => row.path === sourcePath);
  });
  if (trees[0].length !== 1 || trees[0][0].type !== "blob" || trees[1].length) throw new Error("Source introduction not proved against its actual parent");
  const cases = contract.selection.runIds.map(id => {
    const run = json(`${prefix}/actions/runs/${id}/attempts/1`);
    if (run.id !== id || run.run_attempt !== 1 || run.repository?.id !== contract.repositoryId
      || run.path !== sourcePath.replace(/\.md$/, ".lock.yml") || run.created_at >= contract.cutoff
      || !/^[a-f0-9]{40}$/.test(run.head_sha)) throw new Error("Protected run identity changed");
    const jobs = json(`${prefix}/actions/runs/${id}/attempts/1/jobs?per_page=100`);
    if (jobs.total_count !== jobs.jobs?.length) throw new Error("Incomplete protected job page");
    const matches = jobs.jobs.filter(job => job.name === contract.selection.jobName);
    if (matches.length !== 1 || matches[0].run_id !== id || matches[0].run_attempt !== 1) throw new Error("Protected raw-job binding changed");
    const job = matches[0], steps = job.steps.filter(step => step.name === contract.selection.stepName);
    if (steps.length !== 1 || rawCanaryScript(source(run.head_sha, "md")) !== frozenScript
      || rawCanaryScript(source(run.head_sha, "lock.yml")) !== frozenScript) throw new Error("Executed raw-canary contract mismatch");
    const result = parseRawCanaryLog(get(`${prefix}/actions/jobs/${job.id}/logs`).toString("utf8"), steps[0]);
    if (result.status === "accepted" && (steps[0].conclusion !== "success" || job.conclusion !== "success")) {
      throw new Error("Protected native witnesses conflict with raw-job completion");
    }
    return { id: String(id), attempt: 1, jobId: job.id, at: job.completed_at, headSha: run.head_sha,
      sourceScriptSha256: hash(frozenScript), ...result };
  });
  retained = { adoption: { commit: introduction.sha, adoptedAt: introduction.committer.date,
    baselineCommit: null, baselineAt: null }, cases };
  return retained;
}
