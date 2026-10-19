import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { readJsonArchive } from "../.github/skills/add-operational-value/scripts/json-archive.mjs";
import { readZip } from "./native-smoke-pydantic.mjs";

const root = new URL("../", import.meta.url), directory = "docs/operational-value/proof/gpl-audit/";
export const hash = value => createHash("sha256").update(value).digest("hex");
const bytes = name => readFileSync(new URL(name, root));
const iso = value => typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value)
  && Number.isFinite(Date.parse(value));

export function moduleDirectoryHash(files, module, version) {
  if (!(files instanceof Map) || !files.size || files.size > 4096) throw new Error("Invalid bounded Go module file set");
  const prefix = `${module}@${version}/`;
  const rows = [...files].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  if (rows.some(([name, data]) => !name.startsWith(prefix) || name.endsWith("/")
    || /[\n\r\0]/.test(name) || !Buffer.isBuffer(data))) throw new Error("Go module ZIP prefix/file mismatch");
  const listing = rows.map(([name, data]) => `${hash(data)}  ${name}\n`).join("");
  return `h1:${createHash("sha256").update(listing).digest("base64")}`;
}

export function gpl3Terms(text) {
  if (typeof text !== "string" || !/GNU GENERAL PUBLIC LICENSE\s+Version 3, 29 June 2007/.test(text)) return null;
  const start = text.indexOf("TERMS AND CONDITIONS"), marker = "END OF TERMS AND CONDITIONS";
  const end = text.indexOf(marker, start);
  if (start < 0 || end <= start || text.indexOf(marker, end + marker.length) >= 0) return null;
  return text.slice(start, end + marker.length).replace(/\s+/g, " ").trim();
}

export function inspectPackage(module, version, zip, goSum, reference) {
  const files = readZip(zip), actualSum = moduleDirectoryHash(files, module, version);
  const sums = goSum.split(/\r?\n/).filter(line => line.startsWith(`${module} ${version} `));
  const referenceTerms = gpl3Terms(reference);
  if (!referenceTerms || referenceTerms.length < 25000) throw new Error("Independent complete GPL3 reference unavailable");
  const expectedSum = sums.length === 1 ? sums[0].split(" ")[2] : null;
  const licenseName = `${module}@${version}/LICENSE`;
  const license = files.get(licenseName), terms = license ? gpl3Terms(license.toString("utf8")) : null;
  const checksumMatches = expectedSum !== null && actualSum === expectedSum;
  const declarationMatches = terms !== null && terms === referenceTerms;
  return {
    id: `${module}@${version}`, module, version, actualSum, expectedSum, checksumMatches,
    licenseName, licenseSha256: license ? hash(license) : null,
    canonicalTermsSha256: hash(referenceTerms), termsSha256: terms ? hash(terms) : null,
    declarationMatches, accepted: checksumMatches && declarationMatches,
    status: !expectedSum || !license ? "missing" : checksumMatches && declarationMatches ? "verified" : "rejected",
    limitation: "GPL3 text presence only; no legal compatibility, sole licensing, full dependency reachability or remediation claim.",
  };
}

export function extractClaims(body) {
  if (typeof body !== "string") throw new Error("Missing original GPL finding body");
  const rows = [];
  const primary = /- \*\*Module\*\*: `([^`]+)`\s*\n- \*\*Version\*\*: `(v[0-9][^`]+)`\s*\n- \*\*License\*\*: ([^\n]+)/g;
  for (const match of body.matchAll(primary)) rows.push({ module: match[1], version: match[2], license: match[3], quote: match[0] });
  for (const match of body.matchAll(/^\d+\. \*\*([^*\n]+)\*\* (v\d+\.\d+\.\d+) \(([^)\n]+)\)$/gm)) {
    rows.push({ module: match[1], version: match[2], license: match[3], quote: match[0] });
  }
  const ids = rows.map(row => `${row.module}@${row.version}`);
  if (new Set(ids).size !== ids.length) throw new Error("Ambiguous repeated versioned GPL claims");
  return rows;
}

export function gplAuditModule(pins) {
  for (const [name, expected] of Object.entries(pins)) {
    if (hash(bytes(name)) !== expected) throw new Error(`GPL instrument dependency changed: ${name}`);
  }
  const index = readJsonArchive(fileURLToPath(new URL(`${directory}index.json.gz`, root)));
  const original = label => {
    const entry = index.receipts[label];
    if (!entry || !/^originals\/[\w.-]+\.json\.gz$/.test(entry.file)) throw new Error("Unsafe GPL original reference");
    const file = `${directory}${entry.file}`;
    if (hash(bytes(file)) !== entry.archiveSha256) throw new Error("Original GPL archive changed");
    const packet = readJsonArchive(fileURLToPath(new URL(file, root)));
    if (hash(packet.body) !== packet.sha256 || packet.sha256 !== entry.bodySha256 || !iso(packet.observedAt)) {
      throw new Error("Original GPL response custody changed");
    }
    return packet;
  };
  const document = label => JSON.parse(original(label).body);
  const binary = label => {
    const packet = original(label), data = Buffer.from(packet.body, "base64");
    if (packet.encoding !== "base64" || data.toString("base64") !== packet.body) throw new Error("Invalid native GPL binary encoding");
    return data;
  };
  const metadata = document("repository");
  if (metadata.id !== 1036865607 || metadata.full_name !== "github/gh-aw" || metadata.private !== false
    || index.repositoryId !== metadata.id || index.repository !== metadata.full_name
    || index.revision !== "c86377ec47b38f0b5af463277ee55d1d03d08da8"
    || index.cutoff !== "2026-10-18T15:00:12Z") throw new Error("GPL public repository scope changed");
  const source = (label, revision, name) => {
    const packet = original(label), value = JSON.parse(packet.body);
    const data = Buffer.from(value.content.replace(/\s/g, ""), "base64");
    if (packet.endpoint !== `repos/github/gh-aw/contents/${name}?ref=${revision}` || value.path !== name
      || createHash("sha1").update(`blob ${data.length}\0`).update(data).digest("hex") !== value.sha) {
      throw new Error("Immutable GPL source identity changed");
    }
    return { text: data.toString("utf8"), blob: value.sha };
  };
  const frozen = source("frozen-md", index.revision, ".github/workflows/gpclean.md");
  source("frozen-lock-yml", index.revision, ".github/workflows/gpclean.lock.yml");
  const run = document("finding-run"), issue = document("issue-15048");
  if (run.id !== 21928661830 || run.repository?.id !== metadata.id || run.head_sha !== index.findingHead
    || run.path !== ".github/workflows/gpclean.lock.yml" || issue.number !== 15048 || issue.pull_request
    || issue.html_url !== "https://github.com/github/gh-aw/issues/15048" || !iso(issue.created_at)
    || issue.created_at >= index.cutoff) throw new Error("GPL finding/source identity changed");
  const editable = source("finding-source-gpclean-md", run.head_sha, ".github/workflows/gpclean.md");
  source("finding-source-gpclean-lock-yml", run.head_sha, ".github/workflows/gpclean.lock.yml");
  source("finding-source-go-mod", run.head_sha, "go.mod");
  source("finding-source-tools-go", run.head_sha, "tools.go");
  const goSum = source("finding-source-go-sum", run.head_sha, "go.sum");
  if (!editable.text.includes("GPL") || !editable.text.includes("License Detection")) throw new Error("Unsupported original GPL goal era");
  const adoption = document("adoption");
  if (adoption.sha !== "6d4da0d7134d21def02c6cfb27e00bf3d5851507"
    || !adoption.files.some(row => row.filename === ".github/workflows/gpclean.md" && row.status === "added")) {
    throw new Error("GPL actual adoption changed");
  }
  const referencePacket = original("gpl3-reference");
  if (referencePacket.endpoint !== "https://www.gnu.org/licenses/gpl-3.0.txt") throw new Error("GPL standard reference changed");
  const reference = binary("gpl3-reference").toString("utf8"), claims = extractClaims(issue.body);
  const records = index.modules.map(module => {
    const claim = claims.filter(row => row.module === module.module && row.version === module.version);
    if (claim.length !== 1 || !/\bGPL-/.test(claim[0].license)
      || original(module.receipt).endpoint !== module.url) throw new Error("Native GPL package does not bind one original claim");
    return { ...inspectPackage(module.module, module.version, binary(module.receipt), goSum.text, reference),
      claim: claim[0], issueNumber: issue.number, issueId: issue.node_id, createdAt: issue.created_at,
      bodySha256: hash(issue.body), observedAt: original("issue-15048").observedAt,
      sourceHead: run.head_sha, sourceBlob: editable.blob, sourceGoSumBlob: goSum.blob };
  });
  const retainedIssues = index.candidates.map(row => {
    const value = document(`issue-${row.number}`);
    if (value.node_id !== row.id || value.created_at !== row.createdAt || value.html_url !== row.url) {
      throw new Error("GPL discovery/original relation changed");
    }
    return { number: row.number, substantive: value.number === 15048, createdAt: row.createdAt };
  });
  const scoreMetric = (id, evidence) => {
    if (id !== "verified-license-facts" || evidence?.valid !== true || !Array.isArray(evidence.records)) return null;
    const ids = new Set();
    for (const record of evidence.records) {
      if (!record || typeof record.id !== "string" || ids.has(record.id)
        || !records.some(expected => isDeepStrictEqual(record, expected))) return null;
      ids.add(record.id);
    }
    const assessed = evidence.records.filter(row => row.status !== "missing");
    return assessed.length ? assessed.filter(row => row.accepted).length : null;
  };
  const definition = {
    schemaVersion: 3, slug: "gpclean", repository: "github/gh-aw",
    workflowName: "GPL audit: corroborated exact-version license-presence facts", sourcePath: ".github/workflows/gpclean.md",
    contractVersion: "2.0.0", authoring: "Outcome-informed retrospective partial; frozen v1 strict acceptance is preserved.",
    intent: { goal: "Deliver accurate version-bound GPL-family license facts.",
      acceptance: "Exact versioned Go module ZIP checksum matches immutable run-head go.sum, and root license terms match independent complete GNU GPL3 terms.",
      temporalAnchor: "workflow-adoption" },
    adoption: { commit: adoption.sha, adoptedAt: adoption.commit.committer.date, baselineCommit: null, baselineAt: null },
    evaluation: { mode: "attainment-only", reason: "One selected surviving finding, not complete dependency or historical audit coverage." },
    frozenSource: { revision: index.revision, sourceBlob: frozen.blob, cutoff: index.cutoff },
    oracleDependencies: Object.entries(pins).map(([name, sha256]) => ({ path: name, sha256 })),
    evidence: { key: "gpclean/native-license-presence/2.0.0", repositories: ["github/gh-aw"],
      opportunity: "A source-goal versioned package license-presence claim.",
      filters: ["Exact module version, original ZIP, canonical Go directory checksum and immutable Go sum entry.",
        "Complete original license terms, not a title substring or current repository license.",
        "One package/version fact per original report-creation cohort; no repeated snapshot credit."],
      collection: "Read-only originals acquired separately; offline hash, ZIP and full license-terms replay.",
      measurementKind: "interval", window: { durationDays: 7, cadenceDays: 7, maturationDays: 0 } },
    model: { architecture: "Bounded native factual partial; full legal/audit/remediation acceptance remains separate.",
      recommendation: "Not rated: no agreed keep bar or matching cost evidence.",
      presentation: { label: "Corroborated versioned license facts", betterLabel: "More independently verified license facts" } },
    summary: { nativeLabel: "correct version-bound GPL-presence facts" },
    metrics: [{ id: "verified-license-facts", name: "Correct version-bound GPL-presence facts", role: "primary",
      formula: "Distinct exact package/version claims independently matching native ZIP checksum and complete GPL3 declaration.",
      direction: "increase", unit: "versioned package license facts",
      presentation: { name: "Corroborated GPL-presence facts", legendLabel: "License facts", transform: "identity" } }],
    limitations: [index.limitation,
      "GPL3 text presence is not a legal determination, sole-license expression, MIT compatibility or distribution obligation.",
      "Detailed conjunctive license expressions, dependency reachability and eligibility of development tools remain unverified.",
      "The claimed tool dependency is not credited as direct runtime use or removal; recommendations and full audit acceptance remain unknown.",
      "Surviving after-cutoff issue bytes do not establish original publication-time accuracy or authoritative creation receipts.",
      "Failure/incomplete-style issue objects are discovery, not native license audit completion.",
      "Full safeguards, contribution, matching costs and native keep bar remain unknown."],
    validationExamples: { targetAttained: { valid: true, records },
      targetMissed: { valid: true, records: records.slice(0, 1) },
      missing: { valid: false }, malformed: { valid: true, records: [null] } },
  };
  async function collectBatch(requests, context = {}) {
    if (Object.keys(context).some(key => key !== "database")) throw new Error("Unverified GPL evidence authority");
    if (!Array.isArray(requests) || requests.length > 1000) throw new Error("Invalid bounded GPL period batch");
    return requests.map(request => {
      if (!request || ![request.windowStart, request.windowEnd, request.observedAt].every(iso)
        || request.windowStart >= request.windowEnd || request.observedAt < request.windowEnd
        || request.repository && request.repository !== "github/gh-aw") throw new Error("Invalid GPL period");
      const eligible = request.windowStart >= definition.adoption.adoptedAt && request.windowEnd <= index.cutoff;
      const selected = records.filter(row => row.createdAt >= request.windowStart && row.createdAt < request.windowEnd);
      return { evidence: { valid: eligible, records: selected, fullAcceptance: null, contribution: null, costs: null,
        discoveryObjects: retainedIssues.filter(row => row.createdAt >= request.windowStart && row.createdAt < request.windowEnd),
        missingReason: !eligible ? "Outside acquired post-adoption/cutoff scope." : selected.length
          ? "Bounded versioned license-presence facts, not legal clearance or remediation."
          : "No independently verified versioned license fact retained for this period; absence is not zero." },
      provenance: [{ repository: "github/gh-aw", kind: "native-versioned-license-presence",
        ref: pins[`${directory}index.json.gz`] }], commit: index.revision };
    });
  }
  return { definition, collectBatch, scoreMetric };
}
