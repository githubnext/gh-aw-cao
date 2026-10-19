import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { repository, revision } from "./collect-gh-aw-operational-evidence.mjs";
import { validateCensus } from "./measure-gh-aw-operational-value.mjs";
import { readCensusEvidence, writeCensusJson } from "./operational-value-census-io.mjs";

export function buildContracts(checkout, batches, evidence, activatedAt) {
  const sourceByPath = new Map(evidence.sources.map(source => [source.path, source]));
  const contracts = batches.flat().map(contract => {
    const source = sourceByPath.get(contract.path);
    if (!source) throw new Error(`Unknown source ${contract.path}`);
    const text = readFileSync(path.join(checkout, contract.path), "utf8");
    if (createHash("sha256").update(text).digest("hex") !== source.sha256) {
      throw new Error(`Source changed: ${contract.path}`);
    }
    const lines = text.split("\n");
    for (const citation of contract.grounding) {
      if (!lines.slice(citation.startLine - 1, citation.endLine).join("\n").includes(citation.quote)) {
        throw new Error(`Grounding does not match ${contract.path}:${citation.startLine}-${citation.endLine}`);
      }
    }
    const instrument = contract.path === ".github/workflows/stale-lock-files.yml" ? "git-lock-pair-guard"
      : contract.path === ".github/workflows/cgo.yml" ? "go-unit-test-events" : undefined;
    return { ...contract, ...(instrument && contract.designStatus === "candidate" ? { instrument } : {}),
      sourceSha256: source.sha256, sourceGitBlob: source.gitBlob,
      sourceUrl: `https://github.com/${repository}/blob/${revision}/${contract.path}` };
  }).sort((left, right) => left.path.localeCompare(right.path));
  const manifest = {
    schemaVersion: 1, repository, revision, contractActivatedAt: activatedAt,
    authoring: "Single assistant-authoring exercise partitioned across three agents and eight directly handled sources; not independently adjudicated.",
    interpretation: "Candidate contracts, not validated semantic gold. Unresolved goals deliberately have no executable outcome proxy.",
    historicalInterpretation: "Retrospective reconstruction under current candidate contracts; no workflow-adoption or causal claim.",
    contracts,
  };
  validateCensus(manifest, evidence);
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [checkout, batchDirectory, evidenceFile, output] = process.argv.slice(2);
  if (!checkout || !batchDirectory || !evidenceFile || !output || process.argv.length !== 6) {
    throw new Error("usage: node scripts/build-gh-aw-operational-contracts.mjs CHECKOUT BATCH_DIRECTORY EVIDENCE.json OUTPUT.json");
  }
  const batches = ["contracts-1.json", "contracts-2.json", "contracts-3.json", "contracts-parent.json"]
    .map(file => JSON.parse(readFileSync(path.join(batchDirectory, file), "utf8")));
  const result = buildContracts(checkout, batches, readCensusEvidence(evidenceFile),
    new Date().toISOString().replace(/\.\d{3}Z$/, "Z"));
  mkdirSync(path.dirname(output), { recursive: true });
  writeCensusJson(output, result);
  console.log(JSON.stringify({
    workflows: result.contracts.length,
    candidates: result.contracts.filter(contract => contract.designStatus === "candidate").length,
    unresolved: result.contracts.filter(contract => contract.designStatus === "needs-clarification").length,
  }));
}
