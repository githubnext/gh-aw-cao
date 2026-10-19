import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { parse } from "yaml";
import { smokeDigest } from "./native-smoke-value.mjs";

const revision = "c86377ec47b38f0b5af463277ee55d1d03d08da8";
const repository = "github/gh-aw";
const root = "docs/operational-value/proof/smoke-native";
const git = args => execFileSync("git", ["--git-dir", process.argv[2], ...args],
  { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }).trimEnd();
const source = file => git(["show", `${revision}:${file}`]);
const sha = value => createHash("sha256").update(value).digest("hex");
const sources = {
  "smoke-agy": ["shared/agy-conformance.md", "shared/engine-conformance.md"],
  "smoke-aider": ["shared/aider.md", "shared/reporting.md"],
  "smoke-claude-copilot": [],
};
const semantics = {
  "smoke-agy": {
    name: "Smoke Agy (Experimental)",
    goal: "Verify experimental Agy authentication, inference, AWF, native MCP and staged safe outputs.",
    acceptance: "Six shared behavioral cases plus native challenge transport, native infrastructure MCP, native safeoutputs and inference accounting are independently asserted. Full acceptance requires both complete host gates with their fixture/execution safeguards.",
    limitations: ["Repeated monitoring proofs, not new repository fixes. Failed native conjunctions cannot identify failing constituent assertions."],
  },
  "smoke-aider": {
    name: "Smoke Aider",
    goal: "Verify Aider prompt delivery, SEARCH/REPLACE file editing, shell/repository access and safe-output publication.",
    acceptance: "The host checker independently verifies exact expected file content and a successful native shell tool event whose command matches git-log syntax and whose output contains a commit-shaped line. Full acceptance additionally requires independently proven SEARCH/REPLACE editing, readback and correct event-specific safe-output publication, not an agent PASS claim.",
    limitations: ["Two independently checked facets are partial: file content does not establish editing method; the host's git-log command/output regex does not prove the required cat readback, all repository-access semantics or safe-output publication.", "Pre-checker historical runs and self-reported output issues cannot prove these native assertions."],
  },
  "smoke-claude-copilot": {
    name: "Smoke Claude Copilot",
    goal: "Detect Copilot Anthropic Messages inference, streaming tool-use and follow-up inference incompatibilities without model fallback.",
    acceptance: "The protected host validates an unpredictable MCP receipt and an exactly matching single noop after tool-result inference, with successful execution and disabled fallback in the trusted environment.",
    limitations: ["No successful run/agent conclusion or self-reported receipt is a substitute for the protected assertion gate."],
  },
};
const reviewedAiderImports = [
  "285072bfa3dae9c592e78381b863bb76429830b6",
  "fd3fdae355ea5171a5b5985bba28996bf70ef64e",
  "67393d932cc9e005eed15a3a455f5183815628ef",
  "82dbb7a2e5c0eb0b0136602693644f38c5efc38c",
  "fa2e1f224e8d189c91ed5226c85c26af708a7007",
];
mkdirSync(root, { recursive: true });
mkdirSync("docs/operational-value/proof/functions", { recursive: true });
const contracts = [];
for (const [workflowId, imports] of Object.entries(sources)) {
  const file = `.github/workflows/${workflowId}.md`;
  const additions = git(["log", "--first-parent", "--format=%H", "--diff-filter=A", revision, "--", file]).split("\n");
  if (additions.length !== 1 || !/^[a-f0-9]{40}$/.test(additions[0])) throw new Error("Ambiguous true smoke adoption");
  const commit = additions[0], parent = git(["rev-parse", `${commit}^`]);
  try { git(["cat-file", "-e", `${parent}:${file}`]); throw new Error("Smoke source already exists in actual parent"); }
  catch (error) { if (!error.status) throw error; }
  git(["cat-file", "-e", `${commit}:.github/workflows/${workflowId}.lock.yml`]);
  const adoption = { commit, adoptedAt: git(["show", "-s", "--format=%cI", commit]),
    baselineCommit: parent, baselineAt: git(["show", "-s", "--format=%cI", parent]) };
  for (const key of ["adoptedAt", "baselineAt"]) adoption[key] = new Date(adoption[key]).toISOString().replace(".000Z", "Z");
  const locked = parse(source(`.github/workflows/${workflowId}.lock.yml`));
  const steps = locked.jobs.agent.steps;
  const protectedNames = workflowId === "smoke-agy"
    ? ["Prepare engine conformance fixtures", "Assert engine conformance", "Assert native Agy MCP transport and inference accounting"]
    : [workflowId === "smoke-aider" ? "Verify Aider smoke test evidence" : "Assert Claude Copilot inference evidence"];
  const protectedSteps = protectedNames.map(name => {
    const step = steps.find(item => item.name === name);
    if (!step || step["continue-on-error"]) throw new Error("Missing fail-closed smoke gate");
    return { name, sha256: smokeDigest(step) };
  });
  const protectedImports = workflowId === "smoke-agy"
    ? imports.map(item => ({ path: `.github/workflows/${item}`,
      acceptedGitBlobs: [git(["rev-parse", `${revision}:.github/workflows/${item}`])] }))
    : workflowId === "smoke-aider"
      ? [{ path: ".github/workflows/shared/aider.md", acceptedGitBlobs: reviewedAiderImports }]
      : [{ path: file, acceptedGitBlobs: [git(["rev-parse", `${revision}:${file}`])] }];
  const contract = { repository, repositoryId: 1036865607, workflowId, sourceRevision: revision,
    until: "2026-10-18T15:00:12Z", sourceGitBlob: git(["rev-parse", `${revision}:${file}`]),
    interpreterSha256: sha(readFileSync("scripts/native-smoke-value.mjs")), adoption, ...semantics[workflowId], protectedSteps, protectedImports };
  const adoptedSource = git(["show", `${commit}:${file}`]);
  const adoptedFrontmatter = parse(adoptedSource.split("---")[1]);
  const adoptedImports = (adoptedFrontmatter.imports ?? []).map(item => typeof item === "string" ? item : item.uses);
  const adoptionSources = [file, `.github/workflows/${workflowId}.lock.yml`,
    ...adoptedImports.map(item => `.github/workflows/${item}`)];
  const receipt = { repository, revision, workflowId, adoption, parentSourceAbsent: true,
    adoptionSources: adoptionSources.map(file => ({ path: file,
      gitBlob: git(["rev-parse", `${commit}:${file}`]), text: git(["show", `${commit}:${file}`]) })),
    reviewedEvidenceProducers: protectedImports.flatMap(item => item.acceptedGitBlobs.map(gitBlob => ({
      path: item.path, gitBlob, text: git(["show", gitBlob]),
      review: workflowId === "smoke-aider"
        ? "Reviewed native workflow_run_cmd maps actual original_run_cmd exit status/output to paired tool events. Later source changes add accounting, reflection and interpreted event names, without weakening the required successful shell receipt."
        : "Exact frozen protected fixture/nonce-generator source." }))),
    sources: [file, `.github/workflows/${workflowId}.lock.yml`, ...imports.map(item => `.github/workflows/${item}`)]
      .map(file => ({ path: file, gitBlob: git(["rev-parse", `${revision}:${file}`]), text: source(file) })),
    protectedSteps };
  const bytes = gzipSync(JSON.stringify(receipt));
  if (bytes.length > 256 * 1024) throw new Error("Oversized smoke source receipt");
  writeFileSync(path.join(root, `${workflowId}-sources.json.gz`), bytes);
  writeFileSync(`docs/operational-value/proof/functions/${workflowId}.mjs`,
    `import { smokeModule } from "../../../../scripts/native-smoke-value.mjs";\n\nexport const { definition, collectBatch, scoreMetric } = smokeModule(${JSON.stringify(contract, null, 2)});\n`);
  contracts.push(contract);
}
writeFileSync(path.join(root, "contracts.json"), `${JSON.stringify(contracts, null, 2)}\n`);
