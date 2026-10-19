import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { censusDigest, readCensusJson } from "./operational-value-census-io.mjs";

export function stableVersion(value) {
  const match = typeof value === "string" && value.match(/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  if (!match) return null;
  const numbers = match.slice(1).map(Number);
  return numbers.every(Number.isSafeInteger) ? numbers : null;
}

export function compareStableVersions(left, right) {
  const a = stableVersion(left), b = stableVersion(right);
  if (!a || !b) throw new Error("Stable semantic versions required");
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}

export function assessVersionCurrency(constants, tools, releases, at) {
  if (!Number.isFinite(Date.parse(at))) throw new Error("Invalid release observation cutoff");
  const rows = tools.map(tool => {
    const pin = constants[tool.constant] ?? null;
    const history = releases[tool.id];
    if (!stableVersion(pin) || !history?.complete) return { tool: tool.id, pin, known: false,
      reason: "Missing stable source pin or exhaustive surviving release history." };
    const available = history.versions.filter(row => Date.parse(row.publishedAt) <= Date.parse(at));
    if (!available.some(row => compareStableVersions(row.version, pin) === 0)) {
      return { tool: tool.id, pin, known: false, reason: "Pinned release publication is not established at this endpoint." };
    }
    const matured = available.filter(row => Date.parse(row.publishedAt) + tool.cooldownDays * 86400000 <= Date.parse(at));
    if (!matured.length) return { tool: tool.id, pin, known: false, reason: "No surviving stable release has matured." };
    const latest = matured.reduce((best, row) => compareStableVersions(row.version, best.version) > 0 ? row : best);
    return { tool: tool.id, pin, known: true, latestEligible: latest.version,
      latestPublishedAt: latest.publishedAt, stale: compareStableVersions(pin, latest.version) < 0 };
  });
  const known = rows.filter(row => row.known);
  return { valid: known.length > 0, completeCohort: known.length === tools.length,
    known: known.length, eligible: tools.length, stale: known.filter(row => row.stale).length, rows };
}

export function scoreVersionCurrency(id, evidence) {
  if (!["stale-pins", "known-stale-pins"].includes(id) || evidence?.valid !== true
    || !Number.isSafeInteger(evidence.eligible) || evidence.eligible <= 0
    || !Number.isSafeInteger(evidence.known) || evidence.known <= 0 || evidence.known > evidence.eligible
    || !Number.isSafeInteger(evidence.stale) || evidence.stale < 0 || evidence.stale > evidence.known
    || evidence.completeCohort !== (evidence.known === evidence.eligible)) return null;
  if (id === "known-stale-pins") return evidence.stale;
  return evidence.completeCohort ? evidence.stale : null;
}

export function versionCurrencyModule(contract) {
  const hash = file => createHash("sha256").update(readFileSync(file)).digest("hex");
  if (hash(import.meta.filename) !== contract.interpreterSha256) throw new Error("Frozen version-currency interpreter changed");
  const example = stale => ({ valid: true, completeCohort: true, eligible: 2, known: 2, stale });
  const metric = (id, role, name, legendLabel, formula) => ({ id, role, name, unit: "pins", direction: "decrease", formula,
    presentation: { name, legendLabel, transform: "identity" } });
  return { definition: {
    schemaVersion: 3, slug: contract.workflowId, repository: contract.repository,
    workflowName: "CLI Version Checker", sourcePath: `.github/workflows/${contract.workflowId}.md`,
    intent: { goal: "Keep monitored default CLI/MCP versions current with independently published stable releases.",
      acceptance: "Compare actual immutable Go constants with surviving official release publications available at each endpoint.",
      temporalAnchor: "workflow-adoption" },
    adoption: contract.adoption, evaluation: { mode: "attainment-only" },
    evidence: { key: "native-default-version-currency-v1", repositories: [contract.repository],
      interpreterSha256: contract.interpreterSha256, parserSha256: contract.parserSha256, tools: contract.tools,
      opportunity: "The frozen eight-tool default-version cohort named by the source workflow.",
      filters: ["Compare numeric stable semantic versions, not lexicographic strings or mutable latest tags.",
        "The primary series requires all eight pins to have comparable surviving release evidence.",
        "Partial historical evidence remains a diagnostic; missing pins or publication records are unknown.",
        "Playwright releases mature for three days according to its source-defined installation cooldown.",
        "Deleted releases, historical latest-tag movements, Docker digests, compatibility, research quality and causation are not established."],
      collection: "Digest-checked immutable constants and normalized exhaustive surviving official publication metadata.",
      measurementKind: "snapshot", window: { durationDays: 7, cadenceDays: 7, maturationDays: 0 } },
    model: { architecture: "Immutable Go AST pins joined to official release publication history.",
      recommendation: "Inspect known release lag and cohort missingness; fewer stale pins is useful progress, not proof of complete upgrade safety.",
      presentation: { label: "Known stale default-version pins", betterLabel: "Fewer default pins behind published stable releases" } },
    summary: { nativeLabel: "Known stale default-version pins" },
    metrics: [
      metric("stale-pins", "primary", "Stale pins in comparable eight-tool cohort", "Stale default pins",
        "Count pins below the greatest matured surviving stable release, only when every frozen cohort pin is comparable."),
      metric("known-stale-pins", "diagnostic", "Known stale pins in partial evidence", "Known stale pins",
        "Count demonstrated stale pins among those with comparable evidence; do not compare changing cohorts as complete delivery."),
    ],
    validationExamples: { targetAttained: example(0), targetMissed: example(1),
      missing: { valid: false }, malformed: { ...example(1), stale: 3 } },
  }, scoreMetric: scoreVersionCurrency, collectBatch(requests) {
    const directory = "docs/operational-value/proof/version-currency";
    const index = readCensusJson(`${directory}/index.json`);
    if (!index.complete || index.contractSha256 !== censusDigest(contract)) throw new Error("Version acquisition scope changed");
    const facts = readCensusJson(`${directory}/facts.json.gz`);
    if (censusDigest(facts) !== index.factsSha256) throw new Error("Version facts changed");
    return requests.map(request => {
      if (request.repository && request.repository !== contract.repository) throw new Error("Version observation repository mismatch");
      const state = facts.states.find(row => row.windowEnd === request.windowEnd);
      const evidence = state && request.windowEnd <= contract.until
        ? assessVersionCurrency(state.constants, contract.tools, facts.releases, request.windowEnd)
        : { valid: false, reason: "No exact frozen source endpoint." };
      return { evidence: { ...evidence, fullGoalAcceptance: "not-measured", workflowCausation: "not-measured", costs: "not-measured" },
        provenance: [{ repository: contract.repository, kind: "immutable-workflow-source", ref: contract.sourceGitBlob },
          { repository: contract.repository, kind: "native-version-currency-index", ref: censusDigest(index) }],
        commit: state?.commit ?? contract.sourceRevision };
    });
  } };
}
