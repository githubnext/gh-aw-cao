import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { smokeToolsContract as contract } from "./smoke-test-tools-contract.mjs";
import { verifyPublicGitBlob } from "./immutable-public-git-source.mjs";
import { censusDigest, readCensusJson, writeCensusJson } from "./operational-value-census-io.mjs";

const directory = "docs/operational-value/proof/smoke-test-tools";
const sourceArchive = readCensusJson(`${directory}/sources.json.gz`);
const cache = process.argv[2] ?? ".smoke-test-tools-cache/api";
const sources = new Map(sourceArchive.sources.map(row => [`${row.revision}:${row.path}`, row]));
const acquire = (file, revision) => {
  const key = `${revision}:${file}`;
  if (sources.has(key)) return sources.get(key);
  const endpoint = `repos/${contract.repository}/contents/${file}?ref=${revision}`;
  const destination = path.join(cache, `${createHash("sha256").update(endpoint).digest("hex")}.json`);
  if (!existsSync(destination) && process.argv.includes("--cache-only")) throw new Error(`Missing retained historical import: ${endpoint}`);
  const row = existsSync(destination) ? JSON.parse(readFileSync(destination, "utf8"))
    : JSON.parse(execFileSync("gh", ["api", endpoint], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: 60000 }));
  if (row.type !== "file" || row.encoding !== "base64") throw new Error("Invalid historical import");
  writeFileSync(destination, JSON.stringify(row));
  const bytes = verifyPublicGitBlob(Buffer.from(row.content, "base64"), row.sha);
  const source = { path: file, revision, gitBlob: row.sha,
    sha256: createHash("sha256").update(bytes).digest("hex"), content: bytes.toString("base64") };
  sources.set(key, source);
  return source;
};
const profiles = [];
for (const row of sourceArchive.sources.filter(row => row.path === ".github/workflows/smoke-test-tools.md")) {
  const text = Buffer.from(row.content, "base64").toString("utf8");
  const frontmatter = parse(text.split("---")[1]);
  const tests = text.split("## Required Tool Tests")[1]?.split("## Output Requirements")[0];
  if (censusDigest(tests) !== "9f1578f1be5070a35fa317fe09d73c44119c6d73224bbf3daf92ad2e7ce6d65b") throw new Error("Unreviewed native tool population");
  const imports = [];
  const pending = [...(frontmatter.imports ?? [])];
  const seen = new Set();
  while (pending.length) {
    const name = pending.pop();
    if (typeof name !== "string" || !/^shared\/[a-z0-9-]+\.md$/.test(name)) throw new Error("Unsupported import scope");
    if (seen.has(name)) continue;
    seen.add(name);
    const imported = acquire(`.github/workflows/${name}`, row.revision);
    imports.push({ path: imported.path, gitBlob: imported.gitBlob });
    const importedText = Buffer.from(imported.content, "base64").toString("utf8");
    if (importedText.startsWith("---")) pending.push(...(parse(importedText.split("---")[1])?.imports ?? []));
  }
  profiles.push({ revision: row.revision, sourceGitBlob: row.gitBlob,
    testsSha256: censusDigest(tests), engine: frontmatter.engine, model: frontmatter.model ?? null,
    runtimes: frontmatter.runtimes, sandbox: frontmatter.sandbox ?? null, imports,
    comparableAcrossProfiles: false });
}
writeCensusJson(`${directory}/source-review.json.gz`, {
  contractSha256: censusDigest(contract), workflowRevisions: sourceArchive.history.length, profiles,
  sources: [...sources.values()], complete: true,
  findings: {
    nativeToolPopulation: "All 35 source revisions preserve the identical twelve tool commands and acceptance wording.",
    changedProfiles: "Copilot -> Codex -> Pi; Node 20 -> 24; models, container runtime, schedules and imported safeguards change. No cross-era trend is established.",
    primary: "Actor-independent native availability demonstrated by actual container invocation; version-check tools do not require invented hello-world compilation.",
    rejected: ["Configured runtimes", "Agent-authored version table", "Comment publication", "Successful agent or workflow conclusion"],
    safeguards: ["Token telemetry is asserted independently but is not a tool-availability oracle.",
      "Playwright title equality uses a protected randomized fixture; it is a separate imported acceptance dimension.",
      "OTLP/reporting/mood imports do not add or remove any of the twelve required version/function tests."],
    transport: "Current compiled AWF runs the Pi JSON stream inside the agent container through shell_harness/process_runner and forwards subprocess stdout to the protected Actions step. Agent session files and /tmp/gh-aw uploads share a writable mount and are not independent receipts by themselves.",
    historicalEvidence: contract.historicalCapability,
  },
});
console.log(JSON.stringify({ workflowRevisions: sourceArchive.history.length, profiles: profiles.length, retainedSources: sources.size }));
