import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { censusDigest, readCensusJson } from "./operational-value-census-io.mjs";

const count = value => Number.isSafeInteger(value) && value >= 0;
export const spellingPath = file => typeof file === "string"
  && /^docs\/src\/content\/[A-Za-z0-9_./-]+\.(?:md|mdx)$/.test(file)
  && !file.split("/").some(part => ["", ".", "..", "node_modules", ".git"].includes(part));

export function normalizeNativeSpellingReport(report, paths, root) {
  if (!Array.isArray(paths) || paths.length > 2000 || paths.some(file => !spellingPath(file))
    || new Set(paths).size !== paths.length || !Array.isArray(report?.issues) || report.issues.length > 1000000
    || !Array.isArray(report.error) || report.error.length || report.result?.errors !== 0
    || report.result?.files !== paths.length || report.result?.issues !== report.issues.length
    || report.result?.cachedFiles !== 0) throw new Error("Incomplete or malformed native CSpell report");
  const known = new Set(paths);
  const issues = report.issues.map(issue => {
    if (!issue || typeof issue.uri !== "string" || new URL(issue.uri).protocol !== "file:"
      || !count(issue.row) || !issue.row || !count(issue.col) || !issue.col
      || typeof issue.text !== "string" || !issue.text.length || issue.text.length > 256
      || typeof issue.isFlagged !== "boolean" || issue.issueType !== undefined) {
      throw new Error("Malformed native CSpell spelling issue");
    }
    const file = path.relative(root, fileURLToPath(issue.uri)).split(path.sep).join("/");
    if (!known.has(file)) throw new Error("Native CSpell issue escaped the frozen file cohort");
    return { path: file, row: issue.row, column: issue.col, word: issue.text, flagged: issue.isFlagged };
  });
  return { valid: true, complete: true, paths, filesChecked: paths.length, issues };
}

export function scanNativeSpelling(evidence) {
  if (evidence?.valid !== true || evidence.complete !== true || !Array.isArray(evidence.paths)
    || evidence.paths.length > 2000 || evidence.paths.some(file => !spellingPath(file))
    || new Set(evidence.paths).size !== evidence.paths.length || evidence.filesChecked !== evidence.paths.length
    || !Array.isArray(evidence.issues) || evidence.issues.length > 1000000) return null;
  const paths = new Set(evidence.paths), identities = new Set();
  let forbidden = 0;
  for (const issue of evidence.issues) {
    if (!issue || !paths.has(issue.path) || !count(issue.row) || !issue.row || !count(issue.column)
      || !issue.column || typeof issue.word !== "string" || !issue.word.length || issue.word.length > 256
      || typeof issue.flagged !== "boolean") return null;
    const key = JSON.stringify([issue.path, issue.row, issue.column, issue.word]);
    if (identities.has(key)) return null;
    identities.add(key);
    if (issue.flagged) forbidden++;
  }
  return { "native-findings": evidence.issues.length, "forbidden-word-findings": forbidden,
    "ordinary-unknown-findings": evidence.issues.length - forbidden };
}

export function scoreNativeSpelling(id, evidence) {
  if (!["native-findings", "forbidden-word-findings", "ordinary-unknown-findings"].includes(id)) {
    throw new Error("Unknown native spelling metric");
  }
  return scanNativeSpelling(evidence)?.[id] ?? null;
}

export function nativeSpellingModule(contract) {
  if (contract.interpreterSha256 !== createHash("sha256").update(readFileSync(import.meta.filename)).digest("hex")) {
    throw new Error("Frozen native spelling interpreter changed");
  }
  const example = issues => ({ valid: true, complete: true, filesChecked: 1,
    paths: ["docs/src/content/example.md"], issues: issues.map((flagged, i) =>
      ({ path: "docs/src/content/example.md", row: 1, column: i * 20 + 1, word: "missspellled", flagged })) });
  const metric = (id, role, name, label, formula) => ({ id, role, name, unit: "diagnostics", direction: "decrease", formula,
    presentation: { name, legendLabel: label, transform: "identity" } });
  return { definition: { schemaVersion: 3, slug: contract.workflowId, repository: contract.repository,
    workflowName: "Daily AstroStyleLite Markdown Spellcheck", sourcePath: contract.sourcePath,
    intent: { goal: "Reduce independently reported American English spelling diagnostics in the documentation.",
      acceptance: "Pinned CSpell 8.19.4 checks immutable Markdown/MDX with one frozen source-native configuration and technical dictionary. Ordinary unknown words count even when isFlagged is false; language correctness and workflow causation remain separate.",
      temporalAnchor: "workflow-adoption" },
    adoption: contract.adoption, evaluation: { mode: "attainment-only" },
    evidence: { key: "native-cspell-reference-policy-v1", repositories: [contract.repository],
      sourcePolicySha256: censusDigest(contract), tool: contract.tool,
      opportunity: "Every tracked regular Markdown/MDX file under docs/src/content/ at the weekly endpoint.",
      filters: ["Replay the same frozen current native dictionary/configuration across history, not historical npm installations or changing allowlists.",
        "Count all native spelling issues. isFlagged means forbidden-word status, not whether an ordinary unknown word is a diagnostic.",
        "Verify the source filter with native jq: its // operator defaults false as well as null, so ordinary unknown words remain counted.",
        "Internal document waivers remain native policy. Changed waiver policy makes that interval non-comparable, not a proven spelling repair.",
        "Native diagnostics are checker output under its native limits, not a count of linguistically proven misspellings.",
        "An absent configuration, source, runtime error or incomplete cohort is unknown, never a clean spellcheck.",
        "Pinned local Node/platform replay is not a reconstruction of historical hosted runs or attribution to this workflow."],
      collection: "Hash-verified immutable Git/LFS inputs, pinned dependency lock/tool files and normalized native JSON checker reports.",
      measurementKind: "snapshot", window: { durationDays: 7, cadenceDays: 7, maturationDays: 0 } },
    model: { architecture: "An isolated native checker reads retained source data without executing repository code.",
      recommendation: "Review native diagnostics, unknown/forbidden word classes and policy changes alongside actual spelling fixes.",
      presentation: { label: "Native documentation spelling", betterLabel: "Fewer native CSpell diagnostics under comparable policy" } },
    summary: { nativeLabel: "Native spelling diagnostics" },
    metrics: [
      metric("native-findings", "primary", "Native spelling diagnostics", "Native diagnostics", "Count every independently reported native spelling issue, including ordinary unknown words."),
      metric("forbidden-word-findings", "diagnostic", "Native forbidden-word diagnostics", "Forbidden words", "Count native issues explicitly marked isFlagged true by the checker."),
      metric("ordinary-unknown-findings", "diagnostic", "Native ordinary unknown-word diagnostics", "Ordinary unknown words", "Count native issues with isFlagged false; these are still included by the workflow's native jq filter."),
    ],
    validationExamples: { targetAttained: example([]), targetMissed: example([false, true]),
      missing: { valid: false }, malformed: { ...example([false]), filesChecked: "one" } } },
  scoreMetric: scoreNativeSpelling, collectBatch(requests) {
    const index = readCensusJson(`${contract.directory}/index.json`);
    const facts = readCensusJson(`${contract.directory}/facts.json.gz`,
      { maxDecodedBytes: 64 * 1024 * 1024, maxParts: 512 });
    if (!index.complete || index.contractSha256 !== censusDigest(contract) || index.factsSha256 !== censusDigest(facts)
      || index.repository !== contract.repository || index.sourceRevision !== contract.sourceRevision) {
      throw new Error("Retained native spelling evidence changed");
    }
    return requests.map(request => {
      if (request.repository && request.repository !== contract.repository) throw new Error("Native spelling repository mismatch");
      const state = facts.states.find(row => row.windowEnd === request.windowEnd);
      const prior = facts.states.find(row => row.windowEnd === request.windowStart);
      const evidence = state?.native ?? { valid: false, complete: false, paths: [], issues: [] };
      const known = scanNativeSpelling(evidence) !== null;
      const comparable = known && prior?.inlinePolicySha256 === state.inlinePolicySha256;
      return { evidence: { ...evidence, coverageStatus: comparable ? "complete" : known ? "partial" : "unknown",
        maturityStatus: "matured", eligibleCount: known ? evidence.filesChecked : null,
        inlinePolicySha256: state?.inlinePolicySha256 ?? null,
        missingReason: comparable ? null : known ? "Native findings are known; source-internal waiver continuity is not established for this interval."
          : "Complete native spellcheck evidence is unavailable.",
        fullGoalAcceptance: "not-measured", linguisticCorrectness: "not-measured",
        workflowCausation: "not-measured", costs: "not-measured" },
      provenance: [{ repository: contract.repository, kind: "immutable-workflow-source", ref: contract.sourceGitBlob },
        { repository: contract.repository, kind: "native-spelling-index", ref: censusDigest(index) }],
      commit: state?.commit ?? contract.sourceRevision };
    });
  } };
}
