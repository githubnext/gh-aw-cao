import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { censusDigest, readCensusJson, writeCensusJson } from "./operational-value-census-io.mjs";
import { multiPrScope } from "./collect-smoke-multi-pr-value.mjs";
import { multiPrFixture, missedMultiPrFixture } from "./smoke-multi-pr-fixtures.mjs";
import { scanMultiPrEvidence } from "./native-smoke-multi-pr-value.mjs";
import { formatMultiPrWrapper } from "./format-smoke-multi-pr-value.mjs";

export function finalizeMultiPrValue() {
  const directory = multiPrScope.directory, frozen = readCensusJson(`${directory}/contract.json`);
  const deliveries = readCensusJson(`${directory}/deliveries.json.gz`);
  const additional = readCensusJson(`${directory}/additional-protected-jobs.json.gz`);
  const review = readCensusJson(`${directory}/source-review.json.gz`);
  if (review.frozenContractSha256 !== censusDigest(frozen) || deliveries.contractSha256 !== censusDigest(frozen)
    || deliveries.rows.length !== 2365 || !deliveries.opportunityInventoryComplete) throw new Error("Unreconciled native source/receipt inventory");
  const reviewedHosts = review.hostReviews.map(row => row.profile);
  const first = deliveries.profiles.find(row => reviewedHosts.includes(row.id));
  if (!first) throw new Error("No independently reviewed native host profile");
  const { id, ...profile } = first;
  if (censusDigest(profile) !== id) throw new Error("Native host profile changed");
  const contract = { ...frozen, frozenContractSha256: censusDigest(frozen), reviewedHosts,
    artifactProducers: Object.fromEntries(review.hostReviews.map(row => [row.profile, row.artifactProducer])),
    interpreterSha256: createHash("sha256").update(readFileSync("scripts/native-smoke-multi-pr-value.mjs")).digest("hex"),
    sourceReviewSha256: censusDigest(review) };
  const fixture = multiPrFixture(contract, profile);
  contract.validationExamples = { targetAttained: fixture.evidence, targetMissed: missedMultiPrFixture(fixture.evidence),
    missing: { valid: false }, malformed: { valid: true, observations: "not-an-array" } };
  const summary = scanMultiPrEvidence({ valid: true, observations: deliveries.rows }, contract);
  if (!(summary["verified-payload-deliveries"] >= 2) || !(summary["verified-crlf-deliveries"] >= 1)) {
    throw new Error("Established native proofs disappeared; do not substitute fixtures or a successful run");
  }
  const modulePath = "docs/operational-value/proof/functions/smoke-multi-pr.mjs";
  const wrapper = formatMultiPrWrapper(`import { nativeMultiPrModule } from "../../../../scripts/native-smoke-multi-pr-value.mjs";\n\nexport const { definition, collectBatch, scoreMetric } = nativeMultiPrModule(${JSON.stringify(contract, null, 2)});\n`);
  if (existsSync(modulePath) && readFileSync(modulePath, "utf8") !== wrapper) {
    const previous = readFileSync(modulePath, "utf8"), previousHash = createHash("sha256").update(previous).digest("hex");
    const archive = readCensusJson(`${directory}/versions/${previousHash}/archive.json.gz`);
    const previousContract = JSON.parse(previous.match(/nativeMultiPrModule\((\{[\s\S]*\})\);\s*$/)?.[1] ?? "null");
    const preservedModule = archive.files?.find(row => row.path === modulePath);
    const preservedInterpreter = archive.files?.find(row => row.path === "scripts/native-smoke-multi-pr-value.mjs");
    if (archive.functionSha256 !== previousHash || previousContract?.frozenContractSha256 !== contract.frozenContractSha256
      || Buffer.from(preservedModule?.content ?? "", "base64").toString() !== previous
      || createHash("sha256").update(Buffer.from(preservedInterpreter?.content ?? "", "base64")).digest("hex") !== previousContract.interpreterSha256) {
      throw new Error("Preserve the complete native predecessor before extending its unchanged goal contract");
    }
  }
  mkdirSync(path.dirname(modulePath), { recursive: true });
  writeFileSync(modulePath, wrapper);
  const parts = [];
  for (let offset = 0; offset < deliveries.rows.length; offset += 100) {
    const rows = deliveries.rows.slice(offset, offset + 100), file = `observations-${String(parts.length + 1).padStart(3, "0")}.json.gz`;
    writeCensusJson(`${directory}/${file}`, rows);
    parts.push({ file, count: rows.length, sha256: censusDigest(rows) });
  }
  const index = { schemaVersion: 1, complete: true, meaningOfComplete: "All retained opportunity rows are present and digest-checked; not a claim of complete outcome/eligibility receipt coverage.",
    acquisitionOpen: deliveries.acquisitionOpen || additional.acquisitionOpen,
    acquisitionComplete: deliveries.complete && !additional.acquisitionOpen,
    workflowId: multiPrScope.workflowId, repository: multiPrScope.repository, sourceRevision: multiPrScope.sourceRevision,
    until: multiPrScope.until, sourceGitBlob: multiPrScope.sourceGitBlob, observations: deliveries.rows.length,
    contractSha256: censusDigest(contract), frozenContractSha256: censusDigest(frozen),
    sourceReviewSha256: censusDigest(review), deliveriesSha256: censusDigest(deliveries), parts,
    originals: Object.fromEntries(["sources.json.gz", "host-sources.json.gz", "inventory.json.gz", "receipts.json.gz", "deliveries.json.gz", "additional-protected-jobs.json.gz"]
      .map(file => [file, censusDigest(readCensusJson(`${directory}/${file}`))])),
    primaryMetricId: "verified-payload-deliveries", ...summary,
    coverageStatus: summary["unassessed-payload-cases"] || deliveries.acquisitionOpen || additional.acquisitionOpen ? "partial" : "complete",
    countsMeaning: "Retained candidate executions/cases are an inventory upper bound, not proof that every skipped trigger was eligible. Eligibility gaps remain explicit.",
    readinessGuard: "Import the frozen module, verify this index/partitions and source/target Git objects, and require at least one real non-null independent native payload value. Never count an all-unknown plot, run/PR count or fixture-only proof as measured.",
    additionalProtectedReceipts: { acquisitionOpen: additional.acquisitionOpen, httpStatusCounts: additional.httpStatusCounts ?? {},
      unavailableLogs: additional.rows.filter(row => row.availability === "http-404-or-410").length },
    openRequirements: ["Missing protected-operation, original-payload and target-byte receipts remain explicit outcome gaps; acquisition status is separate.",
      "Expired/unretained original receipts cannot be replaced by mutable PR bodies or present-day heads.",
      "Full two-PR and protected summary-comment acceptance, complete eligibility coverage, costs and sole attribution are not established."],
  };
  writeCensusJson(`${directory}/index.json`, index);
  writeCensusJson(`${directory}/contracts.json`, [contract]);
  return { modulePath, sha256: createHash("sha256").update(wrapper).digest("hex"), ...summary,
    acquisitionOpen: index.acquisitionOpen, coverageStatus: index.coverageStatus };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  console.log(JSON.stringify(finalizeMultiPrValue()));
}
