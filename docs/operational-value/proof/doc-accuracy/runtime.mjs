import path from "node:path";
import { archive, base, contract, iso, readJson, sha256, verifyCompiler } from "./objects.mjs";
import { applicable, referenceRepairs } from "./checker.mjs";
import { readFileSync } from "node:fs";
import { factualRepairs } from "./factual.mjs";
import { publicOriginals } from "./public-custody.mjs";

const evidenceShape = value => value && value.schemaVersion === 1
  && ["complete", "partial", "missing"].includes(value.coverageStatus)
  && ["semanticAccepted", "referenceRepairs", "factualRepairs", "linkedRepairs"].every(key =>
    value[key] === null || Number.isSafeInteger(value[key]) && value[key] >= 0);
const display = (id, name, role, unit) => ({ id, name, role, unit, direction: "increase",
  formula: `Independently verified ${name.toLowerCase()} in this non-overlapping interval; unknown remains null.`,
  presentation: { name, legendLabel: name, transform: "identity" } });
const example = n => ({ schemaVersion: 1, coverageStatus: "complete",
  semanticAccepted: n, referenceRepairs: n, factualRepairs: n, linkedRepairs: n });
const secondContract = readJson(path.join(base, "contract-v2.json"));

function inScope(slug, file) {
  const source = contract.sources[slug];
  return source.scope.some(prefix => file === prefix || prefix.endsWith("/") && file.startsWith(prefix))
    && !(source.excluded ?? []).includes(file) && /\.(?:md|mdx)$/.test(file);
}

export function assessChange(slug, change, originals) {
  const native = originals.commit(change.commit);
  if (native.parents[0] !== change.parent) throw new Error("Native parent mismatch");
  const source = `.github/workflows/${slug}.md`;
  const applicableEra = applicable(slug, originals.text(change.parent, source))
    && applicable(slug, originals.text(change.commit, source));
  const pairs = change.files.filter(file => inScope(slug, file)).map(file => {
    const before = originals.text(change.parent, file), after = originals.text(change.commit, file);
    if (before === null || after === null || before === after) return { file, assessed: false, repairs: [] };
    const exists = revision => target => {
      const entry = originals.resolve(revision, target);
      return entry !== null && ["100644", "100755"].includes(entry.mode);
    };
    const result = referenceRepairs(file, before, after, exists(change.parent), exists(change.commit));
    return { file, assessed: true, ...result };
  });
  const repairs = applicableEra ? pairs.flatMap(pair => pair.repairs) : [];
  const factual = applicableEra ? factualRepairs(slug, change, originals) : { records: [], rejected: [] };
  const factualFiles = change.files.filter(file => secondContract.facets[slug].scope.includes(file)
    && originals.text(change.parent, file) !== null && originals.text(change.commit, file) !== null);
  return { commit: native.oid, parent: change.parent, at: native.at, applicableEra,
    assessedFiles: pairs.filter(pair => pair.assessed).length,
    factualAssessedFiles: factualFiles.length,
    factual, repairs, pairs, candidateNumbers: change.candidateNumbers ?? [],
    attribution: "Discovery candidates only; original creator, graph and execution custody not established." };
}

export function createFunction(slug) {
  if (!Object.hasOwn(contract.sources, slug)) throw new Error("Unknown documentation workflow");
  const plan = readJson(path.join(base, "plan.json"));
  const source = contract.sources[slug], addition = plan.additions.find(item => item.slug === slug);
  const native = archive();
  const added = native.commit(addition.commit);
  for (const extension of ["md", "lock.yml"]) {
    const file = `.github/workflows/${slug}.${extension}`;
    if (added.parents[0] !== addition.parent || native.resolve(addition.parent, file) !== null
      || native.resolve(addition.commit, file) === null) throw new Error("Invalid adoption proof");
  }
  const definition = {
    schemaVersion: 3, slug, repository: contract.repository, workflowName: slug,
    sourcePath: `.github/workflows/${slug}.md`,
    intent: { goal: source.goal, acceptance: source.strict, temporalAnchor: "workflow-adoption" },
    adoption: { commit: addition.commit, adoptedAt: added.at, baselineCommit: null, baselineAt: null },
    evaluation: { mode: "attainment-only" },
    evidence: { key: `${secondContract.version}:${slug}`, repositories: [contract.repository],
      opportunity: `${source.partial} Separately: ${secondContract.facets[slug].rule}`,
      filters: [source.historicalApplicability, contract.assessment, secondContract.authoringSequence],
      collection: "Replay hash-verified original Git objects with a deterministic local-reference oracle. Bounded selected cases are not exhaustive history.",
      measurementKind: "interval", window: { durationDays: 7, cadenceDays: 7, maturationDays: 0 } },
    model: { architecture: "Original source and parent/child trees -> explicit reference transitions -> native interval quantities",
      recommendation: "Not rated; no native keep bar or cost evidence.",
      presentation: { label: "Documentation accuracy", betterLabel: "More verified repairs" } },
    summary: { nativeLabel: "repairs, with full semantic acceptance separate" },
    metrics: [
      display("semanticAccepted", "Full gaps resolved", "primary", "fully verified documentation gaps"),
      display("referenceRepairs", "Local refs repaired", "diagnostic", contract.partialRules.unit),
      display("factualRepairs", "Factual contract repairs", "diagnostic", secondContract.facets[slug].unit),
      display("linkedRepairs", "Workflow-linked repairs", "diagnostic", contract.partialRules.unit),
    ],
    signal: { metricId: "factualRepairs", basis: "repository-outcome" },
    validationExamples: { targetAttained: example(1), targetMissed: example(0),
      missing: { schemaVersion: 1, coverageStatus: "missing", semanticAccepted: null, referenceRepairs: null, factualRepairs: null, linkedRepairs: null },
      malformed: { schemaVersion: 1, coverageStatus: "complete", semanticAccepted: -1, referenceRepairs: -1, factualRepairs: -1, linkedRepairs: -1 } },
    sourceIdentity: { repositoryId: contract.repositoryId, revision: contract.frozenRevision, blob: source.blob },
    assessment: secondContract.authoringSequence,
    missingSafeguards: contract.partialRules.safeguards,
  };
  const collectBatch = async requests => {
    if (!Array.isArray(requests)) throw new TypeError("Collector requires an array");
    verifyCompiler();
    const originals = archive();
    const publicEvidence = publicOriginals();
    if (originals.resolve(contract.frozenRevision, definition.sourcePath)?.oid !== source.blob) {
      throw new Error("Frozen source mutation");
    }
    const fingerprints = Object.fromEntries(["contract-v1.json", "contract-v2.json", "checker.mjs", "factual.mjs", "runtime.mjs",
      "public-custody.mjs", "public/manifest.json", "compiler-lock.json", "plan.json", "originals.json"]
      .map(file => [file, sha256(readFileSync(path.join(base, file)))]));
    const changes = plan.changes.filter(change => change.workflows.includes(slug));
    for (const change of changes) {
      const metadata = publicEvidence.originals.get(`repos/github/gh-aw/pulls/${change.candidateNumbers[0]}`)?.body;
      if (metadata?.merge_commit_sha !== change.commit) throw new Error("Native change does not match original PR identity");
    }
    const cases = changes.map(change => assessChange(slug, change, originals));
    const seen = new Set();
    for (const item of cases.toSorted((a, b) => a.at.localeCompare(b.at))) {
      item.repairs = item.repairs.filter(repair => {
        const key = JSON.stringify([repair.file, repair.oldTarget, repair.newTarget]);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      item.factual.records = item.factual.records.filter(record => {
        const key = JSON.stringify([record.file, record.kind, record.identity]);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }
    return requests.map(request => {
      if (!request || !["observedAt", "windowStart", "windowEnd"].every(key => iso(request[key]))
        || request.windowStart >= request.windowEnd || request.windowEnd > request.observedAt
        || request.observedAt > contract.cutoff
        || request.repository !== undefined && request.repository !== contract.repository) {
        throw new TypeError("Invalid request scope, period or frozen clock");
      }
      const selected = cases.filter(item => item.at >= request.windowStart && item.at < request.windowEnd);
      const assessed = selected.filter(item => item.applicableEra && item.assessedFiles > 0);
      const factualAssessed = selected.filter(item => item.applicableEra && item.factualAssessedFiles > 0);
      const repairs = assessed.flatMap(item => item.repairs);
      return { evidence: {
        schemaVersion: 1, coverageStatus: assessed.length || factualAssessed.length ? "partial" : "missing",
        semanticAccepted: null, referenceRepairs: assessed.length ? repairs.length : null,
        factualRepairs: factualAssessed.length ? factualAssessed.reduce((sum, item) => sum + item.factual.records.length, 0) : null,
        linkedRepairs: null,
        eligibleCount: selected.filter(item => item.applicableEra)
          .reduce((sum, item) => sum + Math.max(item.assessedFiles, item.factualAssessedFiles), 0),
        cases: selected, fingerprints,
        measurementKind: "interval", windowStart: request.windowStart, windowEnd: request.windowEnd,
        missingReason: assessed.length || factualAssessed.length ? "Bounded, independently verified reference/factual facets only; full semantic correctness and attribution unknown."
          : "No assessed source-applicable native case in retained bounded cohort; not zero delivery.",
        sourceIdentity: definition.sourceIdentity,
        evidenceDigest: sha256(JSON.stringify({ cases: selected, fingerprints })),
      }, provenance: [{ repository: contract.repository, kind: "git-source", ref: source.blob },
        ...selected.map(item => ({ repository: contract.repository, kind: "git-parent-child", ref: `${item.parent}..${item.commit}` }))],
      commit: selected.at(-1)?.commit ?? contract.frozenRevision };
    });
  };
  const scoreMetric = (id, evidence) => {
    if (!definition.metrics.some(metric => metric.id === id) || !evidenceShape(evidence)
      || evidence.coverageStatus === "missing") return null;
    return evidence[id];
  };
  return { definition, collectBatch, scoreMetric };
}
