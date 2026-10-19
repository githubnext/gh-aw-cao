import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readOutputHistory } from "../.github/skills/add-operational-value/scripts/collect-output-history.mjs";
import { readJsonArchive, writeJsonArchive } from "../.github/skills/add-operational-value/scripts/json-archive.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const proof = path.join(root, "docs/operational-value/proof/gpl-audit");
const hash = value => createHash("sha256").update(value).digest("hex");

export function collect() {
  mkdirSync(path.join(proof, "originals"), { recursive: true });
  const receipts = {};
  const request = (label, endpoint, binary = false) => {
    const file = `originals/${label}.json.gz`, destination = path.join(proof, file);
    let packet;
    if (existsSync(destination)) packet = readJsonArchive(destination);
    else {
      const output = binary
        ? execFileSync("curl", ["--fail", "--silent", "--show-error", "--location", "--max-time", "60", endpoint],
          { timeout: 65000, maxBuffer: 16 * 1024 * 1024 })
        : execFileSync("gh", ["api", endpoint], { timeout: 60000, maxBuffer: 16 * 1024 * 1024 });
      const body = binary ? output.toString("base64") : output.toString("utf8");
      packet = { endpoint, observedAt: new Date().toISOString(), body, sha256: hash(body),
        encoding: binary ? "base64" : "utf8" };
      writeJsonArchive(destination, packet);
    }
    if (packet.endpoint !== endpoint || hash(packet.body) !== packet.sha256) throw new Error(`Changed GPL original: ${label}`);
    receipts[label] = { file, archiveSha256: hash(readFileSync(destination)), bodySha256: packet.sha256 };
    return binary ? Buffer.from(packet.body, "base64") : JSON.parse(packet.body);
  };
  const metadata = request("repository", "repos/github/gh-aw");
  if (metadata.id !== 1036865607 || metadata.full_name !== "github/gh-aw" || metadata.private !== false
    || metadata.visibility !== "public") throw new Error("GPL acquisition public repository mismatch");
  const history = readOutputHistory(path.join(root, "docs/operational-value/gh-aw-workflows/evidence"));
  const candidates = history.entities.filter(row => row.kind === "Issue" && row.workflowReference?.workflowId === "gpclean");
  if (candidates.length > 100) throw new Error("GPL original acquisition exceeds the bounded issue budget");
  for (const row of candidates) {
    const issue = request(`issue-${row.number}`, `repos/github/gh-aw/issues/${row.number}`);
    if (issue.node_id !== row.id || issue.number !== row.number || issue.created_at !== row.createdAt
      || issue.html_url !== row.url || typeof issue.body !== "string" || issue.pull_request) {
      throw new Error("GPL issue discovery/original identity mismatch");
    }
  }
  const revision = "c86377ec47b38f0b5af463277ee55d1d03d08da8";
  request("adoption", "repos/github/gh-aw/commits/6d4da0d7134d21def02c6cfb27e00bf3d5851507");
  for (const suffix of ["md", "lock.yml"]) request(`frozen-${suffix.replace(".", "-")}`,
    `repos/github/gh-aw/contents/.github/workflows/gpclean.${suffix}?ref=${revision}`);
  const finding = request("issue-15048", "repos/github/gh-aw/issues/15048");
  const run = request("finding-run", "repos/github/gh-aw/actions/runs/21928661830");
  if (run.repository?.id !== metadata.id || run.id !== 21928661830 || !/^[a-f0-9]{40}$/.test(run.head_sha)
    || run.path !== ".github/workflows/gpclean.lock.yml") throw new Error("GPL finding run/source identity mismatch");
  for (const name of ["go.mod", "go.sum", "tools.go", ".github/workflows/gpclean.md", ".github/workflows/gpclean.lock.yml"]) {
    request(`finding-source-${path.basename(name).replaceAll(".", "-")}`,
      `repos/github/gh-aw/contents/${name}?ref=${run.head_sha}`);
  }
  const modules = [
    ["github.com/OpenPeeDeeP/depguard/v2", "v2.2.1"],
    ["github.com/ldez/structtags", "v0.6.1"],
    ["github.com/firefart/nonamedreturns", "v1.0.6"],
    ["github.com/xen0n/gosmopolitan", "v1.3.0"],
    ["github.com/denis-tingaikin/go-header", "v0.5.0"],
    ["github.com/leonklingele/grouper", "v1.1.2"],
  ].map(([module, version], position) => {
    if (!finding.body.includes(module) || !finding.body.includes(version)) throw new Error("Versioned finding claim changed");
    const escaped = module.replace(/[A-Z]/g, letter => `!${letter.toLowerCase()}`);
    const url = `https://proxy.golang.org/${escaped}/@v/${version}.zip`;
    request(`module-${position + 1}-zip`, url, true);
    return { module, version, receipt: `module-${position + 1}-zip`, url };
  });
  request("gpl3-reference", "https://www.gnu.org/licenses/gpl-3.0.txt", true);
  const index = { schemaVersion: 1, repository: "github/gh-aw", repositoryId: 1036865607, revision,
    cutoff: "2026-10-18T15:00:12Z", discoveryComplete: history.index.complete,
    candidateCount: candidates.length, candidates, receipts, findingHead: run.head_sha, modules,
    limitation: "A complete retained issue/PR inventory is discovery only; it does not reconstruct deleted issues, native SBOM inputs, original publication bytes or runtime effects." };
  writeJsonArchive(path.join(proof, "index.json.gz"), index);
  return index;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = collect();
  console.log(JSON.stringify({ candidates: result.candidateCount, originals: Object.keys(result.receipts).length }));
}
