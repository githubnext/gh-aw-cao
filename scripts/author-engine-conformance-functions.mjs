import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { gitEvidence } from "../.github/skills/add-operational-value/scripts/git-evidence.mjs";
import { readOutputHistory } from "../.github/skills/add-operational-value/scripts/collect-output-history.mjs";
import { writeCensusJson } from "./operational-value-census-io.mjs";

const sha256 = value => createHash("sha256").update(value).digest("hex");
export function authorEngineConformanceFunctions(historyDirectory, cache, refreshUnpublished = false) {
  const { index } = readOutputHistory(historyDirectory);
  const git = gitEvidence(index.repository, cache).git;
  const adopted = "a4cd539c00675ff60b56934e9dc66153cb88aab1";
  const baseline = "1a62fa28ef5d2339aa1d62c7dbf20e6767b8a8b6";
  const date = commit => new Date(git(["show", "--format=%cI", "--no-patch", commit]).trim()).toISOString().replace(".000Z", "Z");
  const checkerVersions = [adopted, "bc3991ee9b06be7532722548675955d8165ab6db",
    "3e72578a67b636684a42cdb8438ed468f0c8a572", "e6b87a4f169c7d194aa5f862f9b6e983ad11d3ae"];
  const scripts = [...new Set(checkerVersions.map(commit => {
    const locked = parse(git(["show", `${commit}:.github/workflows/engine-conformance-codex.lock.yml`]));
    const step = locked.jobs.agent.steps.find(step => step.name === "Assert engine conformance");
    if (!step?.run) throw new Error("Missing reviewed host conformance checker");
    return sha256(step.run);
  }))];
  const contracts = index.workflows.filter(row => /^engine-conformance-/.test(row.id)
    && row.id !== "engine-conformance-dispatcher").map(row => {
    const engine = row.id.slice("engine-conformance-".length);
    const source = git(["show", `${index.sourceRevision}:${row.path}`]);
    const agy = engine === "agy";
    const introduction = agy ? git(["log", "--first-parent", "--diff-filter=A", "--format=%H",
      index.sourceRevision, "--", row.path]).trim().split("\n") : [adopted];
    if (introduction.length !== 1 || !/^[a-f0-9]{40}$/.test(introduction[0])) throw new Error("Ambiguous source adoption");
    const addedAt = introduction[0], parent = agy ? git(["rev-parse", `${addedAt}^1`]).trim() : baseline;
    const shared = agy ? git(["show", `${index.sourceRevision}:.github/workflows/shared/agy-conformance.md`]) : source;
    if ((agy && (!source.includes("shared/agy-conformance.md") || !shared.includes("Assert native Agy MCP transport")))
      || !shared.includes("shared/engine-conformance.md") || !shared.includes(`engine-id: ${engine}`)
      || git(["diff-tree", "--no-commit-id", "--name-status", "-r", parent, addedAt, "--", row.path]).trim() !== `A\t${row.path}`) {
      throw new Error("Shared native contract or adoption does not match workflow source");
    }
    if (agy) {
      for (const revision of [addedAt, index.sourceRevision]) {
        const locked = parse(git(["show", `${revision}:.github/workflows/${row.id}.lock.yml`]));
        const step = locked.jobs.agent.steps.find(step => step.name === "Assert engine conformance");
        if (!step?.run || !scripts.includes(sha256(step.run))) throw new Error("Unreviewed Agy shared host checker");
      }
    }
    return { repository: index.repository, workflowId: row.id, engine, sourceGitBlob: row.gitBlob,
      sourceRevision: index.sourceRevision, until: index.until,
      nativeModelSha256: sha256(readFileSync("scripts/native-engine-conformance.mjs")),
      ...(agy ? { agyModelSha256: sha256(readFileSync("scripts/native-agy-conformance.mjs")) } : {}),
      adoption: { commit: addedAt, adoptedAt: date(addedAt), baselineCommit: parent, baselineAt: date(parent) },
      acceptedCheckerScripts: scripts };
  });
  const root = "docs/operational-value/proof";
  mkdirSync(path.join(root, "engine-conformance"), { recursive: true });
  for (const contract of contracts) {
    const file = path.join(root, "functions", `${contract.workflowId}.mjs`);
    const factory = contract.engine === "agy" ? "agyConformanceModule" : "engineConformanceModule";
    const helper = contract.engine === "agy" ? "native-agy-conformance" : "native-engine-conformance";
    const text = `import { ${factory} } from "../../../../scripts/${helper}.mjs";\n\nexport const { definition, collectBatch, scoreMetric } = ${factory}(${JSON.stringify(contract, null, 2)});\n`;
    if (existsSync(file) && readFileSync(file, "utf8") !== text
      && (!refreshUnpublished || existsSync(path.join(root, "reports", "github-gh-aw", `${contract.workflowId}-timeline.json`)))) {
      throw new Error("Refusing to change an already evaluated conformance function");
    }
    writeFileSync(file, text);
  }
  writeCensusJson(path.join(root, "engine-conformance", "contracts.json"), contracts);
  return contracts;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const refresh = args[0] === "--refresh-unpublished";
  if (refresh) args.shift();
  if (args.length !== 2) throw new Error("usage: author-engine-conformance-functions.mjs OUTPUT_HISTORY BARE_CACHE");
  console.log(JSON.stringify({ functions: authorEngineConformanceFunctions(...args, refresh).length }));
}
