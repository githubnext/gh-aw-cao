import { readFileSync } from "node:fs";
import path from "node:path";
import { contract, directory, repository, cutoff, revision, hash, iso, validateCustody, commitInfo, discovery, selectedGraph, verifyInstrument } from "./native.mjs";

export const facets = JSON.parse(readFileSync(path.join(directory, "facets.json")));
export const adoptionCommits = {
  "eslint-miner": "35777da04c8f5230a9627bc0ad01f8a6b98dd72c",
  "eslint-refiner": "35777da04c8f5230a9627bc0ad01f8a6b98dd72c",
  "linter-miner": "8786ae0ab416a1fc75ba97eadaa437cf3c45d670",
};
export const adoptionTimes = { "eslint-miner": "2026-06-27T22:21:12Z",
  "eslint-refiner": "2026-06-27T22:21:12Z", "linter-miner": "2026-05-15T03:09:19Z" };

export function makeDefinition(name, examples) {
  const frozen = contract.workflows[name], facet = facets[name];
  const instrument = verifyInstrument();
  return {
    schemaVersion: 3, slug: name, repository, workflowName: name,
    sourcePath: `.github/workflows/${name}.md`,
    intent: { goal: frozen.goal, acceptance: `${frozen.acceptance} Retrospective separately named partial facet: ${facet.acceptance}`,
      temporalAnchor: "workflow-adoption" },
    adoption: { commit: adoptionCommits[name], adoptedAt: adoptionTimes[name], baselineCommit: null, baselineAt: null },
    evaluation: { mode: "attainment-only" },
    evidence: { key: `${name}-lint-rule-retrospective-partial-v1`, repositories: [repository],
      opportunity: facet.population,
      filters: [frozen.eligible, facets.status, "Full source-first acceptance remains null; no zero is inferred from an empty selected interval."],
      collection: "Offline raw Git originals with commit-parent-tree-blob proofs; full production issue/PR inventory; independent own-code native oracle. No target code executes.",
      measurementKind: "interval", window: { durationDays: 7, cadenceDays: 7, maturationDays: 0 } },
    model: { architecture: "Share acquisition only; each workflow has an independent outcome predicate.",
      recommendation: "Not rated; no invented keep bar, causality, precision threshold or cost.",
      presentation: { label: facet.label, betterLabel: "More independently verified partial improvements" } },
    summary: { nativeLabel: facet.label },
    metrics: [{ id: "observed-partial", name: facet.label, role: "primary", direction: "increase",
      formula: "Sum independently established selected native before/after transitions in this disjoint interval; null without an assessed eligible cohort.",
      unit: facet.unit, presentation: { name: facet.label, legendLabel: "Native partial", transform: "identity" } }],
    validationExamples: Object.fromEntries(Object.entries(examples).map(([key, value]) => [key, {
      ...value, profileDigest: hash(readFileSync(path.join(directory, "facets.json"))),
    }])),
    sourceFirstContractSha256: hash(readFileSync(path.join(directory, "contract.json"))),
    partialFacetSha256: hash(readFileSync(path.join(directory, "facets.json"))),
    instrument,
    limitations: { totalNativeDelivery: null, fullGoal: null, attribution: null, costs: null, keepDecision: "not rated",
      sourceEra: "Frozen modern sources differ from adoption sources; retrospective facets are not contemporaneous historical policy or runtime claims." },
  };
}

export function makeCollector(name, evaluate) {
  let packet, inventory, native, graph;
  return async requests => {
    if (!Array.isArray(requests) || requests.some(request => !request ||
      ![request.windowStart, request.windowEnd, request.observedAt].every(iso) ||
      request.windowStart >= request.windowEnd || request.windowEnd > request.observedAt ||
      (request.repository !== undefined && request.repository !== repository))) throw new Error("Invalid lint-rule window or repository");
    packet ??= validateCustody();
    inventory ??= discovery();
    graph ??= selectedGraph(packet);
    native ??= await evaluate(packet);
    const transition = facets[name].transition;
    const info = commitInfo(packet, transition);
    const adoption = commitInfo(packet, adoptionCommits[name]);
    if (adoption.at !== adoptionTimes[name]) throw new Error("Adoption timestamp mismatch");
    const prefix = `.github/workflows/${name}`;
    const introduced = [".md", ".lock.yml"].map(suffix => {
      const before = packet.custody.paths.find(row => row.commit === adoption.parent && row.path === prefix + suffix);
      const after = packet.custody.paths.find(row => row.commit === adoptionCommits[name] && row.path === prefix + suffix);
      if (before?.status !== "absent" || !after?.blob) throw new Error("Adoption addition not proved against actual parent");
      return { path: prefix + suffix, source: after.blob, originalAvailable: after.status === "available" };
    });
    const profiles = [adoptionCommits[name], revision].map(commit => {
      const source = packet.text(commit, prefix + ".md"), compiled = packet.text(commit, prefix + ".lock.yml");
      return { commit, sourceSha256: source === null ? null : hash(source),
        compiledSha256: compiled === null ? null : hash(compiled),
        assignmentRequired: source === null ? null : source.includes("require-assignment: true"),
        sdkDeclared: source === null ? null : source.includes("copilot-sdk: true"),
        compiledExecutionStepLabels: compiled === null ? null :
          [...new Set(compiled.split("\n").filter(line => /name: Execute (GitHub Copilot|Claude Code)/.test(line)).map(line => line.trim()))],
        actualExecutionIdentity: null };
    });
    return requests.map(request => {
      const inRange = request.windowStart >= adoption.at && request.windowEnd <= cutoff;
      const includesTransition = inRange && request.windowStart <= info.at && info.at < request.windowEnd;
      return { evidence: {
        schemaVersion: 1, workflow: name, windowStart: request.windowStart, windowEnd: request.windowEnd,
        observedAt: request.observedAt,
        profileDigest: hash(readFileSync(path.join(directory, "facets.json"))),
        native: includesTransition ? native : null,
        coverageStatus: includesTransition && native.known ? "selected-native-cohort" : "missing",
        selectedTransition: includesTransition ? { commit: transition, parent: info.parent, at: info.at } : null,
        sourceEra: { assessment: "retrospective-fixed-facet", profiles,
          continuity: "Intermediate source/executor transitions are not exhaustively acquired; no continuous comparable workflow-effect trend is claimed" },
        executorEra: "Compiled plan declarations only; no historical execution identity inferred",
        discovery: { partitions: inventory.partitions, entities: inventory.entities, directCandidates: inventory.direct[name].length,
          completeFor: "Issue/PR discovery only", excluded: "Discussions, comments, deleted or edited-away identities" },
        adoption: { commit: adoptionCommits[name], parent: adoption.parent, at: adoption.at, introduced },
        selectedOutputGraph: graph.links.filter(link => name === "eslint-refiner"
          ? link.number === 59679 || link.number === 60238
          : name === "eslint-miner" ? link.number === 45709 : link.number === 32448 || link.number === 32865),
        latentCaseLimits: name === "eslint-refiner" ? graph.issues : [],
        fullGoal: null, totalDelivery: null, workflowContribution: null, receiptVerifiedContribution: null,
        safety: null, costs: null, keepDecision: "not rated",
        missingReason: includesTransition ? native.reason ?? null :
          "No selected independently assessed native transition in this period; not a zero or exhausted workflow-output cohort",
      }, provenance: [
        { repository, kind: "immutable-source-revision", ref: revision },
        { repository, kind: "immutable-native-transition", ref: transition },
        { repository, kind: "source-first-contract-sha256", ref: hash(readFileSync(path.join(directory, "contract.json"))) },
      ], commit: revision };
    });
  };
}

export function evidenceNative(name, evidence) {
  if (evidence?.workflow !== name || evidence.profileDigest !== hash(readFileSync(path.join(directory, "facets.json"))) ||
    evidence.coverageStatus === "missing" || !evidence.native) return null;
  return evidence.native;
}
