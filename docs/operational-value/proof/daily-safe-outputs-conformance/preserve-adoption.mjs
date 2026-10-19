import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeJsonArchive } from "../../../../.github/skills/add-operational-value/scripts/json-archive.mjs";
import { hash } from "./native-checker.mjs";
import { verifyBlob } from "./collect.mjs";

const [cache, workflowDirectory, closureDirectory] = process.argv.slice(2);
if (!cache || !workflowDirectory || !closureDirectory) {
  throw new Error("Usage: node preserve-adoption.mjs READ-ONLY-GIT-CACHE WORKFLOW-RECEIPTS CLOSURE-RECEIPTS");
}
const home = path.dirname(fileURLToPath(import.meta.url));
const sources = [
  ["88a760de9deff7a78e1bd36310dd028316026fda", ".github/workflows/daily-safe-outputs-conformance.md", workflowDirectory],
  ["78ee265fa0079f8711890446a59faf607bed8d60", "scripts/check-safe-outputs-conformance.sh", closureDirectory],
  ["945c9b46d684f08ec84cb316e1dc0061e361f794", ".github/workflows/shared/mood.md", closureDirectory],
  ["96ca47d144a0a4210953a560772a08fc202b8d41", "docs/src/content/docs/reference/safe-outputs-specification.md", closureDirectory],
  ["bc08afb42be932485dc788109afdf7122dd96945", ".github/workflows/shared/reporting.md", null],
].map(([id, file, directory]) => {
  const bytes = directory ? readFileSync(path.join(directory, `${id}.blob`)) : execFileSync("git", [
    `--git-dir=${cache}`, "cat-file", "blob", id,
  ], { env: { ...process.env, GIT_NO_LAZY_FETCH: "1" }, maxBuffer: 4 * 1024 * 1024, timeout: 10000 });
  verifyBlob(bytes, id);
  writeJsonArchive(path.join(home, "blobs", `${id}.json.gz`), {
    id, sha256: hash(bytes), bytes: bytes.length, contentBase64: bytes.toString("base64"),
  });
  const response = directory ? readFileSync(path.join(directory, `${id}.response.json`)) : null;
  const headers = directory ? readFileSync(path.join(directory, `${id}.headers.json`)) : null;
  if (response) {
    const provider = JSON.parse(response.toString("utf8"));
    if (provider.sha !== id || provider.encoding !== "base64"
      || !Buffer.from(provider.content, "base64").equals(bytes)) throw new Error("Provider receipt/source mismatch");
  }
  return { id, file, bytes: bytes.length, sha256: hash(bytes),
    ...(response ? { providerResponseBase64: response.toString("base64"),
      providerResponseSha256: hash(response), providerHeadersBase64: headers.toString("base64") } : {}) };
});
writeJsonArchive(path.join(home, "adoption-sources.json.gz"), {
  schemaVersion: 1,
  repository: "github/gh-aw",
  commit: "eac9b15f9c3cc468652ef88dd18194d69e695046",
  parent: "5b953fa1ef92edd37b5b8202e827e9fbe159462f",
  source: "Actual Git addition against a real parent, not a shallow boundary or oldest issue.",
  sources,
  providerManifests: [workflowDirectory, closureDirectory].map(directory => {
    const manifest = JSON.parse(readFileSync(path.join(directory, "manifest.json"), "utf8"));
    return {
      requests: manifest.requests.filter(row => row[0] === "daily-safe-outputs-conformance"),
      receipts: manifest.receipts.filter(row => row.workflow === "daily-safe-outputs-conformance"),
    };
  }),
});
console.log(`Preserved ${sources.length} complete hash-verified adoption sources.`);
