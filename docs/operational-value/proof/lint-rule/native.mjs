import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import vm from "node:vm";
import { gunzipSync } from "node:zlib";
import { readOutputHistory } from "../../../../.github/skills/add-operational-value/scripts/collect-output-history.mjs";

export const directory = path.dirname(import.meta.filename);
export const cutoff = "2026-10-18T15:00:12Z";
export const revision = "c86377ec47b38f0b5af463277ee55d1d03d08da8";
export const repository = "github/gh-aw";
export const hash = bytes => createHash("sha256").update(bytes).digest("hex");
export const gitHash = (type, bytes) => createHash("sha1").update(`${type} ${bytes.length}\0`).update(bytes).digest("hex");
export const read = filename => JSON.parse(gunzipSync(readFileSync(path.join(directory, filename))));
export const contract = JSON.parse(readFileSync(path.join(directory, "contract.json")));

export function verifyInstrument() {
  const lock = JSON.parse(readFileSync(path.join(directory, "instrument-lock.json")));
  for (const row of lock.files) {
    if (!row.path.startsWith("docs/operational-value/proof/") || row.path.includes("..") ||
      hash(readFileSync(new URL(`../../../../${row.path}`, import.meta.url))) !== row.sha256) throw new Error("Frozen instrument dependency mismatch");
  }
  if (parserIdentity().sha256 !== lock.toolchain.bundledAcorn.sha256) throw new Error("Unvalidated bundled JavaScript parser identity");
  return { sha256: hash(readFileSync(path.join(directory, "instrument-lock.json"))), toolchain: lock.toolchain };
}

export function treeEntry(bytes, name) {
  let offset = 0;
  while (offset < bytes.length) {
    const space = bytes.indexOf(32, offset), nul = bytes.indexOf(0, space);
    if (space < offset || nul < space || nul + 21 > bytes.length) throw new Error("Malformed Git tree");
    const mode = bytes.subarray(offset, space).toString();
    const entry = bytes.subarray(space + 1, nul).toString();
    const id = bytes.subarray(nul + 1, nul + 21).toString("hex");
    offset = nul + 21;
    if (entry === name) return { mode, id };
  }
  return null;
}

export function validateCustody(custody = read("custody.json.gz"), load = filename => readFileSync(path.join(directory, filename))) {
  if (custody.repository !== repository || custody.repositoryId !== 1036865607 ||
    custody.revision !== revision || custody.cutoff !== cutoff ||
    custody.contractSha256 !== hash(readFileSync(path.join(directory, "contract.json")))) throw new Error("Custody scope mismatch");
  const objects = new Map();
  for (const part of custody.partitions) {
    if (part.file !== path.basename(part.file)) throw new Error("Invalid partition path");
    const compressed = load(part.file);
    if (compressed.length !== part.bytes || hash(compressed) !== part.sha256) throw new Error("Partition integrity mismatch");
    for (const row of JSON.parse(gunzipSync(compressed))) {
      const bytes = Buffer.from(row.base64, "base64");
      if (!["blob", "tree", "commit"].includes(row.type) || row.bytes !== bytes.length ||
        row.sha256 !== hash(bytes) || row.id !== gitHash(row.type, bytes) || objects.has(row.id)) throw new Error("Git object identity mismatch");
      objects.set(row.id, { ...row, content: bytes });
    }
  }
  for (const row of custody.paths) {
    const commit = objects.get(row.commit);
    if (commit?.type !== "commit") throw new Error("Missing path commit");
    let expected = commit.content.toString().match(/^tree ([a-f0-9]{40})$/m)?.[1];
    const components = row.path.split("/");
    let provedAbsent = false;
    for (let i = 0; i < row.chain.length; i++) {
      const tree = objects.get(row.chain[i]);
      if (row.chain[i] !== expected || tree?.type !== "tree") throw new Error("Merkle tree mismatch");
      const entry = treeEntry(tree.content, components[i]);
      if (!entry) { provedAbsent = true; break; }
      if (i < components.length - 1 && entry.mode !== "40000") throw new Error("Invalid intermediate tree mode");
      if (i === components.length - 1 && entry.mode !== "100644") throw new Error("Unsupported source mode");
      expected = entry.id;
    }
    if (row.status === "absent") {
      if (!provedAbsent) throw new Error("Unproved absence");
    } else if (provedAbsent || row.chain.length !== components.length || row.blob !== expected ||
      (row.status === "available" && objects.get(row.blob)?.type !== "blob")) throw new Error("Path identity mismatch");
  }
  return { custody, objects, text(commit, filename) {
    const entry = custody.paths.find(row => row.commit === commit && row.path === filename);
    if (entry?.status !== "available") return null;
    return new TextDecoder("utf-8", { fatal: true }).decode(objects.get(entry.blob).content);
  } };
}

export function coordinatedOriginals() {
  const index = read("coordinated/index.json.gz");
  if (index.repository !== repository || index.repositoryId !== 1036865607 ||
    index.archiveSha256 !== "9d672a2fea6b9dcd942d7b9b1ffba0b3f83cf479a52e15313ff962826018fc1a" ||
    index.originalManifestSha256 !== "3c94f57d77c57823fb7e5b7278914324d8bd74f854ec9cf1b041e35d17abc853") throw new Error("Coordinated input scope mismatch");
  const manifestBytes = Buffer.from(index.originalManifestBase64, "base64");
  if (hash(manifestBytes) !== index.originalManifestSha256) throw new Error("Original manifest integrity mismatch");
  const manifest = JSON.parse(manifestBytes);
  if (manifest.files.length !== index.files.length) throw new Error("Original file inventory mismatch");
  const files = new Map();
  for (const original of index.files) {
    const expected = manifest.files.find(row => row.path === original.path);
    if (!expected || expected.sha256 !== original.sha256 || expected.bytes !== original.bytes) throw new Error("Original inventory integrity mismatch");
    let offset = 0;
    const chunks = original.parts.map(part => {
      if (!/^coordinated\/original-\d+\.json\.gz$/.test(part.file)) throw new Error("Invalid original partition path");
      const compressed = readFileSync(path.join(directory, part.file));
      if (compressed.length !== part.bytes || hash(compressed) !== part.sha256) throw new Error("Original partition integrity mismatch");
      const row = JSON.parse(gunzipSync(compressed));
      if (row.offset !== offset || row.sourcePath !== original.path) throw new Error("Original partition order mismatch");
      const chunk = Buffer.from(row.base64, "base64");
      offset += chunk.length;
      return chunk;
    });
    const bytes = Buffer.concat(chunks);
    if (bytes.length !== original.bytes || hash(bytes) !== original.sha256 || files.has(original.path)) throw new Error("Original bytes integrity mismatch");
    files.set(original.path, bytes);
  }
  return { manifest, files };
}

export function selectedGraph(packet) {
  const originals = coordinatedOriginals();
  const entities = [], fileResponses = [];
  for (const [filename, bytes] of originals.files) {
    if (!filename.startsWith("lint-rule-originals-v1/") || filename.endsWith("/manifest.json")) continue;
    const data = JSON.parse(bytes);
    if (Array.isArray(data)) fileResponses.push({ filename, rows: data });
    else entities.push({ filename, data });
  }
  const links = [];
  for (const { filename, data: pr } of entities.filter(row => row.data.merge_commit_sha)) {
    if (pr.base?.repo?.id !== 1036865607 || pr.base.repo.private !== false || pr.base.repo.full_name !== repository ||
      !/^PR_/.test(pr.node_id) || pr.merged !== true || !iso(pr.merged_at) || pr.merged_at >= cutoff) throw new Error("Selected PR identity or cutoff mismatch");
    const body = pr.body ?? "";
    const references = [...body.matchAll(/(?:fix(?:es)?|close[sd]?|resolve[sd]?)\s+#(\d+)/gi)].map(match => Number(match[1]));
    const response = fileResponses.find(row => row.rows.some(file =>
      file.blob_url?.includes(`/blob/${pr.head.sha}/`)));
    if (!response || response.rows.length !== pr.changed_files) throw new Error("Selected PR files incomplete");
    const nativePaths = packet.custody.paths.filter(row => row.commit === pr.merge_commit_sha && row.status === "available");
    const files = response.rows.map(row => {
      const native = nativePaths.find(p => p.path === row.filename);
      return { path: row.filename, headBlob: row.sha, mergedBlob: native?.blob ?? null,
        agreesAtMerge: native ? native.blob === row.sha : null };
    });
    links.push({ number: pr.number, id: pr.node_id, sourceOriginal: filename, mergeCommit: pr.merge_commit_sha,
      mergedAt: pr.merged_at, headCommit: pr.head.sha, baseCommit: pr.base.sha,
      bodySha256: hash(body), references, files,
      interpretation: "Observed mutable PR metadata corroborated against immutable merge-source originals; no protected creation receipt or sole causal credit" });
  }
  return { links, issues: entities.filter(row => !row.data.merge_commit_sha).map(({ filename, data }) => ({
    number: data.number, id: data.node_id, bodySha256: hash(data.body ?? ""), sourceOriginal: filename,
    currentBodyIsUntrusted: true,
    interpretation: [59646, 60197].includes(data.number)
      ? "Original issue explicitly describes a latent gap and reports no affected live target; its example is not a real native defect outcome."
      : "Discovery and rationale, not accepted outcome",
  })) };
}

let discoveryMemo;
export function discovery() {
  if (discoveryMemo) return discoveryMemo;
  const history = readOutputHistory(path.join(directory, "history"));
  if (!history.index.complete || history.index.partitions.length !== 346 ||
    history.entities.length !== 58048 || history.index.repository !== repository) throw new Error("Discovery incomplete");
  const direct = {};
  for (const name of Object.keys(contract.workflows)) direct[name] = history.entities.filter(row =>
    row.workflowReference?.workflowId === name || row.unverifiedWorkflowId === name);
  discoveryMemo = { partitions: 346, entities: 58048, direct };
  return discoveryMemo;
}

let parser;
export function parserIdentity() {
  const source = process.binding("natives")["internal/deps/acorn/acorn/dist/acorn"];
  if (typeof source !== "string") throw new Error("This Node runtime does not expose its bundled Acorn; no parser fallback");
  return { node: process.version, sha256: hash(source) };
}
function parse(source) {
  if (!parser) {
    const source = process.binding("natives")["internal/deps/acorn/acorn/dist/acorn"];
    parserIdentity();
    const exports = {};
    vm.runInNewContext(source, { exports, module: { exports } }, { timeout: 1000, filename: "trusted-node-bundled-acorn.js" });
    parser = exports;
  }
  return parser.parse(source, { ecmaVersion: "latest", sourceType: "script", locations: true });
}
export function tokenize(source) {
  if (!parser) parse("");
  const stream = parser.tokenizer(source, { ecmaVersion: "latest" });
  const tokens = [];
  for (let token = stream.getToken(); token.type.label !== "eof"; token = stream.getToken()) {
    tokens.push({ kind: token.type.label, value: token.value });
  }
  return tokens;
}
function walk(node, visit, ancestors = []) {
  if (!node || typeof node !== "object" || !node.type) return;
  visit(node, ancestors);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) for (const child of value) walk(child, visit, [...ancestors, node]);
    else if (value?.type) walk(value, visit, [...ancestors, node]);
  }
}
function bindingNames(node) {
  if (!node) return [];
  if (node.type === "Identifier") return [node.name];
  if (node.type === "RestElement") return bindingNames(node.argument);
  if (node.type === "AssignmentPattern") return bindingNames(node.left);
  if (node.type === "ObjectPattern") return node.properties.flatMap(property =>
    bindingNames(property.type === "RestElement" ? property.argument : property.value));
  if (node.type === "ArrayPattern") return node.elements.flatMap(bindingNames);
  return [];
}
export function inspectMkdir(source) {
  if (typeof source !== "string") return { known: false, reason: "Missing original" };
  let root;
  try { root = parse(source); } catch (error) {
    if (!(error instanceof SyntaxError) && error.name !== "SyntaxError") throw error;
    return { known: false, reason: "JavaScript parse failure" };
  }
  const bindings = new Set(), ambiguous = new Set(), declarations = new Map();
  let shadowedRequire = false;
  walk(root, (node, ancestors) => {
    if (node.type === "VariableDeclarator" && node.id.type === "Identifier" &&
      node.init?.type === "CallExpression" && node.init.callee.name === "require" &&
      ["fs", "node:fs"].includes(node.init.arguments[0]?.value) && ancestors.length === 2 &&
      ancestors[0].type === "Program") bindings.add(node.id.name);
    const names = node.type === "VariableDeclarator" ? bindingNames(node.id) :
      /Function/.test(node.type) ? [...(node.id ? [node.id.name] : []), ...node.params.flatMap(bindingNames)] :
        node.type === "CatchClause" ? bindingNames(node.param) :
          node.type === "ClassDeclaration" ? [node.id.name] : [];
    for (const name of names) {
      if (name === "require") shadowedRequire = true;
      declarations.set(name, (declarations.get(name) ?? 0) + 1);
    }
  });
  if (shadowedRequire) return { known: false, reason: "Shadowed CommonJS require outside partial facet" };
  walk(root, node => {
    for (const binding of bindings) {
      if (declarations.get(binding) !== 1 ||
        (node.type === "AssignmentExpression" && bindingNames(node.left).includes(binding)) ||
        (node.type === "UpdateExpression" && node.argument.name === binding)) ambiguous.add(binding);
    }
  });
  const calls = [];
  walk(root, (node, ancestors) => {
    const callee = node.callee;
    if (node.type !== "CallExpression" || callee?.type !== "MemberExpression" ||
      callee.computed || callee.property.name !== "mkdirSync" || !bindings.has(callee.object.name)) return;
    if (ambiguous.has(callee.object.name)) return;
    let guarded = false;
    for (let i = ancestors.length - 1; i >= 0; i--) {
      const ancestor = ancestors[i];
      if (/Function/.test(ancestor.type)) break;
      if (ancestor.type === "TryStatement" && ancestor.handler &&
        node.start >= ancestor.block.start && node.end <= ancestor.block.end) { guarded = true; break; }
    }
    calls.push({ line: node.loc.start.line, guarded,
      expression: source.slice(node.start, node.end),
      arguments: node.arguments.map(arg => source.slice(arg.start, arg.end)) });
  });
  if (ambiguous.size) return { known: false, reason: "Ambiguous fs bindings outside partial facet", calls };
  return { known: true, calls, rawUnguarded: calls.filter(row => !row.guarded).length, opportunities: calls.length,
    suppression: "Raw structural count ignores eslint waivers; it is not a full factory diagnostic count" };
}

export function inspectGo(inputs) {
  const temporary = mkdtempSync(path.join(tmpdir(), "lint-rule-native-"));
  try {
    const binary = path.join(temporary, "oracle");
    execFileSync("go", ["build", "-o", binary, path.join(directory, "oracle.go")], {
      env: { ...process.env, GOPROXY: "off", GOSUMDB: "off", GOENV: "off", GOWORK: "off", GO111MODULE: "off", GOTOOLCHAIN: "local" },
      timeout: 120000, stdio: ["ignore", "pipe", "pipe"],
    });
    return JSON.parse(execFileSync(binary, [], { input: JSON.stringify(inputs), encoding: "utf8", timeout: 30000 }));
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

export function iso(value) {
  return typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString().replace(".000Z", "Z") === value;
}
export function commitInfo(packet, id) {
  const raw = packet.objects.get(id);
  if (raw?.type !== "commit") throw new Error("Missing original commit");
  const text = raw.content.toString();
  const parent = text.match(/^parent ([a-f0-9]{40})$/m)?.[1];
  const stamp = text.match(/^committer .* (\d+) [+-]\d{4}$/m)?.[1];
  if (!parent || !stamp) throw new Error("Invalid commit metadata");
  return { parent, at: new Date(Number(stamp) * 1000).toISOString().replace(".000Z", "Z") };
}
