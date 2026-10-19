import { readFileSync } from "node:fs";
import path from "node:path";
import { base, revision, cutoff, repository, hash, json, iso, readOriginals, readPacket,
  workflowCounts, extractWorkflowClaims, checkNumbers, extractExtensionClaims, extensionCounts,
  mappingCounts, mainlinePrefix, citedIdentities, newIssueMembership, cohortFacts } from "./native-monitoring-accuracy.mjs";
import { readOutputHistory } from "../.github/skills/add-operational-value/scripts/collect-output-history.mjs";

const root = new URL("../", import.meta.url);
const count = value => Number.isSafeInteger(value) && value >= 0;

export function scoreMonitoringMetric(id, evidence) {
  if (!["native-fact-accuracy", "native-fact-coverage", "verified-native-facts", "opening-undercount-floor"].includes(id)) {
    throw new Error(`Unknown monitoring metric ${id}`);
  }
  if (!evidence || evidence.valid !== true || ![evidence.eligible, evidence.assessed, evidence.accepted].every(count)
    || evidence.accepted > evidence.assessed || evidence.assessed > evidence.eligible) return null;
  if (id === "opening-undercount-floor") return count(evidence.openingUndercountFloor) ? evidence.openingUndercountFloor : null;
  if (!evidence.eligible) return null;
  if (id === "native-fact-coverage") return 100 * evidence.assessed / evidence.eligible;
  if (!evidence.assessed) return null;
  if (id === "verified-native-facts") return evidence.accepted;
  return 100 * evidence.accepted / evidence.assessed;
}

function reportBody(record) {
  const packet = readPacket(`${record.slug}-discussion-page`);
  const source = JSON.parse(packet.body);
  const rows = source.data?.repository?.discussions?.nodes;
  if (source.errors?.length || source.data?.repository?.databaseId !== 1036865607 || !Array.isArray(rows)) {
    throw new Error("Invalid original Discussion page");
  }
  const matches = rows.filter(row => row.id === record.candidate.id && row.number === record.candidate.number);
  if (matches.length !== 1 || matches[0].createdAt !== record.candidate.createdAt
    || matches[0].updatedAt !== record.candidate.updatedAt) throw new Error("Changed report discovery identity");
  return matches[0].body;
}

export function inspectMonitoringReport(record, originals, entities) {
  const body = reportBody(record), source = originals.text(record.head, `.github/workflows/${record.slug}.md`);
  const checks = [];
  let detail = {};
  if (record.slug === "daily-code-metrics") {
    if (!source.includes("Count direct `.github/workflows/*.md`") || !source.includes("lockfile_count")) {
      throw new Error("Current native inventory predicate is not applicable to this source era");
    }
    const facts = workflowCounts(originals.files(record.head));
    checks.push(...checkNumbers(extractWorkflowClaims(body), facts));
    detail = { facts, eligibility: "Both source-required workflow counts in the explicit Workflow Metrics table.",
      unmeasured: "LOC, cloc scope, code quality, churn, trends, charts, reader benefit, and creation-time custody." };
    for (const key of ["total_workflows", "lockfile_count"]) {
      if (!checks.some(row => row.key === key)) checks.push({ key, accepted: null, missing: "Required factual table cell absent or unsupported" });
    }
  } else if (record.slug === "repo-tree-map") {
    if (!source.includes("File type distribution") || !source.includes("Exclude package manager")) {
      throw new Error("Unsupported tree-map source era");
    }
    const claims = extractExtensionClaims(body), facts = extensionCounts(originals.files(record.head));
    if (!claims.length) throw new Error("No supported literal extension-count table");
    checks.push(...checkNumbers(claims, Object.fromEntries(claims.map(row => [row.key, facts[row.key] ?? 0]))));
    detail = { reference: "Regular tracked files in the immutable run head; exclude .git/node_modules/vendor path segments; suffix uses the final extension.",
      unmeasured: "This is fixed immutable-reference agreement, not proof of checkout cleanliness, untracked files, disk allocation sizes, bar scale, complete extension coverage or comprehension." };
  } else if (record.slug === "github-mcp-tools-report") {
    if (!source.includes("Load Current JSON Mapping from Repository")) throw new Error("Unsupported MCP source era");
    const facts = mappingCounts(originals.text(record.head, "pkg/workflow/data/github_toolsets_permissions.json"));
    const totals = /\*\*Total Tools in JSON Mapping\*\*:\s*(\d+) unique \((\d+) entries/.exec(body);
    const categories = /\*\*Toolset Categories \(JSON mapping\)\*\*:\s*(\d+)/.exec(body);
    if (!totals || !categories) throw new Error("Unsupported explicit JSON-mapping claim format");
    checks.push(...checkNumbers([{ key: "unique", value: Number(totals[1]), quote: totals[0] },
      { key: "entries", value: Number(totals[2]), quote: totals[0] },
      { key: "toolsets", value: Number(categories[1]), quote: categories[0] }], facts));
    detail = { facts, unmeasured: "Live tools/list envelopes, live server version, behavioral descriptions, permission reach, claimed 59 live tools, and downstream mapping repairs." };
  } else if (record.slug === "daily-repo-chronicle") {
    if (!source.includes("Commits to main branches")) throw new Error("Unsupported chronicle source era");
    const prefix = mainlinePrefix(originals, record.head, record.nativeWindow.start, record.nativeWindow.end);
    const claims = [...body.matchAll(/^- `([a-f0-9]{7,40})` /gm)].map(match => match[1]);
    if (!claims.length || new Set(claims).size !== claims.length) throw new Error("Missing or duplicated native commit citations");
    for (const claim of claims) {
      const matches = prefix.rows.filter(row => row.oid.startsWith(claim));
      checks.push({ key: claim, accepted: matches.length === 1, actual: matches.map(row => row.oid) });
    }
    const covered = prefix.rows.filter(row => claims.some(claim => row.oid.startsWith(claim))).length;
    detail = { prefix, prefixCoverage: prefix.rows.length ? 100 * covered / prefix.rows.length : null,
      covered, declaredWindow: record.nativeWindow,
      sourceDurationConformance: Date.parse(record.nativeWindow.end) - Date.parse(record.nativeWindow.start) === 86400000,
      unmeasured: "Cited mainline-membership only: descriptions, human agency, PR merges, issue statistics, release facts and reader benefit. Declared edition is 24h05m, not source-required 24h; this is not full temporal conformance." };
  } else if (record.slug === "weekly-issue-summary") {
    if (!source.includes("over the last 7 days")) throw new Error("Unsupported weekly source era");
    const window = /Window: \*\*(\d{4}-\d\d-\d\d) (\d\d:\d\d) UTC → (\d{4}-\d\d-\d\d) (\d\d:\d\d) UTC\*\*/.exec(body);
    const section = body.split("### Human issues opened this week")[1]?.split("### Bot / automation issues")[0];
    if (!window || !section) throw new Error("Missing explicit new-issue list/window");
    const start = `${window[1]}T${window[2]}:00Z`, end = `${window[3]}T${window[4]}:00Z`;
    if (Date.parse(end) - Date.parse(start) !== 7 * 86400000) throw new Error("Not a declared seven-day window");
    const claims = citedIdentities(section);
    if (!claims.length || claims.some(row => row.kind !== "Issue")) throw new Error("Unsupported new-issue list");
    const cohort = entities.filter(row => row.kind === "Issue" && row.createdAt >= start && row.createdAt < end);
    const expected = new Map(cohort.map(row => [row.id, row])), transferFree = new Set(), seen = new Set();
    if (!Array.isArray(record.transferPackets) || !record.transferPackets.length) throw new Error("Missing transfer-history prerequisite");
    for (const name of record.transferPackets) {
      const response = JSON.parse(readPacket(name).body);
      if (response.errors?.length || !Array.isArray(response.data?.nodes)) throw new Error("Unavailable transfer-history response");
      for (const node of response.data.nodes) {
        if (!node) continue;
        const issue = expected.get(node.id), timeline = node.timelineItems;
        if (!issue || seen.has(node.id) || node.number !== issue.number || node.createdAt !== issue.createdAt
          || node.repository?.databaseId !== 1036865607 || !count(timeline?.totalCount)
          || !Array.isArray(timeline.nodes) || typeof timeline.pageInfo?.hasNextPage !== "boolean") {
          throw new Error("Malformed or foreign transfer-history evidence");
        }
        seen.add(node.id);
        if (timeline.totalCount === 0 && !timeline.pageInfo.hasNextPage && timeline.nodes.length === 0) transferFree.add(node.id);
      }
    }
    const transferFreeEntities = cohort.filter(row => transferFree.has(row.id));
    checks.push(...newIssueMembership(claims, entities, start, end).map(check => {
      if (check.accepted === true && !transferFree.has(check.actual.id)) return { ...check, accepted: null,
        missing: "Transfer-free original repository membership not established" };
      return check;
    }));
    const total = /^\| Issues opened \| ([\d,]+) \|/m.exec(body);
    if (!total) throw new Error("Missing opening count claim");
    const claimed = Number(total[1].replaceAll(",", ""));
    const surviving = transferFreeEntities.length;
    detail = { declaredWindow: { start, end }, reportedOpenings: claimed, survivingIndependentOpenings: surviving,
      openingUndercountFloor: surviving > claimed ? surviving - claimed : 0,
      transferHistory: { candidates: cohort.length, observed: seen.size, transferFree: transferFree.size,
        excludedUnknownOrTransferred: cohort.length - transferFree.size },
      unmeasured: "New-issue citation creation-window correctness only, not titles, human identity, comments, state, labels, complete listing, narrative or reader decisions. Only surviving identities with zero transfer events in the independent API's retained timeline support the creation lower bound; never an exhaustive original ledger. Zero detected undercount does not establish correctness." };
  } else if (record.slug === "daily-issues-report") {
    const driver = originals.text(record.head, ".github/drivers/copilot_sdk_driver_sample_node.cjs");
    if (!driver.includes("session.sendAndWait({ prompt }") || !source.includes("issues_opened_7d")
      || !source.includes("issues_opened_30d")) throw new Error("Effective executor or source era unsupported");
    const cohortPacket = readPacket("daily-issues-cache");
    if (cohortPacket.runId !== record.runId || cohortPacket.artifactId !== 11490843117) throw new Error("Foreign retained cohort");
    const cohort = JSON.parse(cohortPacket.body), at = record.candidate.createdAt;
    const facts = cohortFacts(cohort, entities, at);
    for (const key of ["issues_opened_7d", "issues_opened_30d"]) {
      const match = new RegExp("`" + key + "`\\):\\s*([\\d,]+)").exec(body);
      if (!match) checks.push({ key, accepted: null, missing: "Required dated-count cell absent or unsupported" });
      else checks.push(...checkNumbers([{ key, value: Number(match[1].replaceAll(",", "")), quote: match[0] }], facts));
    }
    const job = JSON.parse(readPacket(`${record.slug}-agent-job`).body);
    const run = JSON.parse(readPacket(`${record.slug}-run`).body);
    if (job.id !== 112849617560 || job.name !== "Agent" || job.run_id !== record.runId || job.run_attempt !== run.run_attempt) {
      throw new Error("Foreign independent agent-job receipt");
    }
    const fetches = job.steps.filter(step => step.name === "Fetch issues" && step.conclusion === "success");
    if (fetches.length !== 1 || !iso(fetches[0].completed_at) || fetches[0].completed_at >= at) {
      throw new Error("Missing independent prefetch boundary");
    }
    const startFacts = cohortFacts(cohort, entities, fetches[0].completed_at);
    if (startFacts.issues_opened_7d !== facts.issues_opened_7d || startFacts.issues_opened_30d !== facts.issues_opened_30d) {
      throw new Error("Date-count threshold crosses execution interval; exact analysis time unavailable");
    }
    detail = { facts, corroboratedCreationIdentities: cohort.length,
      temporalRobustness: "Every count invariant between independently recorded prefetch completion and surviving Discussion creation; no invented exact analyzer timestamp.",
      unmeasured: "Retained cache is not signed pre-agent custody or proof all latest 1000 issues were analyzed. Only independently corroborated creation-window counts for this captured cohort; open/closed state, labels, themes, charts, semantic usefulness, complete fetch scope and actual computation execution remain unverified." };
  } else throw new Error("Foreign native monitoring workflow");
  const assessed = checks.filter(row => typeof row.accepted === "boolean").length;
  return { valid: true, eligible: checks.length, assessed, accepted: checks.filter(row => row.accepted === true).length,
    checks, detail, openingUndercountFloor: detail.openingUndercountFloor ?? null,
    repositoryOutcome: "Bounded factual report facet, not full goal completion or new delivered improvement.",
    fullAcceptance: null, contribution: null, costs: "not measured",
    outcomeExposure: record.authoring, reportRevision: "Observed surviving body, not original historical body.",
    missingGraph: "Deleted/edited-away reports and original Discussion revisions/comments are outside the inventory." };
}

export function monitoringModule(slug, contractSha256, compilerSha256) {
  if (hash(readFileSync(path.join(base, "contracts.json"))) !== contractSha256
    || hash(readFileSync(path.join(base, "compiler-lock.json"))) !== compilerSha256) {
    throw new Error("Frozen monitoring contract identity changed");
  }
  const lock = json(path.join(base, "compiler-lock.json"));
  for (const file of lock.files) {
    if (!file.path || file.path.startsWith("/") || file.path.split("/").includes("..")
      || hash(readFileSync(new URL(file.path, root))) !== file.sha256) throw new Error("Pinned native dependency changed");
  }
  const contract = json(path.join(base, "contracts.json")).records.find(row => row.slug === slug);
  if (!contract) throw new Error("Unknown frozen monitoring contract");
  const sample = accepted => ({ valid: true, eligible: accepted === 2 ? 2 : 4, assessed: 2, accepted,
    openingUndercountFloor: accepted === 2 ? 0 : 2 });
  const metrics = [
    { id: "native-fact-accuracy", name: contract.nativeLabel, role: "primary",
      formula: "100 * independently accepted / independently assessed facts in this one explicitly bounded native facet; not full report accuracy",
      direction: "increase", unit: "percent", presentation: { name: "Bounded factual accuracy", legendLabel: "Bounded fact accuracy", transform: "identity" } },
    { id: "native-fact-coverage", name: "Assessment coverage of eligible facet facts", role: "diagnostic",
      formula: "100 * independently assessed / eligible literal native facts; no eligible facts is null",
      direction: "increase", unit: "percent", presentation: { name: "Bounded assessment coverage", legendLabel: "Bounded fact coverage", transform: "identity" } },
    { id: "verified-native-facts", name: "Independently verified native facts", role: "diagnostic",
      formula: "accepted independent native facts, not reports or generated items",
      direction: "increase", unit: "facts", presentation: { name: "Verified native facts", legendLabel: "Verified native facts", transform: "identity" } },
  ];
  if (slug === "weekly-issue-summary") metrics.push({ id: "opening-undercount-floor",
    name: "Proven minimum omitted issue creations", role: "diagnostic", direction: "decrease", unit: "issues",
    formula: "surviving independently observed creations exceeding the claimed total; 0 means no proven lower-bound violation, not exact correctness",
    presentation: { name: "Minimum opening undercount", legendLabel: "Opening undercount floor", transform: "identity" } });
  const definition = {
    schemaVersion: 3, slug, repository, workflowName: slug, sourcePath: `.github/workflows/${slug}.md`,
    intent: { goal: contract.proposal.goal, acceptance: contract.acceptance, temporalAnchor: "workflow-adoption" },
    adoption: contract.adoption, evaluation: { mode: "attainment-only" },
    profile: { version: "native-monitoring-accuracy-v1", authoring: contract.authoring, revision,
      sourceEraRevision: contract.head, sourceBlob: contract.sourceBlob, originalCensusProposal: contract.proposal,
      currentPolicyBackdating: false, historicalCompatibility: "Only the retained run-head profile is evaluated; earlier periods are unmeasured.",
      baseline: "Actual source addition verified against its real parent, not first output or shallow boundary. No comparable outcome baseline reconstructed." },
    evidence: { key: `native-monitoring-accuracy-v1:${slug}`, repositories: [repository],
      opportunity: contract.population, filters: [contract.selection, "Only this retained run-head source era; current worker assignment requirements are not backdated."],
      collection: "Offline deterministic original-byte verification and native oracle; no model, Git, network, target execution, or current body/state backdating.",
      measurementKind: "interval", window: { durationDays: 7, cadenceDays: 7, maturationDays: 0 } },
    model: { architecture: "Source-specific bounded factual accuracy, separately retaining full goal and unknowns.",
      recommendation: "Not rated: no agreed native keep bar or matched costs.",
      presentation: { label: contract.nativeLabel, betterLabel: "Higher independently verified accuracy" } },
    summary: { nativeLabel: contract.nativeLabel }, metrics,
    safeguards: { fullGoal: contract.proposal.acceptance, fullAcceptance: "Unmeasured; bounded native facets do not replace the original census acceptance.",
      attribution: contract.attribution, costs: "Not measured", limitations: contract.limitations },
    validationExamples: { targetAttained: sample(2), targetMissed: sample(0), missing: {},
      malformed: { ...sample(1), accepted: 3 } },
  };
  const collectBatch = async requests => {
    if (!Array.isArray(requests)) throw new Error("Expected native observation requests");
    const originals = readOriginals();
    const discovery = json(path.join(base, "discovery.json"));
    const record = discovery.records.find(row => row.slug === slug);
    const { index, entities } = readOutputHistory(path.join(base, "issue-history"));
    if (!record || !index.complete || index.repositoryId !== 1036865607 || index.until !== cutoff) {
      throw new Error("Incomplete or foreign independent issue ledger");
    }
    const reportObservedAt = readPacket(`${slug}-discussion-page`).observedAt;
    for (const closure of [record.closure, record.frozenClosure]) {
      const head = closure === record.closure ? record.head : revision;
      for (const entry of closure) {
        const native = originals.resolve(head, entry.path);
        if (entry.absent ? native !== null : native?.oid !== entry.oid
          || !entry.absent && hash(originals.text(head, entry.path)) !== entry.sha256) {
          throw new Error("Source/import/executor closure changed");
        }
      }
    }
    if (originals.commit(record.adoption).parents[0] !== record.parent
      || originals.resolve(record.parent, definition.sourcePath)
      || !originals.resolve(record.adoption, definition.sourcePath)
      || originals.resolve(record.parent, `.github/workflows/${slug}.lock.yml`)
      || !originals.resolve(record.adoption, `.github/workflows/${slug}.lock.yml`)) {
      throw new Error("Invalid native source/compiled addition");
    }
    let measurement;
    return requests.map(request => {
      if (![request.windowStart, request.windowEnd, request.observedAt].every(iso)
        || request.windowStart >= request.windowEnd || request.observedAt < request.windowEnd
        || request.windowEnd > cutoff || request.repository && request.repository !== repository) {
        throw new Error("Invalid frozen native observation request");
      }
      const provenance = [{ repository, kind: "immutable-intent-and-native-source", ref: `git:${record.head}:${contract.sourceBlob}` },
        { repository, kind: "observed-surviving-report-body",
          ref: `discussion:${record.candidate.id}:updated:${record.candidate.updatedAt}:observed:${reportObservedAt}` }];
      const included = record.candidate.createdAt >= request.windowStart && record.candidate.createdAt < request.windowEnd;
      if (!included) return { evidence: { valid: false, missingReason: "No assessed report in this period; unexamined output/history is not zero or completed coverage.",
        fullAcceptance: null, contribution: null, costs: "not measured" }, provenance };
      measurement ??= inspectMonitoringReport(record, originals, entities);
      return { evidence: structuredClone(measurement), provenance, commit: record.head };
    });
  };
  return { definition, collectBatch, scoreMetric: scoreMonitoringMetric };
}
