import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { readJsonArchive } from "../.github/skills/add-operational-value/scripts/json-archive.mjs";

export const base = fileURLToPath(new URL("../docs/operational-value/proof/native-monitoring-accuracy/", import.meta.url));
export const revision = "c86377ec47b38f0b5af463277ee55d1d03d08da8";
export const cutoff = "2026-10-18T15:00:12Z";
export const repository = "github/gh-aw";
export const slugs = ["daily-code-metrics", "daily-repo-chronicle", "repo-tree-map",
  "github-mcp-tools-report", "weekly-issue-summary", "daily-issues-report"];
export const hash = bytes => createHash("sha256").update(bytes).digest("hex");
export const gitId = (type, bytes) => createHash("sha1").update(`${type} ${bytes.length}\0`).update(bytes).digest("hex");
export const json = readJsonArchive;
export const iso = value => typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().replace(".000Z", "Z") === value;

export function readOriginals(directory = base) {
  const manifest = json(path.join(directory, "originals.json"));
  const objects = new Map();
  for (const entry of manifest.objects) {
    if (!/^[a-f0-9]{40}$/.test(entry.oid) || !["blob", "tree", "commit"].includes(entry.type)
      || objects.has(entry.oid)) throw new Error("Invalid original Git identity");
    const bytes = Buffer.concat(entry.parts.map(part => {
      if (!/^[a-f0-9]{40}\.\d+\.gz$/.test(part.file)) throw new Error("Unsafe Git original path");
      const raw = readFileSync(path.join(directory, "originals", part.file));
      if (raw.length !== part.bytes || hash(raw) !== part.sha256) throw new Error("Original part changed");
      return gunzipSync(raw);
    }));
    if (bytes.length !== entry.bytes || hash(bytes) !== entry.sha256 || gitId(entry.type, bytes) !== entry.oid) {
      throw new Error("Original Git object changed");
    }
    objects.set(entry.oid, { type: entry.type, bytes });
  }
  const object = (oid, type) => {
    const value = objects.get(oid);
    if (value?.type !== type) throw new Error(`Missing ${type} original ${oid}`);
    return value.bytes;
  };
  const tree = oid => {
    const bytes = object(oid, "tree"), result = [];
    for (let offset = 0; offset < bytes.length;) {
      const space = bytes.indexOf(32, offset), end = bytes.indexOf(0, space);
      if (space < 0 || end < 0 || end + 21 > bytes.length) throw new Error("Malformed Git tree");
      result.push({ mode: bytes.subarray(offset, space).toString(), name: bytes.subarray(space + 1, end).toString(),
        oid: bytes.subarray(end + 1, end + 21).toString("hex") });
      offset = end + 21;
    }
    return result;
  };
  const commit = oid => {
    const raw = object(oid, "commit").toString(), header = raw.split("\n\n")[0];
    const root = /^tree ([a-f0-9]{40})$/m.exec(header)?.[1];
    const seconds = /^committer .* (\d+) [+-]\d{4}$/m.exec(header)?.[1];
    if (!root || !seconds) throw new Error("Invalid Git commit");
    return { tree: root, parents: [...header.matchAll(/^parent ([a-f0-9]{40})$/gm)].map(m => m[1]),
      at: new Date(Number(seconds) * 1000).toISOString().replace(".000Z", "Z") };
  };
  const resolve = (head, file) => {
    if (typeof file !== "string" || file.startsWith("/") || file.split("/").some(x => !x || x === ".." || x === ".")) {
      throw new Error("Unsafe source path");
    }
    let oid = commit(head).tree;
    const parts = file.split("/");
    for (const [index, part] of parts.entries()) {
      const found = tree(oid).find(entry => entry.name === part);
      if (!found) return null;
      if (index === parts.length - 1) return found;
      if (found.mode !== "40000") return null;
      oid = found.oid;
    }
    return null;
  };
  const text = (head, file) => {
    const entry = resolve(head, file);
    if (!entry) return null;
    if (!["100644", "100755"].includes(entry.mode)) throw new Error("Expected regular source file");
    return object(entry.oid, "blob").toString("utf8");
  };
  const files = head => {
    const result = [];
    const visit = (oid, prefix) => {
      for (const entry of tree(oid)) {
        const file = `${prefix}${entry.name}`;
        if (entry.mode === "40000") visit(entry.oid, `${file}/`);
        else result.push({ ...entry, path: file });
      }
    };
    visit(commit(head).tree, "");
    return result;
  };
  return { object, tree, commit, resolve, text, files };
}

export function readPacket(name, directory = base) {
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error("Unsafe packet name");
  const packet = json(path.join(directory, "packets", `${name}.json`));
  const bytes = Buffer.concat(packet.parts.map(part => {
    if (!/^[a-z0-9-]+\.\d+\.gz$/.test(part.file)) throw new Error("Unsafe packet part");
    const raw = readFileSync(path.join(directory, "packets", part.file));
    if (raw.length !== part.bytes || hash(raw) !== part.sha256) throw new Error("Packet chunk changed");
    return gunzipSync(raw);
  }));
  if (bytes.length !== packet.bytes || hash(bytes) !== packet.sha256 || !iso(packet.observedAt)) {
    throw new Error("Packet original changed");
  }
  return { ...packet, body: bytes };
}

export function workflowCounts(files) {
  const direct = files.filter(row => [100644, 100755].includes(Number(row.mode))
    && /^\.github\/workflows\/[^/]+$/.test(row.path));
  const markdown = direct.filter(row => row.path.endsWith(".md")).map(row => path.basename(row.path, ".md")).sort();
  const locks = direct.filter(row => row.path.endsWith(".lock.yml")).map(row => path.basename(row.path, ".lock.yml")).sort();
  return { total_workflows: markdown.length, lockfile_count: locks.length,
    missingLocks: markdown.filter(name => !locks.includes(name)), extraLocks: locks.filter(name => !markdown.includes(name)) };
}

export function mappingCounts(text) {
  const value = JSON.parse(text);
  if (!value.toolsets || typeof value.toolsets !== "object" || Array.isArray(value.toolsets)) {
    throw new Error("Unsupported source mapping schema");
  }
  const entries = Object.entries(value.toolsets).flatMap(([toolset, config]) => {
    if (!Array.isArray(config.tools) || config.tools.some(tool => typeof tool !== "string")) {
      throw new Error("Malformed source mapping tools");
    }
    return config.tools.map(tool => ({ toolset, tool }));
  });
  return { toolsets: Object.keys(value.toolsets).length, entries: entries.length,
    unique: new Set(entries.map(row => row.tool)).size };
}

export function checkNumbers(claims, facts) {
  return claims.map(claim => {
    const actual = facts[claim.key];
    if (!Number.isSafeInteger(claim.value) || claim.value < 0 || !Number.isSafeInteger(actual) || actual < 0) {
      throw new Error("Invalid native numeric claim");
    }
    return { ...claim, actual, accepted: claim.value === actual };
  });
}

export function extractWorkflowClaims(body) {
  const claims = [];
  for (const [key, label] of [["total_workflows", "(?:Total Workflows|Agentic Workflows)"],
    ["lockfile_count", "(?:Lockfiles|Lock Files|Compiled Lockfiles)"]]) {
    const expression = new RegExp(`\\|\\s*(?:\\*\\*)?${label}(?:\\*\\*)?\\s*\\|\\s*(?:\\*\\*)?([\\d,]+)`, "gi");
    for (const match of body.matchAll(expression)) claims.push({ key, value: Number(match[1].replaceAll(",", "")),
      quote: match[0], offset: match.index });
  }
  return claims;
}

export function extractExtensionClaims(body) {
  const claims = [];
  for (const match of body.matchAll(/^\|\s*`?(\.[a-z][a-z0-9]*)`?\s*\|\s*([\d,]+)\s*\|/gm)) {
    claims.push({ key: match[1], value: Number(match[2].replaceAll(",", "")), quote: match[0], offset: match.index });
  }
  return claims;
}

export function extensionCounts(files) {
  const result = {};
  for (const row of files) {
    if (!["100644", "100755"].includes(row.mode)
      || row.path.split("/").some(segment => ["node_modules", "vendor", ".git"].includes(segment))) continue;
    const extension = path.posix.extname(row.path);
    result[extension] = (result[extension] ?? 0) + 1;
  }
  return result;
}

export function citedIdentities(body) {
  const unique = new Map();
  for (const match of body.matchAll(/https:\/\/github\.com\/github\/gh-aw\/(issues|pull)\/(\d+)(?=[/#)?\s]|$)/g)) {
    const kind = match[1] === "issues" ? "Issue" : "PullRequest", number = Number(match[2]);
    unique.set(`${kind}:${number}`, { kind, number });
  }
  return [...unique.values()].sort((a, b) => a.number - b.number || a.kind.localeCompare(b.kind));
}

export function checkIdentities(claims, entities, reportAt) {
  const byNumber = new Map(entities.map(row => [row.number, row]));
  return claims.map(claim => {
    const actual = byNumber.get(claim.number);
    return { ...claim, actual: actual ? { kind: actual.kind, createdAt: actual.createdAt, id: actual.id } : null,
      accepted: actual ? actual.kind === claim.kind && actual.createdAt <= reportAt : null,
      limitation: "Identity/kind/creation prerequisite only; not title, status, event, classification, completeness or narrative correctness." };
  });
}

export function mainlinePrefix(originals, head, start, end) {
  if (!iso(start) || !iso(end) || start >= end) throw new Error("Invalid native mainline window");
  const rows = [], seen = new Set();
  let oid = head;
  for (let steps = 0; steps < 1000; steps++) {
    if (seen.has(oid)) throw new Error("Repeated native mainline commit");
    seen.add(oid);
    const commit = originals.commit(oid);
    if (commit.at < start) return { rows, boundary: oid,
      limitation: "Contiguous first-parent prefix of the bound checkout, stopped at first older parent; no claim about time inversions beyond that boundary or main updates after checkout." };
    if (commit.at < end) rows.push({ oid, at: commit.at });
    oid = commit.parents[0];
    if (!oid) throw new Error("Missing native mainline boundary");
  }
  throw new Error("Mainline replay budget exceeded");
}

export function newIssueMembership(claims, entities, start, end) {
  if (!iso(start) || !iso(end) || start >= end) throw new Error("Invalid issue window");
  const byNumber = new Map(entities.map(row => [row.number, row]));
  return claims.map(claim => {
    const row = byNumber.get(claim.number);
    return { key: `new-issue:${claim.number}`, value: claim.number,
      actual: row ? { id: row.id, kind: row.kind, createdAt: row.createdAt } : null,
      accepted: row ? row.kind === "Issue" && row.createdAt >= start && row.createdAt < end : null };
  });
}

export function cohortFacts(cohort, entities, at) {
  if (!Array.isArray(cohort) || !cohort.length || cohort.length > 1000 || !iso(at)) {
    throw new Error("Invalid source-capped cohort");
  }
  const byNumber = new Map(entities.map(row => [row.number, row])), seen = new Set();
  for (const row of cohort) {
    if (!Number.isSafeInteger(row.number) || seen.has(row.number) || !iso(row.createdAt)
      || row.createdAt >= at || row.url !== `https://github.com/${repository}/issues/${row.number}`) {
      throw new Error("Malformed retained analyzed cohort");
    }
    seen.add(row.number);
    const independent = byNumber.get(row.number);
    if (!independent || independent.kind !== "Issue" || independent.createdAt !== row.createdAt) {
      throw new Error("Analyzed cohort creation fact lacks independent corroboration");
    }
  }
  return { issues_analyzed: cohort.length,
    issues_opened_7d: cohort.filter(row => Date.parse(row.createdAt) > Date.parse(at) - 7 * 86400000).length,
    issues_opened_30d: cohort.filter(row => Date.parse(row.createdAt) > Date.parse(at) - 30 * 86400000).length };
}
