import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gitEvidence } from "../.github/skills/add-operational-value/scripts/git-evidence.mjs";
import { readOutputHistory } from "../.github/skills/add-operational-value/scripts/collect-output-history.mjs";
import { readCensusJson, writeCensusJson } from "./operational-value-census-io.mjs";

const sha256 = filename => createHash("sha256").update(readFileSync(filename)).digest("hex");
export function authorNativeGoSourceFunctions(historyDirectory, cache, refreshUnpublished = false) {
  const { index } = readOutputHistory(historyDirectory);
  const native = readCensusJson("docs/operational-value/proof/go-source-lifetime/native-history.json.gz");
  if (native.complete !== true || native.repository !== index.repository || native.revision !== index.sourceRevision
    || native.collectorSha256 !== sha256("scripts/measure-go-native-history.mjs")) throw new Error("Native lifetime evidence not ready");
  const git = gitEvidence(index.repository, cache).git;
  const candidates = [
    { workflowId: "tidy", workflowName: "Tidy", facet: "exact-gofmt", graphDirectory: "tidy-lifetime",
      adopted: "bfbe18e6d2c20ee200c980655a041bad6cef28dc", baseline: "a8d355a6f241ef8de1e2ce98f691b1d823427270",
      goal: "Keep code formatted and clean through conservative formatting and lint repairs.",
      acceptance: "Partial facet: existing non-generated Go files become the exact canonical gofmt output without other source edits. Count signed repairs and exact reversals; JavaScript formatting, other lint rules, behavior and full tests remain separate." },
    { workflowId: "architecture-guardian", workflowName: "Architecture Guardian", facet: "go-file-blocker",
      graphDirectory: "architecture-guardian", adopted: "559b2b35135e58298a50c265fbd1cba60a019cd7",
      baseline: "78968004568b2f0fdbf08f088a7dcb1a87d6ee9a",
      goal: "Detect structural violations before they accumulate and enable corrective repository improvements.",
      acceptance: "Partial facet: reduce the non-generated, non-test Go file population above the frozen default 1000-newline blocker boundary. New blockers and reversals offset reductions; syntax, behavior, JavaScript, functions, exports, import cycles and other configured thresholds remain separate." },
  ];
  const date = revision => new Date(git(["show", "--no-patch", "--format=%cI", revision]).trim()).toISOString().replace(".000Z", "Z");
  const contracts = candidates.map(candidate => {
    const workflow = index.workflows.find(row => row.id === candidate.workflowId);
    if (!workflow || git(["diff-tree", "--no-commit-id", "--name-status", "-r",
      candidate.baseline, candidate.adopted, "--", workflow.path]).trim() !== `A\t${workflow.path}`) {
      throw new Error("Source introduction is not an independently verified file addition");
    }
    const source = git(["show", `${candidate.adopted}:${workflow.path}`]);
    if (!source.includes(candidate.facet === "exact-gofmt" ? "make fmt" : "1000")) throw new Error("Native facet missing from adoption intent");
    const { adopted, baseline, ...metadata } = candidate;
    return { ...metadata, repository: index.repository, sourceRevision: index.sourceRevision,
      sourceGitBlob: workflow.gitBlob, until: index.until,
      adoption: { commit: adopted, adoptedAt: date(adopted), baselineCommit: baseline, baselineAt: date(baseline) },
      nativeModelSha256: sha256("scripts/native-go-source-value.mjs"), goModelSha256: sha256("scripts/native-go-measures.mjs"),
      oracleSha256: native.oracleSha256, collectorSha256: native.collectorSha256 };
  });
  for (const contract of contracts) {
    const file = `docs/operational-value/proof/functions/${contract.workflowId}.mjs`;
    const text = `import { nativeGoSourceModule } from "../../../../scripts/native-go-source-value.mjs";\n\nexport const { definition, collectBatch, scoreMetric } = nativeGoSourceModule(${JSON.stringify(contract, null, 2)});\n`;
    if (existsSync(file) && readFileSync(file, "utf8") !== text && (!refreshUnpublished
      || existsSync(`docs/operational-value/proof/reports/github-gh-aw/${contract.workflowId}-timeline.json`))) {
      throw new Error("Refusing to change an evaluated source function");
    }
    writeFileSync(file, text);
  }
  writeCensusJson("docs/operational-value/proof/go-source-lifetime/contracts.json", contracts);
  return contracts;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const refresh = args[0] === "--refresh-unpublished";
  if (refresh) args.shift();
  if (args.length !== 2) throw new Error("usage: author-native-go-source-functions.mjs [--refresh-unpublished] OUTPUT_HISTORY BARE_CACHE");
  console.log(JSON.stringify({ functions: authorNativeGoSourceFunctions(...args, refresh).length }));
}
