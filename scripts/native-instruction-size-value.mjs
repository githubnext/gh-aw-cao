import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { censusDigest, readCensusJson } from "./operational-value-census-io.mjs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
export const instructionLineLimit = 400;

export function instructionSizePolicy(source) {
  if (typeof source !== "string") return null;
  const body = source.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/)?.[1];
  if (!body || !/^wc -l \.github\/aw\/\*\.md\r?$/m.test(body)) return null;
  const rules = [...body.matchAll(/^- any file over `(\d{1,6})` lines must be split or rewritten before the task is considered complete\r?$/gm)];
  return rules.length === 1 ? { limit: Number(rules[0][1]), scope: ".github/aw/*.md" } : null;
}

export function scanInstructionSizes(evidence) {
  if (evidence?.valid !== true || !Array.isArray(evidence.files)
    || evidence.files.length > 1000 || new Set(evidence.files.map(file => file?.path)).size !== evidence.files.length
    || evidence.files.some(file => typeof file?.path !== "string" || !/^\.github\/aw\/[^./\r\n][^/\r\n]*\.md$/.test(file.path)
      || !Number.isSafeInteger(file.lines) || file.lines < 0 || file.lines > 4 * 1024 * 1024)) return null;
  return {
    "excess-instruction-lines": evidence.files.reduce((sum, file) => sum + Math.max(0, file.lines - instructionLineLimit), 0),
    "oversized-instruction-files": evidence.files.filter(file => file.lines > instructionLineLimit).length,
    eligible: evidence.files.length,
  };
}

export function scoreInstructionSize(id, evidence) {
  if (!["excess-instruction-lines", "oversized-instruction-files"].includes(id)) throw new Error("Unknown instruction-size metric");
  return scanInstructionSizes(evidence)?.[id] ?? null;
}

export function nativeInstructionSizeModule(contract) {
  if (contract.interpreterSha256 !== hash(readFileSync(import.meta.filename))
    || contract.lineLimit !== instructionLineLimit) throw new Error("Frozen instruction-size predicate changed");
  const example = lines => ({ valid: true, files: [{ path: ".github/aw/syntax.md", lines }] });
  const metric = (id, role, name, label, unit, formula) => ({ id, role, name, formula, unit, direction: "decrease",
    presentation: { name, legendLabel: label, transform: "identity" } });
  return { definition: { schemaVersion: 3, slug: contract.workflowId, repository: contract.repository,
    workflowName: "Instructions Janitor", sourcePath: contract.sourcePath,
    intent: { goal: "Keep direct Markdown instruction files within the source's explicit 400-line size-audit ceiling.",
      acceptance: "At each immutable mainline endpoint, native wc -l finds no direct .github/aw/*.md file over 400 newline characters. This is the hard size-audit facet, not the stricter per-file layout targets or full instruction quality.",
      temporalAnchor: "workflow-adoption" },
    adoption: contract.adoption, evaluation: { mode: "attainment-only" },
    evidence: { key: "native-instruction-size-audit-v1", repositories: [contract.repository],
      sourcePolicySha256: censusDigest(contract),
      opportunity: "All direct regular .github/aw/*.md files at each retained immutable mainline endpoint.",
      filters: ["Use native wc -l newline counts, including CRLF and unterminated-file semantics, not rendered lines or words.",
        "The explicit audit says over 400, so exactly 400 is not over this ceiling; stricter layout targets remain separate.",
        "Do not count nested files, non-Markdown files or symlink text as direct instruction-file contents.",
        "A missing directory, unsupported entry or unsupported source policy is not established compliance.",
        "Retain current-reference quantities through older intent eras but require the same explicit policy throughout compared windows.",
        "Show the changing file population; deleting files or moving content does not establish preserved information.",
        "Snapshots are repository conditions, not fresh workflow deliveries. Accuracy, duplication, content preservation, attribution and costs remain unmeasured."],
      collection: "Retained immutable Git trees and blobs, native wc binary identity and probes, weekly/adoption/cutoff states and source-policy history.",
      measurementKind: "snapshot", window: { durationDays: 7, cadenceDays: 7, maturationDays: 0 } },
    model: { architecture: "Native newline counts from immutable direct-child instruction blobs, with explicit policy continuity.",
      recommendation: "Inspect excess lines and file population separately; review content preservation and product accuracy independently.",
      presentation: { label: "Instruction size-audit ceiling", betterLabel: "Fewer instruction lines over the ceiling" } },
    summary: { nativeLabel: "Instruction lines over the 400-line audit ceiling" },
    metrics: [
      metric("excess-instruction-lines", "primary", "Instruction lines over the audit ceiling", "Excess instruction lines", "lines",
        "Sum max(0, native wc -l count minus 400) across direct regular .github/aw/*.md files."),
      metric("oversized-instruction-files", "diagnostic", "Instruction files over the audit ceiling", "Oversized files", "files",
        "Count direct regular .github/aw/*.md files whose native wc -l count exceeds 400."),
    ],
    validationExamples: { targetAttained: example(400), targetMissed: example(425),
      missing: { valid: false }, malformed: { valid: true, files: [{ path: ".github/aw/syntax.md", lines: -1 }] } } },
  scoreMetric: scoreInstructionSize, collectBatch(requests) {
    const index = readCensusJson(`${contract.directory}/index.json`), facts = readCensusJson(`${contract.directory}/facts.json.gz`);
    if (!index.complete || index.contractSha256 !== censusDigest(contract) || index.factsSha256 !== censusDigest(facts)
      || index.sourceRevision !== contract.sourceRevision || index.until !== contract.until) throw new Error("Instruction-size evidence changed");
    return requests.map(request => {
      if (request.repository && request.repository !== contract.repository) throw new Error("Instruction-size repository mismatch");
      const state = facts.states.find(item => item.windowEnd === request.windowEnd);
      const evidence = { valid: state?.known === true, files: state?.files ?? null }, scan = scanInstructionSizes(evidence);
      const policy = item => item?.policy?.limit === instructionLineLimit && item.policy.scope === ".github/aw/*.md";
      const prior = facts.policies.filter(item => item.at <= request.windowStart).at(-1);
      const changes = facts.policies.filter(item => item.at > request.windowStart && item.at <= request.windowEnd);
      const comparable = scan?.eligible > 0 && policy(state) && policy(prior) && changes.every(policy);
      return { evidence: { ...evidence, coverageStatus: comparable ? "complete" : scan ? "partial" : "unknown",
        maturityStatus: "matured", eligibleCount: scan?.eligible ?? null, sourcePolicy: state?.policy ?? null,
        missingReason: comparable ? null : state?.reason ?? "Absent population or unestablished source-policy continuity.",
        layoutTargets: "not-measured", contentPreservation: "not-measured", productAccuracy: "not-measured",
        duplication: "not-measured", workflowCausation: "not-measured", costs: "not-measured", fullGoalAcceptance: "not-measured" },
      provenance: [{ repository: contract.repository, kind: "native-instruction-size-index", ref: censusDigest(index) }],
      commit: state?.commit ?? contract.sourceRevision };
    });
  } };
}
