import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync, copyFileSync, mkdtempSync, unlinkSync, rmdirSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { base, revision, cutoff, repository, slugs, hash, gitId, readPacket } from "./native-monitoring-accuracy.mjs";
import { readJsonArchive, writeJsonArchive } from "../.github/skills/add-operational-value/scripts/json-archive.mjs";
import { readOutputHistory } from "../.github/skills/add-operational-value/scripts/collect-output-history.mjs";

const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
const writeJson = (file, value) => writeJsonArchive(file, value);

export function preservePacket(name, bytes, metadata, directory = base) {
  mkdirSync(path.join(directory, "packets"), { recursive: true });
  const parts = [];
  for (let offset = 0, index = 0; offset < bytes.length || index === 0; offset += 170000, index++) {
    const raw = gzipSync(bytes.subarray(offset, offset + 170000), { level: 9 }), file = `${name}.${index}.gz`;
    writeFileSync(path.join(directory, "packets", file), raw);
    parts.push({ file, sha256: hash(raw), bytes: raw.length });
  }
  writeJson(path.join(directory, "packets", `${name}.json`), { ...metadata, bytes: bytes.length, sha256: hash(bytes), parts });
}

export function collectNativeMonitoring(cache, discussionsDirectory, discussionHelper) {
  if (existsSync(path.join(base, "contracts.json"))) throw new Error("Frozen contracts exist; no silent recapture");
  mkdirSync(base, { recursive: true });
  const api = (name, endpoint, query) => {
    if (existsSync(path.join(base, "packets", `${name}.json`))) {
      const packet = readPacket(name);
      if (packet.endpoint !== endpoint || packet.query !== query) throw new Error("Acquisition endpoint/query changed");
      return JSON.parse(packet.body);
    }
    const bytes = execFileSync("gh", ["api", endpoint, ...(query ? ["-f", `query=${query}`] : [])],
      { maxBuffer: 32 * 1024 * 1024 });
    preservePacket(name, bytes, { endpoint, ...(query ? { query } : {}), observedAt: now(), kind: "original-public-api-response" });
    return JSON.parse(bytes);
  };
  const metadata = api("repository", `repos/${repository}`);
  if (metadata.id !== 1036865607 || metadata.full_name !== repository || metadata.private !== false
    || metadata.visibility !== "public") throw new Error("Public repository identity not verified");
  const git = (...args) => execFileSync("git", [`--git-dir=${cache}`, ...args],
    { env: { ...process.env, GIT_NO_LAZY_FETCH: "1" }, maxBuffer: 64 * 1024 * 1024 });
  const originals = new Map();
  const object = (oid, type) => {
    if (!/^[a-f0-9]{40}$/.test(oid)) throw new Error("Expected immutable Git object");
    if (originals.has(oid)) return originals.get(oid).bytes;
    const check = execFileSync("git", [`--git-dir=${cache}`, "cat-file", "--batch-check"],
      { input: `${oid}\n`, env: { ...process.env, GIT_NO_LAZY_FETCH: "1" } }).toString();
    let bytes;
    if (check.trim() === `${oid} missing` && type === "blob") {
      const response = api(`blob-${oid}`, `repos/${repository}/git/blobs/${oid}`);
      if (response.sha !== oid || response.encoding !== "base64") throw new Error("Invalid public blob original");
      bytes = Buffer.from(response.content, "base64");
    } else {
      bytes = git("cat-file", type, oid);
    }
    if (gitId(type, bytes) !== oid) throw new Error("Git original identity changed");
    originals.set(oid, { oid, type, bytes });
    return bytes;
  };
  const commit = head => {
    const raw = object(head, "commit").toString();
    return { tree: /^tree ([a-f0-9]{40})$/m.exec(raw)[1],
      parents: [...raw.split("\n\n")[0].matchAll(/^parent ([a-f0-9]{40})$/gm)].map(m => m[1]) };
  };
  const trees = oid => {
    const bytes = object(oid, "tree");
    for (let offset = 0; offset < bytes.length;) {
      const space = bytes.indexOf(32, offset), end = bytes.indexOf(0, space);
      const mode = bytes.subarray(offset, space).toString(), child = bytes.subarray(end + 1, end + 21).toString("hex");
      if (mode === "40000") trees(child);
      offset = end + 21;
    }
  };
  const resolve = (head, file, preserve = true) => {
    const entry = git("ls-tree", "-z", head, "--", file).toString();
    if (!entry) return null;
    const oid = /^\d+ blob ([a-f0-9]{40})\t/.exec(entry)?.[1];
    if (!oid) throw new Error("Expected exact regular source blob");
    return preserve ? object(oid, "blob").toString() : oid;
  };
  const sourceClosure = (head, slug) => {
    const seen = new Set(), records = [];
    const visit = (file, optional = false) => {
      if (seen.has(file)) return;
      seen.add(file);
      const text = resolve(head, file);
      if (text === null) {
        if (!optional) throw new Error(`Required source missing: ${head}:${file}`);
        records.push({ path: file, absent: true });
        return;
      }
      records.push({ path: file, oid: resolve(head, file, false), sha256: hash(text) });
      const frontmatter = text.startsWith("---\n") ? text.slice(4).split("\n---")[0] : "";
      const lines = frontmatter.split("\n"), start = lines.findIndex(line => /^imports:\s*$/.test(line));
      let end = start + 1;
      while (end < lines.length && !/^[a-zA-Z0-9_-]+:/.test(lines[end])) end++;
      const imports = start < 0 ? "" : lines.slice(start + 1, end).join("\n");
      for (const match of imports.matchAll(/^\s*-\s*(?:uses:\s*)?([./a-zA-Z0-9_-]+\.md)\s*$/gm)) {
        visit(path.posix.normalize(path.posix.join(".github/workflows", match[1])));
      }
      for (const match of text.matchAll(/\{\{#runtime-import(\??)\s+([./a-zA-Z0-9_-]+\.md)\}\}/g)) {
        visit(match[2], match[1] === "?");
      }
      const driver = /^\s+driver:\s+(\.github\/[^\s]+)/m.exec(text)?.[1];
      if (driver) visit(driver);
    };
    visit(`.github/workflows/${slug}.md`);
    visit(`.github/workflows/${slug}.lock.yml`);
    return records;
  };
  return import(pathToUrl(discussionHelper)).then(({ readDiscussionHistory }) => {
    const history = readDiscussionHistory(discussionsDirectory);
    if (!history.index.complete || history.index.repositoryId !== metadata.id || history.index.until !== cutoff) {
      throw new Error("Shared Discussion inventory scope mismatch");
    }
    const proposals = readJsonArchive("docs/operational-value/gh-aw-census/contracts.json.gz");
    const issueDirectory = "docs/operational-value/gh-aw-workflows/evidence";
    const issueHistory = readOutputHistory(issueDirectory);
    if (issueHistory.index.repositoryId !== metadata.id || issueHistory.index.until !== cutoff) {
      throw new Error("Shared issue/PR archive scope mismatch");
    }
    mkdirSync(path.join(base, "issue-history"), { recursive: true });
    for (const file of ["history.json.gz", ...issueHistory.index.partitions.map(part => part.file)]) {
      if (file !== path.basename(file)) throw new Error("Unsafe shared issue archive member");
      copyFileSync(path.join(issueDirectory, file), path.join(base, "issue-history", file));
    }
    const records = [];
    for (const slug of slugs) {
      const candidates = history.discussions.filter(row => row.body.includes(`gh-aw-workflow-id: ${slug} `)
        || row.body.includes(`gh-aw-tracker-id: ${slug} `));
      const candidate = candidates[0];
      if (!candidate) throw new Error(`No actual report discovered for ${slug}`);
      const attribution = /<!-- gh-aw-agentic-workflow:[^\n]+ -->/.exec(candidate.body)?.[0] ?? "";
      const runId = Number(/(?:, id: |actions\/runs\/)(\d+)/.exec(attribution)?.[1]);
      if (!Number.isSafeInteger(runId)) throw new Error("Missing unverified run discovery link");
      const run = api(`${slug}-run`, `repos/${repository}/actions/runs/${runId}`);
      if (run.id !== runId || run.repository.id !== metadata.id
        || run.path !== `.github/workflows/${slug}.lock.yml` || run.created_at >= cutoff) {
        throw new Error("Report discovery run does not bind the intended workflow");
      }
      const head = run.head_sha;
      trees(commit(head).tree);
      trees(commit(revision).tree);
      const closure = sourceClosure(head, slug), frozenClosure = sourceClosure(revision, slug);
      const additions = git("log", revision, "--format=%H", "--diff-filter=A", "--", `.github/workflows/${slug}.md`)
        .toString().trim().split("\n").filter(Boolean);
      const adoption = additions.at(-1), parent = commit(adoption).parents[0];
      if (!parent) throw new Error("Shallow boundary cannot establish adoption");
      trees(commit(adoption).tree);
      trees(commit(parent).tree);
      const names = git("diff-tree", "--no-commit-id", "--name-status", "-r", parent, adoption,
        "--", `.github/workflows/${slug}.md`).toString().trim();
      if (names !== `A\t.github/workflows/${slug}.md`) throw new Error("Not an actual source addition");
      resolve(adoption, `.github/workflows/${slug}.md`);
      const packet = readJsonArchive(path.join(discussionsDirectory, candidate.original),
        { maxDecodedBytes: 32 * 1024 * 1024, maxParts: 256 });
      preservePacket(`${slug}-discussion-page`, Buffer.from(packet.body),
        { kind: "original-shared-discussion-api-response", query: packet.query, observedAt: packet.observedAt,
          inheritedSha256: packet.sha256, original: candidate.original });
      const proposal = proposals.contracts.find(row => row.path === `.github/workflows/${slug}.md`);
      if (!proposal) throw new Error("Original census proposal missing");
      const record = { slug, candidate: { id: candidate.id, number: candidate.number,
        createdAt: candidate.createdAt, updatedAt: candidate.updatedAt }, runId, head, closure, frozenClosure,
        adoption, parent, proposal, discoveredCandidates: candidates.map(row => ({ id: row.id,
          number: row.number, createdAt: row.createdAt, updatedAt: row.updatedAt, bodySha256: hash(row.body) })),
        authoring: "Outcome-informed retrospective: source and candidate prose exposed before this explicit native-facet contract. Latest surviving marker-discovered report selected, not a representative or blind sample.",
        attribution: "Editable discovery footer corroborated with run identity/path/head; not an authoritative creation receipt." };
      if (slug === "daily-repo-chronicle") {
        const window = /Edition window \((\d{4}-\d\d-\d\d) (\d\d:\d\d) UTC to (\d{4}-\d\d-\d\d) (\d\d:\d\d) UTC\)/.exec(candidate.body);
        if (!window || run.head_branch !== metadata.default_branch) throw new Error("Unbound mainline edition window");
        record.nativeWindow = { start: `${window[1]}T${window[2]}:00Z`, end: `${window[3]}T${window[4]}:00Z` };
        let oid = head, bounded = false;
        for (let steps = 0; steps < 1000; steps++) {
          const bytes = object(oid, "commit").toString();
          const seconds = /^committer .* (\d+) [+-]\d{4}$/m.exec(bytes)?.[1];
          if (!seconds) throw new Error("Missing native committer time");
          if (Number(seconds) * 1000 < Date.parse(record.nativeWindow.start)) { bounded = true; break; }
          oid = commit(oid).parents[0];
          if (!oid) throw new Error("Mainline source history boundary");
        }
        if (!bounded) throw new Error("Native mainline acquisition budget exceeded");
      }
      if (slug === "weekly-issue-summary") {
        const window = /Window: \*\*(\d{4}-\d\d-\d\d) (\d\d:\d\d) UTC → (\d{4}-\d\d-\d\d) (\d\d:\d\d) UTC\*\*/.exec(candidate.body);
        if (!window) throw new Error("Missing exact weekly creation window");
        const start = `${window[1]}T${window[2]}:00Z`, end = `${window[3]}T${window[4]}:00Z`;
        const issues = issueHistory.entities.filter(row => row.kind === "Issue" && row.createdAt >= start && row.createdAt < end);
        if (issues.length > 2000) throw new Error("Transfer-history request budget exceeded");
        record.transferPackets = [];
        for (let offset = 0; offset < issues.length; offset += 100) {
          const ids = issues.slice(offset, offset + 100).map(row => row.id);
          const query = `query { nodes(ids:${JSON.stringify(ids)}) { ... on Issue { id number createdAt repository { databaseId } timelineItems(first:1,itemTypes:[TRANSFERRED_EVENT]) { totalCount pageInfo { hasNextPage } nodes { __typename } } } } }`;
          const name = `${slug}-transfer-${String(offset / 100 + 1).padStart(2, "0")}`;
          api(name, "graphql", query);
          record.transferPackets.push(name);
        }
      }
      if (slug === "github-mcp-tools-report") resolve(head, "pkg/workflow/data/github_toolsets_permissions.json");
      const artifactList = api(`${slug}-artifacts`, `repos/${repository}/actions/runs/${runId}/artifacts?per_page=100`);
      if (slug === "daily-issues-report") {
        if (runId !== 37637981390) throw new Error("Frozen cohort job identity does not apply to this run");
        api(`${slug}-agent-job`, `repos/${repository}/actions/jobs/112849617560`);
        const artifact = artifactList.artifacts.find(row => row.id === 11490843117 && row.name === "cache-memory");
        if (!artifact || artifact.expired) throw new Error("Required native cohort original unavailable");
        if (!existsSync(path.join(base, "packets", "daily-issues-cache.json"))) {
          const endpoint = `repos/${repository}/actions/artifacts/${artifact.id}/zip`;
          const zip = execFileSync("gh", ["api", endpoint], { maxBuffer: 16 * 1024 * 1024 });
          const temporary = mkdtempSync(path.join(tmpdir(), "native-monitoring-artifact-"));
          const filename = path.join(temporary, "original.zip");
          writeFileSync(filename, zip, { mode: 0o600 });
          try {
            const member = "issues-2026-10-07.json";
            const bytes = execFileSync("unzip", ["-p", filename, member], { maxBuffer: 32 * 1024 * 1024 });
            preservePacket("daily-issues-cache", bytes, { kind: "original-retained-artifact-member",
              endpoint, artifactId: artifact.id, runId, member, archiveSha256: hash(zip), observedAt: now(),
              limitation: "Exact retained artifact member; not signed pre-agent custody. Creation timestamps corroborated independently; other fields unverified. Archive .git/config is deliberately not retained or inspected." });
          } finally {
            unlinkSync(filename);
            rmdirSync(temporary);
          }
        }
      }
      record.artifacts = artifactList.artifacts.map(row => ({ id: row.id, name: row.name,
        expired: row.expired, size: row.size_in_bytes }));
      records.push(record);
    }
    mkdirSync(path.join(base, "originals"), { recursive: true });
    const manifest = { repository, repositoryId: metadata.id, revision, cutoff, objects: [] };
    for (const original of [...originals.values()].sort((a, b) => a.oid.localeCompare(b.oid))) {
      const parts = [];
      for (let offset = 0, index = 0; offset < original.bytes.length || index === 0; offset += 170000, index++) {
        const raw = gzipSync(original.bytes.subarray(offset, offset + 170000), { level: 9 });
        const file = `${original.oid}.${index}.gz`;
        writeFileSync(path.join(base, "originals", file), raw);
        parts.push({ file, bytes: raw.length, sha256: hash(raw) });
      }
      manifest.objects.push({ oid: original.oid, type: original.type, bytes: original.bytes.length,
        sha256: hash(original.bytes), parts });
    }
    writeJson(path.join(base, "originals.json"), manifest);
    writeJson(path.join(base, "discovery.json"), { schemaVersion: 1, records, discussionInventory: history.index });
    return { objects: manifest.objects.length, records: records.length };
  });
}

const pathToUrl = file => new URL(`file://${path.resolve(file)}`).href;
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 5) throw new Error("usage: collect-native-monitoring-accuracy.mjs BARE_CACHE DISCUSSIONS_DIRECTORY DISCUSSION_HELPER");
  console.log(JSON.stringify(await collectNativeMonitoring(...process.argv.slice(2))));
}
