import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { readCensusJson, censusDigest } from "./operational-value-census-io.mjs";

export function specReferenceFacts({ id, content }) {
  const lines = content.split(/\r?\n/), links = [];
  let fence = null;
  for (const [index, line] of lines.entries()) {
    const boundary = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (boundary) {
      const [marker, suffix] = boundary.slice(1);
      if (!fence && (marker[0] !== "`" || !suffix.includes("`"))) {
        fence = marker; continue;
      }
      if (fence && marker[0] === fence[0] && marker.length >= fence.length && !suffix.trim()) {
        fence = null; continue;
      }
    }
    if (fence) continue;
    const prose = line.replace(/(`+).*?\1/g, "");
    for (const match of prose.matchAll(/\[[^\]\r\n]*\]\(\s*(<[^>\r\n]+>|[^\s)]+)(?:\s+["'][^)\r\n]*["'])?\s*\)/g)) {
      const destination = match[1].replace(/^<|>$/g, "");
      if (/^[a-z][a-z\d+.-]*:/i.test(destination) || /^[/#]/.test(destination)) continue;
      const local = destination.split(/[?#]/)[0];
      if (!local.endsWith(".md")) continue;
      let target = null, invalid = false;
      try {
        const resolved = path.posix.resolve("/repository/.github/aw", decodeURIComponent(local));
        if (resolved.startsWith("/repository/")) target = resolved.slice("/repository/".length);
        else invalid = true;
      } catch (error) {
        if (!(error instanceof URIError)) throw error;
        invalid = true;
      }
      links.push({ line: index + 1, target, invalid });
    }
  }
  const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  return { id, links, descriptionPresent: Boolean(frontmatter && /^description:/m.test(frontmatter[1])) };
}

export function scanSpecState(state, features) {
  let broken = 0, links = 0, missingDescriptions = 0, unknown = 0, unknownSources = 0;
  for (const entry of state.specs) {
    if (!["100644", "100755"].includes(entry.mode)) { unknown += 1; unknownSources += 1; continue; }
    const fact = features.get(entry.blob);
    if (!fact || !Array.isArray(fact.links) || typeof fact.descriptionPresent !== "boolean") {
      throw new Error("Missing native specification facts");
    }
    if (!fact.descriptionPresent) missingDescriptions += 1;
    for (const link of fact.links) {
      links += 1;
      if (link.invalid) { broken += 1; continue; }
      if (!Object.hasOwn(state.lookup, link.target)) throw new Error("Incomplete native reference lookup");
      const target = state.lookup[link.target];
      if (target?.symlink) unknown += 1;
      else if (!target || !["100644", "100755"].includes(target.mode)) broken += 1;
    }
  }
  return { valid: true, eligibleCount: links, filesScanned: state.specs.length,
    linksChecked: links, observedBrokenLinks: broken, missingDescriptions, unresolved: unknown,
    unresolvedSources: unknownSources, assessedFiles: state.specs.length - unknownSources,
    coverageStatus: unknown ? "partial" : "complete", stateSha256: censusDigest(state) };
}

export function scoreSpecCondition(id, evidence) {
  if (!["broken-links", "observed-broken-links", "missing-descriptions"].includes(id) || evidence?.valid !== true
    || ![evidence.filesScanned, evidence.linksChecked, evidence.observedBrokenLinks,
      evidence.missingDescriptions, evidence.unresolved, evidence.unresolvedSources, evidence.assessedFiles]
      .every(value => Number.isSafeInteger(value) && value >= 0)
    || evidence.observedBrokenLinks > evidence.linksChecked || evidence.missingDescriptions > evidence.assessedFiles
    || evidence.assessedFiles + evidence.unresolvedSources !== evidence.filesScanned
    || evidence.unresolvedSources > evidence.unresolved) return null;
  if (id === "broken-links") return evidence.unresolved ? null : evidence.observedBrokenLinks;
  if (id === "observed-broken-links") return evidence.unresolvedSources && !evidence.assessedFiles ? null : evidence.observedBrokenLinks;
  return evidence.unresolvedSources ? null : evidence.missingDescriptions;
}

export function nativeSpecConditionModule(contract) {
  if (contract.nativeModelSha256 !== createHash("sha256").update(readFileSync(import.meta.filename)).digest("hex")) {
    throw new Error("Frozen specification condition interpreter changed");
  }
  const sample = value => ({ valid: true, filesScanned: 2, linksChecked: 2,
    observedBrokenLinks: value, missingDescriptions: value, unresolved: 0, unresolvedSources: 0, assessedFiles: 2 });
  const presentation = label => ({ name: label, legendLabel: label, transform: "identity" });
  const definition = {
    schemaVersion: 3, slug: contract.workflowId, repository: contract.repository,
    workflowName: "Daily Spec Coverage Review", sourcePath: `.github/workflows/${contract.workflowId}.md`,
    intent: { goal: "Keep repository specifications free of broken local references and missing description frontmatter.",
      acceptance: "Partial facet: the complete top-level .github/aw Markdown scan under the frozen read-only scanner rules finds actual missing repository-contained Markdown targets. Ignore examples and external URLs; preserve unavailable symlink evidence.",
      temporalAnchor: "workflow-adoption" },
    adoption: contract.adoption, evaluation: { mode: "attainment-only" },
    evidence: { key: "native-specification-condition-v1", repositories: [contract.repository],
      nativeModelSha256: contract.nativeModelSha256, scannerGitBlob: contract.scannerGitBlob,
      opportunity: "All top-level .github/aw/*.md files and their qualifying local Markdown references.",
      filters: ["Complete source trees at immutable first-parent revisions, not a truncated grep sample.",
        "Frozen current scanner rules are a comparable partial facet, not proof every historical agent used that scanner.",
        "Unresolved symlink paths are unknown, not broken or clean.",
        "Repository state is not fresh delivered contribution and does not establish workflow causation.",
        "Related-issue discovery, broader semantic documentation quality and costs remain unmeasured."],
      collection: "Replay preserved blob-derived reference facts and complete target lookups for immutable weekly states.",
      measurementKind: "snapshot", window: { durationDays: 7, cadenceDays: 7, maturationDays: 0 } },
    model: { architecture: "Frozen local-link rules and immutable Git tree membership.",
      recommendation: "Inspect native broken-reference movement separately from reports and workflow attribution.",
      presentation: { label: "Specification reference condition", betterLabel: "Fewer broken references" } },
    summary: { nativeLabel: "Broken local specification references" },
    metrics: [
      { id: "broken-links", role: "primary", name: "Broken local specification references", direction: "decrease",
        unit: "links", formula: "qualifying inline local Markdown references whose contained regular-file target is absent",
        presentation: presentation("Broken local links") },
      { id: "observed-broken-links", role: "diagnostic", name: "Observed broken-reference subtotal", direction: "decrease",
        unit: "links", formula: "known broken references without treating unresolved symlinks as clean",
        presentation: presentation("Observed broken links") },
      { id: "missing-descriptions", role: "diagnostic", name: "Specifications missing description frontmatter",
        direction: "decrease", unit: "files", formula: "scanned specifications without the scanner-required description frontmatter key",
        presentation: presentation("Missing descriptions") },
    ],
    validationExamples: { targetAttained: sample(0), targetMissed: sample(2),
      missing: {}, malformed: { ...sample(2), observedBrokenLinks: "two" } },
  };
  return { definition, scoreMetric: scoreSpecCondition, collectBatch(requests) {
    const directory = "docs/operational-value/proof/spec-condition";
    const index = readCensusJson(`${directory}/index.json.gz`);
    if (index.complete !== true || index.repository !== contract.repository || index.sourceRevision !== contract.sourceRevision
      || index.nativeModelSha256 !== contract.nativeModelSha256 || index.until !== contract.until) throw new Error("Specification archive scope changed");
    const facts = index.partitions.flatMap(part => {
      if (!/^facts-\d{3}\.json\.gz$/.test(part.file)) throw new Error("Unsafe specification fact partition");
      const rows = readCensusJson(`${directory}/${part.file}`);
      if (censusDigest(rows) !== part.sha256 || rows.length !== part.count) throw new Error("Specification facts changed");
      return rows;
    });
    const features = new Map(facts.map(row => [row.id, row]));
    return requests.map(request => {
      if (request.repository && request.repository !== contract.repository) throw new Error("Specification repository mismatch");
      const state = index.states.find(row => row.windowEnd === request.windowEnd);
      if (!state) return { evidence: { valid: false, missingReason: "No preserved immutable state at this observation endpoint." },
        provenance: [{ repository: contract.repository, kind: "immutable-git-head", ref: contract.sourceRevision }] };
      return { evidence: scanSpecState(state, features), commit: state.commit,
        provenance: [{ repository: contract.repository, kind: "immutable-git-tree", ref: state.tree },
          { repository: contract.repository, kind: "specification-state-sha256", ref: censusDigest(state) }] };
    });
  } };
}
