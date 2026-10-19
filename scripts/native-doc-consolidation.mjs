import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { commitFacts, readCustody } from "../docs/operational-value/proof/doc-consolidation/custody-reader.mjs";
import { digest, inspectClaudeBarrier, inspectConsolidation, inspectUnbloat } from "../docs/operational-value/proof/doc-consolidation/native-oracle.mjs";

export function inspectCases(custody) {
  return custody.archive.cases.map(item => {
    const facts = commitFacts(custody, item.commit);
    if (!facts || facts.parent !== item.parent) throw new Error("Native case parent mismatch");
    const files = item.files.map(file => {
      const before = custody.resolve(item.parent, file.path), after = custody.resolve(item.commit, file.path);
      return { path: file.path, before, after };
    });
    const support = (item.support ?? []).map(record => ({ path: record.path, ...custody.resolve(item.commit, record.path) }));
    const unbloatEligible = files.some(file => /^docs\/src\/content\/docs\/.+\.md$/.test(file.path)
      && !file.path.startsWith("docs/src/content/docs/blog/") && !file.path.endsWith("/frontmatter-full.md"));
    const consolidationEligible = files.some(file => file.path === "scratchpad/dev.md");
    const scopeMismatch = item.slug === "unbloat-docs" && !unbloatEligible
      || item.slug === "developer-docs-consolidator" && !consolidationEligible;
    const unavailable = files.some(file => file.before.status === "missing" || file.after.status === "missing");
    let native;
    if (scopeMismatch) native = { status: "ineligible", removed: null,
      reason: "Native change is outside frozen-source population; historical source-era target/exclusions differ and are not backdated." };
    else if (unavailable) native = { status: "missing", removed: null, reason: "Exact original before/after object missing" };
    else if (item.slug === "unbloat-docs") {
      const changed = files.filter(file => file.before.blob !== file.after.blob);
      const eligible = changed.filter(file => file.before.status === "present" && file.after.status === "present");
      const inspected = eligible.map(file => ({ path: file.path, ...inspectUnbloat(file.before.bytes, file.after.bytes, file.path) }));
      native = { status: "assessed", removed: inspected.reduce((sum, file) => sum + (file.status === "verified" ? file.removed : 0), 0),
        files: inspected, limitations: ["Zero means no accepted exact duplicate-removal case, not no semantic improvement."] };
    } else if (item.slug === "developer-docs-consolidator") {
      const inspected = inspectConsolidation(files.map(file => ({ path: file.path, before: file.before.bytes ?? null, after: file.after.bytes ?? null })));
      native = inspected.status === "missing" ? inspected : { ...inspected, status: "assessed",
        removed: inspected.status === "verified" ? inspected.removed : 0,
        limitations: ["Zero means no accepted lossless redundancy consolidation, not no developer-documentation improvement."] };
    } else if (item.slug === "claude-code-user-docs-review") native = inspectClaudeBarrier(files, support);
    else throw new Error("Unrecognized cohort workflow");
    return { id: item.id, slug: item.slug, ...facts, native,
      originalPaths: files.map(file => ({ path: file.path, before: file.before.blob ?? file.before.status, after: file.after.blob ?? file.after.status })),
      attribution: { status: "unknown", reason: "No protected source-linked creation receipt; editable markers remain discovery candidates." },
      fullGoal: null, semanticAccuracy: null, usability: null };
  });
}

export function nativeReceipt() {
  const custody = readCustody();
  return { schemaVersion: 1, kind: "bounded-native-doc-consolidation", custodySha256: custody.sha256,
    contractSha256: digest(readFileSync(new URL("../docs/operational-value/proof/doc-consolidation/contracts-v1.json", import.meta.url))),
    cutoff: custody.archive.cutoff, discovery: { partitions: 346, entities: 58048, complete: true,
      limitation: "Issue/PR discovery excludes Discussions, comments, deleted/transferred objects and edited-away markers." },
    cases: inspectCases(custody),
    conclusion: "Bounded native cases only; no complete repository-period or full-goal attainment is inferred." };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const receipt = nativeReceipt();
  const serialized = `${JSON.stringify(receipt, null, 2)}\n`;
  writeFileSync(new URL("../docs/operational-value/proof/doc-consolidation/native-receipt.json", import.meta.url), serialized);
  console.log(serialized);
}
