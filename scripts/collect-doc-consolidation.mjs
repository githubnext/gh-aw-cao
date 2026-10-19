import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readOutputHistory } from "../.github/skills/add-operational-value/scripts/collect-output-history.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const directory = path.join(root, "docs/operational-value/proof/doc-consolidation");
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const gitHash = (type, bytes) => createHash("sha1").update(`${type} ${bytes.length}\0`).update(bytes).digest("hex");
const revision = "c86377ec47b38f0b5af463277ee55d1d03d08da8";
const workflows = {
  "unbloat-docs": { blob: "fd6994d6473be8d40b22805f406b20e0848da8ea", introduction: "7b6d7fcc16990a949f9e9da168ff1e9faeda8bfd" },
  "developer-docs-consolidator": { blob: "56150ba5b670e7b088c45e7106ebafbe3946d75a", introduction: "9dcc4553e5ffe49e1cdd4df108308a51936db82d" },
  "claude-code-user-docs-review": { blob: "040ec6b88ae91baa0af077daf9b23401f90be806", introduction: "e659513b214fcdb717abf778624037c221d2b724" },
};

export function acquire(cache, history, extraCases = [], providerDirectory) {
  const archive = { schemaVersion: 1, repository: "github/gh-aw", repositoryId: 1036865607,
    revision, cutoff: "2026-10-18T15:00:12Z", objects: {}, paths: [], gaps: [], workflows: {}, cases: extraCases };
  mkdirSync(path.join(directory, "originals"), { recursive: true });
  const providerObjects = new Map();
  archive.provider = [];
  function preserveProvider(name, bytes) {
    if (!/^[\w.-]+$/.test(name) || bytes.length > 262144) throw new Error("Unsafe provider original");
    const filename = `provider/${name}`;
    mkdirSync(path.join(directory, "provider"), { recursive: true });
    writeFileSync(path.join(directory, filename), bytes);
    archive.provider.push({ path: filename, bytes: bytes.length, sha256: sha256(bytes) });
  }
  if (providerDirectory) {
    const packets = [
      ["doc-cohort-source-v1", "f47db2c2e184ce06a6e28d3e9efa893c6bf90883527afd8a0d7a47784ce8f990"],
      ["doc-consolidation-originals-v1", "68bd63b1fad39ad24766d44f42bd501ba05189a5aa20c864bacc21f0bda7b7e7"],
      ["doc-cohort-native-blobs-v1", "b9686ae5129f1a9da55865838f6ceb4f7e355e3bd7c1b93cf44d0d830d8a3ec1"],
    ];
    for (const [packet, expected] of packets) {
      const base = path.join(providerDirectory, packet), bytes = readFileSync(path.join(base, "manifest.json"));
      if (sha256(bytes) !== expected) throw new Error("Provider envelope identity mismatch");
      preserveProvider(`${packet}.manifest.json`, bytes);
      const manifest = JSON.parse(bytes);
      if (manifest.repository !== archive.repository || manifest.repositoryId !== archive.repositoryId) throw new Error("Provider repository authority mismatch");
      for (const receipt of manifest.receipts ?? []) {
        if (!Object.hasOwn(workflows, receipt.workflow)) continue;
        if (receipt.status !== 200 || !/^[a-f0-9]{40}$/.test(receipt.sha)) throw new Error("Invalid source acquisition receipt");
        const responseBytes = readFileSync(path.join(base, receipt.response)), blobBytes = readFileSync(path.join(base, receipt.blob));
        if (responseBytes.length !== receipt.bodyBytes || sha256(responseBytes) !== receipt.bodySha256
          || blobBytes.length !== receipt.blobBytes || sha256(blobBytes) !== receipt.blobSha256
          || gitHash("blob", blobBytes) !== receipt.sha) throw new Error("Provider original digest mismatch");
        const response = JSON.parse(responseBytes);
        if (response.sha !== receipt.sha || response.encoding !== "base64" || response.size !== blobBytes.length
          || !Buffer.from(response.content, "base64").equals(blobBytes)) throw new Error("Provider original encoding mismatch");
        preserveProvider(receipt.response, responseBytes);
        preserveProvider(receipt.blob, blobBytes);
        providerObjects.set(receipt.sha, blobBytes);
      }
      for (const receipt of manifest.requests ?? []) {
        if (!Object.hasOwn(workflows, receipt.workflow)) continue;
        if (receipt.status !== 200 || !/^[a-f0-9]{64}\.json$/.test(receipt.file)) throw new Error("Invalid PR acquisition receipt");
        const bytes = readFileSync(path.join(base, receipt.file));
        if (bytes.length !== receipt.bytes || sha256(bytes) !== receipt.sha256) throw new Error("PR original digest mismatch");
        preserveProvider(receipt.file, bytes);
      }
    }
    const metadata = JSON.parse(readFileSync(path.join(providerDirectory, "doc-consolidation-originals-v1/manifest.json")));
    for (const number of [11890, 69809, 12233, 69710]) {
      const metaReceipt = metadata.requests.find(receipt => receipt.endpoint === `repos/github/gh-aw/pulls/${number}`);
      const filesReceipt = metadata.requests.find(receipt => receipt.endpoint === `repos/github/gh-aw/pulls/${number}/files?per_page=100`);
      const base = path.join(providerDirectory, "doc-consolidation-originals-v1");
      const pr = JSON.parse(readFileSync(path.join(base, metaReceipt.file)));
      const files = JSON.parse(readFileSync(path.join(base, filesReceipt.file)));
      if (pr.number !== number || pr.base.repo.id !== archive.repositoryId || pr.base.repo.private
        || !filesReceipt.paginationComplete || pr.changed_files !== files.length) throw new Error("Incomplete or out-of-scope changed-file population");
      archive.providerPullRequests ??= [];
      archive.providerPullRequests.push({ number, slug: metaReceipt.workflow, nodeId: pr.node_id,
        base: pr.base.sha, head: pr.head.sha, merge: pr.merge_commit_sha, mergedAt: pr.merged_at,
        createdAt: pr.created_at, state: pr.state, observedAt: metaReceipt.receivedAt,
        paths: files.map(file => file.filename), metadata: metaReceipt.file, changedFiles: filesReceipt.file });
      if (pr.merged_at && Date.parse(pr.merged_at) < Date.parse(archive.cutoff)) {
        extraCases.push({ id: `pr-${number}`, slug: metaReceipt.workflow, commit: pr.merge_commit_sha,
          paths: files.map(file => file.filename), selectionBasis: "Original frozen earliest/latest PR candidates",
          attribution: "editable-marker-only", providerPr: number });
      }
    }
  }
  const git = (...args) => execFileSync("git", [`--git-dir=${cache}`, ...args],
    { env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" }, maxBuffer: 64 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] });
  function object(oid) {
    if (!/^[a-f0-9]{40}$/.test(oid)) throw new Error("Invalid exact Git identity");
    if (archive.objects[oid]) return Buffer.concat(archive.objects[oid].parts.map(part => readFileSync(path.join(directory, part.path))));
    let bytes, type;
    try {
      if (providerObjects.has(oid)) { type = "blob"; bytes = providerObjects.get(oid); }
      else { type = git("cat-file", "-t", oid).toString().trim(); bytes = git("cat-file", type, oid); }
    }
    catch (error) {
      const reason = String(error.stderr ?? error.message).trim();
      if (!/could not get object info|Not a valid object name|bad file/.test(reason)) throw error;
      archive.gaps.push({ kind: "missing-git-object", oid, reason });
      return null;
    }
    if (!["commit", "tree", "blob"].includes(type) || gitHash(type, bytes) !== oid) throw new Error("Git object identity mismatch");
    const parts = [];
    for (let offset = 0; offset < bytes.length || offset === 0; offset += 131072) {
      const chunk = bytes.subarray(offset, offset + 131072);
      const name = `originals/${oid}-${String(parts.length).padStart(3, "0")}.bin`;
      writeFileSync(path.join(directory, name), chunk);
      parts.push({ path: name, bytes: chunk.length, sha256: sha256(chunk) });
    }
    archive.objects[oid] = { type, bytes: bytes.length, parts };
    return bytes;
  }
  function resolve(commit, filename) {
    const bytes = object(commit);
    if (!bytes) return { status: "missing", commit, path: filename };
    let oid = /^tree ([a-f0-9]{40})$/m.exec(bytes.toString())?.[1];
    const chain = [commit];
    const segments = filename.split("/");
    for (let i = 0; i < segments.length; i++) {
      const tree = object(oid);
      if (!tree) return { status: "missing", commit, path: filename, missingObject: oid };
      chain.push(oid);
      let offset = 0, found;
      while (offset < tree.length) {
        const space = tree.indexOf(32, offset), nul = tree.indexOf(0, space);
        if (space < offset || nul < space || nul + 21 > tree.length) throw new Error("Malformed Git tree");
        const mode = tree.subarray(offset, space).toString(), name = tree.subarray(space + 1, nul).toString();
        if (name === segments[i]) found = { mode, oid: tree.subarray(nul + 1, nul + 21).toString("hex") };
        offset = nul + 21;
      }
      if (!found) return { status: "absent", commit, path: filename, chain };
      if (i < segments.length - 1 && found.mode !== "40000") throw new Error("Non-directory Git path component");
      if (i === segments.length - 1 && !["100644", "100755"].includes(found.mode)) throw new Error("Non-regular source path");
      oid = found.oid;
    }
    if (!object(oid)) return { status: "missing", commit, path: filename, missingObject: oid };
    return { status: "present", commit, path: filename, chain, blob: oid };
  }
  const pending = Object.keys(workflows).map(slug => `.github/workflows/${slug}.md`), visited = new Set();
  while (pending.length) {
    const filename = pending.shift();
    if (visited.has(filename)) continue;
    visited.add(filename);
    const record = resolve(revision, filename);
    archive.paths.push(record);
    const slug = path.basename(filename, ".md");
    const known = workflows[slug];
    const bytes = record.status === "present" ? object(record.blob) : known ? object(known.blob) : null;
    if (known && record.status === "present" && record.blob !== known.blob) throw new Error("Frozen workflow path mismatch");
    if (bytes) {
      const frontmatter = bytes.toString().split(/^---\s*$/m)[1] ?? "";
      for (const match of frontmatter.matchAll(/^\s*-\s*(?:uses:\s*)?((?:shared\/|\.\/)[\w./-]+\.md)\s*$/gm)) {
        const imported = match[1].startsWith("./") ? path.posix.join(path.posix.dirname(filename), match[1])
          : `.github/workflows/${match[1]}`;
        if (imported.includes("..")) throw new Error("Unsafe import path");
        pending.push(imported);
      }
    }
  }
  for (const [slug, info] of Object.entries(workflows)) {
    const filename = `.github/workflows/${slug}.md`;
    const commit = object(info.introduction);
    const parent = commit && /^parent ([a-f0-9]{40})$/m.exec(commit.toString())?.[1];
    const introduction = resolve(info.introduction, filename);
    const predecessor = parent ? resolve(parent, filename) : { status: "missing", reason: "No verified first parent" };
    archive.paths.push(introduction, predecessor);
    archive.workflows[slug] = { ...info, introduction, predecessor, sourceEra: "Frozen-source fixed-reference assessment; not backdated acceptance" };
  }
  for (const item of extraCases) {
    const commit = object(item.commit);
    const parent = commit && /^parent ([a-f0-9]{40})$/m.exec(commit.toString())?.[1];
    item.parent = parent ?? null;
    item.files = item.paths.map(filename => ({ path: filename, before: parent ? resolve(parent, filename) : { status: "missing" },
      after: resolve(item.commit, filename) }));
    archive.paths.push(...item.files.flatMap(file => [file.before, file.after]));
    item.support = (item.supportPaths ?? []).map(filename => resolve(item.commit, filename));
    archive.paths.push(...item.support);
  }
  const production = readOutputHistory(history);
  if (production.index.repositoryId !== archive.repositoryId || production.index.sourceRevision !== revision
    || production.index.until !== archive.cutoff || production.index.partitions.length !== 346
    || production.entities.length !== 58048 || !production.index.complete) throw new Error("Unexpected discovery scope");
  mkdirSync(path.join(directory, "discovery"), { recursive: true });
  const files = ["history.json.gz", ...production.index.partitions.map(part => part.file)];
  archive.discovery = { complete: production.index.complete, totalEntities: production.entities.length,
    partitions: production.index.partitions.length, limitations: production.index.limitations, files: [] };
  for (const filename of files) {
    const bytes = readFileSync(path.join(history, filename));
    if (bytes.length > 262144) throw new Error("Discovery original exceeds file budget");
    copyFileSync(path.join(history, filename), path.join(directory, "discovery", filename));
    archive.discovery.files.push({ path: `discovery/${filename}`, bytes: bytes.length, sha256: sha256(bytes) });
  }
  archive.selections = Object.keys(workflows).map(slug => {
    const rows = production.entities.filter(entity => entity.kind === "PullRequest"
      && (entity.unverifiedWorkflowId === slug || entity.workflowReference?.workflowId === slug))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.number - b.number);
    return { slug, candidateCount: rows.length, selected: [rows[0], rows.at(-1)].filter(Boolean)
      .filter((row, i, selected) => !i || row.id !== selected[0].id) };
  });
  const serialized = `${JSON.stringify(archive, null, 2)}\n`;
  writeFileSync(path.join(directory, "custody.json"), serialized);
  console.log(JSON.stringify({ custodySha256: sha256(serialized), objects: Object.keys(archive.objects).length,
    missingObjects: archive.gaps.length, discoveryEntities: production.entities.length }));
  return archive;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cache, history, cases, provider] = process.argv.slice(2);
  if (!cache || !history) throw new Error("Usage: node scripts/collect-doc-consolidation.mjs BARE_CACHE DISCOVERY [CASES_JSON]");
  acquire(path.resolve(cache), path.resolve(history), cases && existsSync(cases) ? JSON.parse(readFileSync(cases)) : [], provider);
}
