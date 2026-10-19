import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gitEvidence } from "../.github/skills/add-operational-value/scripts/git-evidence.mjs";
import { readOutputHistory } from "../.github/skills/add-operational-value/scripts/collect-output-history.mjs";
import { scanSpecState, specReferenceFacts } from "./native-spec-condition-value.mjs";
import { censusDigest, readCensusJson, writeCensusJson } from "./operational-value-census-io.mjs";

export function parseSpecTree(text) {
  const rows = text.split("\0").filter(Boolean).map(row => {
    const match = row.match(/^(\d{6}) (?:blob|commit) ([a-f0-9]{40})\t([\s\S]+)$/);
    if (!match) throw new Error("Malformed immutable specification tree");
    return { path: match[3], mode: match[1], blob: match[2] };
  });
  if (rows.length > 100000 || new Set(rows.map(row => row.path)).size !== rows.length) throw new Error("Specification tree budget or identity failure");
  return new Map(rows.map(row => [row.path, row]));
}

export function specStateLookup(tree, specs, features) {
  const lookup = {};
  for (const entry of specs) {
    if (!["100644", "100755"].includes(entry.mode)) continue;
    const fact = features.get(entry.blob);
    if (!fact || !Array.isArray(fact.links)) throw new Error("Missing specification source facts");
    for (const link of fact.links) {
      if (link.invalid) continue;
      const parts = link.target.split("/");
      const symlink = parts.some((_, position) => tree.get(parts.slice(0, position + 1).join("/"))?.mode === "120000");
      const found = tree.get(link.target);
      lookup[link.target] = symlink ? { symlink: true } : found ? { mode: found.mode, blob: found.blob } : null;
    }
  }
  return lookup;
}

export function collectSpecConditionHistory(historyDirectory, cache) {
  const { index: inventory } = readOutputHistory(historyDirectory);
  const workflowId = "daily-spec-coverage-kiro";
  const workflow = inventory.workflows.find(row => row.id === workflowId);
  if (!workflow) throw new Error("Specification workflow is absent from frozen inventory");
  const { git, features: acquire } = gitEvidence(inventory.repository, cache);
  const adopted = "0841c9e3e6fc99312ed0e7f770fc5a0b6438ead8";
  const baseline = "307107ba81a26cd792165b84e5f8634943fa9bca";
  git(["merge-base", "--is-ancestor", adopted, inventory.sourceRevision]);
  const mainline = git(["rev-list", "--first-parent", "--max-count=100000", inventory.sourceRevision]).trim().split("\n");
  if (!mainline.includes(baseline)) throw new Error("Specification adoption is outside bounded first-parent history");
  for (const file of [workflow.path, workflow.path.replace(/\.md$/, ".lock.yml")]) {
    if (git(["diff-tree", "--no-commit-id", "--name-status", "-r", baseline, adopted, "--", file]).trim() !== `A\t${file}`) {
      throw new Error("Specification adoption is not an actual source and compiled-workflow addition");
    }
  }
  const date = revision => new Date(git(["show", "--no-patch", "--format=%cI", revision]).trim()).toISOString().replace(".000Z", "Z");
  const nativeModelSha256 = createHash("sha256").update(readFileSync("scripts/native-spec-condition-value.mjs")).digest("hex");
  const directory = "docs/operational-value/proof/spec-condition";
  mkdirSync(directory, { recursive: true });
  const headTree = parseSpecTree(git(["ls-tree", "-rz", inventory.sourceRevision]));
  const scannerGitBlob = headTree.get(".github/scripts/audit_spec_coverage.cjs")?.blob;
  if (!scannerGitBlob) throw new Error("Frozen normative specification scanner is absent");
  const contract = { workflowId, repository: inventory.repository, sourceRevision: inventory.sourceRevision,
    sourceGitBlob: workflow.gitBlob, until: inventory.until, nativeModelSha256, scannerGitBlob,
    adoption: { commit: adopted, adoptedAt: date(adopted), baselineCommit: baseline, baselineAt: date(baseline) } };
  const functionFile = `docs/operational-value/proof/functions/${workflowId}.mjs`;
  const module = `import { nativeSpecConditionModule } from "../../../../scripts/native-spec-condition-value.mjs";\n\nexport const { definition, collectBatch, scoreMetric } = nativeSpecConditionModule(${JSON.stringify(contract, null, 2)});\n`;
  if (existsSync(functionFile) && readFileSync(functionFile, "utf8") !== module) throw new Error("Refusing to replace frozen specification function");
  writeFileSync(functionFile, module);
  writeCensusJson(`${directory}/contracts.json`, [contract]);
  if (existsSync(`${directory}/index.json.gz`)) {
    const retained = readCensusJson(`${directory}/index.json.gz`);
    if (retained.complete !== true || retained.repository !== contract.repository
      || retained.sourceRevision !== contract.sourceRevision || retained.until !== contract.until
      || retained.nativeModelSha256 !== nativeModelSha256 || retained.scannerGitBlob !== scannerGitBlob) {
      throw new Error("Existing specification acquisition scope changed");
    }
    const facts = retained.partitions.flatMap(part => {
      if (!/^facts-\d{3}\.json\.gz$/.test(part.file)) throw new Error("Unsafe specification partition");
      const rows = readCensusJson(`${directory}/${part.file}`);
      if (censusDigest(rows) !== part.sha256 || rows.length !== part.count) throw new Error("Retained specification facts changed");
      return rows;
    });
    const features = new Map(facts.map(row => [row.id, row]));
    for (const state of retained.states) scanSpecState(state, features);
    return { states: retained.states.length, uniqueBlobs: retained.uniqueBlobs, decodedBytes: retained.decodedBytes, reused: true };
  }
  const end = Date.parse(inventory.until), start = Date.parse(contract.adoption.adoptedAt), week = 7 * 86400000;
  const endpoints = new Set([end, end - week]);
  for (let at = start + week; at <= end; at += week) endpoints.add(at);
  const planned = [...endpoints].filter(at => at > start).sort((left, right) => left - right).map(at => {
    const windowEnd = new Date(at).toISOString().replace(".000Z", "Z");
    const commit = git(["rev-list", "--first-parent", "-1", `--before=${windowEnd}`, inventory.sourceRevision]).trim();
    if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("Missing immutable specification state");
    const tree = parseSpecTree(git(["ls-tree", "-rz", commit]));
    if ([".github", ".github/aw"].some(prefix => tree.get(prefix)?.mode === "120000")) {
      throw new Error("Specification root is a symlink; complete native scanning is unavailable");
    }
    const specs = [...tree.values()].filter(row => /^\.github\/aw\/[^/]+\.md$/.test(row.path));
    return { windowEnd, commit, at: date(commit), treeSha: git(["rev-parse", `${commit}^{tree}`]).trim(), tree, specs };
  });
  const blobs = planned.flatMap(state => state.specs.filter(row => ["100644", "100755"].includes(row.mode)).map(row => row.blob));
  const acquired = acquire(blobs, rows => rows.map(specReferenceFacts), { maxBlobs: 10000, maxBytes: 128 * 1024 * 1024 });
  const states = planned.map(state => ({ windowEnd: state.windowEnd, commit: state.commit, at: state.at,
    tree: state.treeSha, specs: state.specs, lookup: specStateLookup(state.tree, state.specs, acquired.features) }));
  const facts = [...acquired.features.values()], partitions = [];
  for (let offset = 0; offset < facts.length; offset += 100) {
    const rows = facts.slice(offset, offset + 100), file = `facts-${String(partitions.length + 1).padStart(3, "0")}.json.gz`;
    writeCensusJson(`${directory}/${file}`, rows);
    partitions.push({ file, count: rows.length, sha256: censusDigest(rows) });
  }
  const index = { schemaVersion: 1, kind: "specification-condition-history", complete: true, repository: inventory.repository,
    sourceRevision: inventory.sourceRevision, until: inventory.until, nativeModelSha256, scannerGitBlob,
    adoption: contract.adoption, acquiredAt: new Date().toISOString(), uniqueBlobs: acquired.uniqueBlobs,
    decodedBytes: acquired.totalBytes, states, partitions };
  writeCensusJson(`${directory}/index.json.gz`, index);
  return { states: states.length, uniqueBlobs: acquired.uniqueBlobs, decodedBytes: acquired.totalBytes };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [history, cache, ...extra] = process.argv.slice(2);
  if (!history || !cache || extra.length) throw new Error("usage: collect-spec-condition-history.mjs IDENTITY_HISTORY BARE_CACHE");
  console.log(JSON.stringify(collectSpecConditionHistory(history, cache)));
}
