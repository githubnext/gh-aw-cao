import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readOutputHistory } from "../.github/skills/add-operational-value/scripts/collect-output-history.mjs";
import { writeCensusJson } from "./operational-value-census-io.mjs";

export function authorNativeIssueFunctions(historyDirectory, refreshUnpublished = false) {
  const { index } = readOutputHistory(historyDirectory);
  const candidates = [
    { workflowId: "auto-triage-issues", workflowName: "Auto-Triage Issues", requireUnassigned: false,
      adopted: "049ab50b16190efa4545c6d95a4adedc94b0697d",
      goal: "Improve issue discoverability and reduce the repository's unlabeled-issue percentage below 5% through appropriate classification." },
    { workflowId: "issue-triage-agent", workflowName: "Issue Triage Agent", requireUnassigned: true,
      adopted: "b5d1b90b2e1ab16c567d0838ee8824a7aa5ba6dc",
      goal: "Categorize open unlabeled unassigned issues with appropriate allowed labels and an explanatory comment." },
  ];
  const contracts = candidates.map(({ adopted, ...candidate }) => {
    const workflow = index.workflows.find(row => row.id === candidate.workflowId);
    if (!workflow) throw new Error("Issue workflow is not in the frozen source inventory");
    const api = endpoint => JSON.parse(execFileSync("gh", ["api", endpoint], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }));
    const receipt = api(`repos/${index.repository}/commits/${adopted}`);
    const baseline = receipt.parents[0]?.sha;
    for (const file of [workflow.path, workflow.path.replace(/\.md$/, ".lock.yml")]) {
      if (!receipt.files.some(row => row.filename === file && row.status === "added")) {
        throw new Error("Source and compiled workflow adoption must both be actual file additions");
      }
    }
    const source = execFileSync("gh", ["api", "-H", "Accept: application/vnd.github.raw+json",
      `repos/${index.repository}/contents/${workflow.path}?ref=${adopted}`], { encoding: "utf8" });
    if (!source.toLowerCase().includes("unlabeled")) throw new Error("Label-coverage facet absent from adoption intent");
    const parent = api(`repos/${index.repository}/commits/${baseline}`);
    return { ...candidate, repository: index.repository, sourceRevision: index.sourceRevision,
      sourceGitBlob: workflow.gitBlob, until: index.until,
      acceptance: `Partial facet: count native first-label coverage gains minus last-label withdrawals on open ${candidate.requireUnassigned ? "unassigned " : ""}issues. Replay historical eligibility, not current labels backdated. Classification correctness, component completeness, explanatory comments, workflow attribution and the whole-repository percentage target remain unmeasured.`,
      adoption: { commit: adopted, adoptedAt: receipt.commit.committer.date,
        baselineCommit: baseline, baselineAt: parent.commit.committer.date },
      adoptionSourceSha256: createHash("sha256").update(source).digest("hex"),
      nativeModelSha256: createHash("sha256").update(readFileSync("scripts/native-issue-condition-value.mjs")).digest("hex") };
  });
  for (const contract of contracts) {
    const file = `docs/operational-value/proof/functions/${contract.workflowId}.mjs`;
    const text = `import { nativeIssueConditionModule } from "../../../../scripts/native-issue-condition-value.mjs";\n\nexport const { definition, collectBatch, scoreMetric } = nativeIssueConditionModule(${JSON.stringify(contract, null, 2)});\n`;
    if (existsSync(file) && readFileSync(file, "utf8") !== text && (!refreshUnpublished
      || existsSync(`docs/operational-value/proof/reports/github-gh-aw/${contract.workflowId}-timeline.json`))) {
      throw new Error("Refusing to replace an existing frozen issue function");
    }
    writeFileSync(file, text);
  }
  mkdirSync("docs/operational-value/proof/issue-condition-history", { recursive: true });
  writeCensusJson("docs/operational-value/proof/issue-condition-history/contracts.json", contracts);
  return contracts;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), refresh = args[0] === "--refresh-unpublished";
  if (refresh) args.shift();
  const [history, ...extra] = args;
  if (!history || extra.length) throw new Error("usage: author-native-issue-condition-functions.mjs [--refresh-unpublished] IDENTITY_HISTORY");
  console.log(JSON.stringify({ functions: authorNativeIssueFunctions(history, refresh).length }));
}
