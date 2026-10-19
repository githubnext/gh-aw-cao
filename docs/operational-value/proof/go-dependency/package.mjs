import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { sha256 } from "./custody.mjs";

const prefix = process.argv[2];
if (!prefix || !path.isAbsolute(prefix)) throw new Error("usage: package.mjs ABSOLUTE_EXTERNAL_ARTIFACT_PREFIX");
const directory = "docs/operational-value/proof/go-dependency";
const visit = directory => readdirSync(directory).sort().flatMap(name => {
  const file = `${directory}/${name}`, stat = lstatSync(file);
  if (stat.isDirectory()) return visit(file);
  assert.ok(stat.isFile() && !stat.isSymbolicLink(), "Only regular owned files may be packaged");
  assert.ok(stat.size <= 256 * 1024, `Owned artifact exceeds 256 KiB: ${file}`);
  return [file];
});
const files = [
  ...visit(directory),
  ...["dependabot-burner", "dependabot-go-checker", "go-fan"].map(slug => `docs/operational-value/proof/functions/${slug}.mjs`),
  "tests/unit/operational-value-go-dependency.test.mjs",
].sort();
for (const file of files.filter(file => file.endsWith(".mjs"))) {
  assert.ok(readFileSync(file, "utf8").split("\n").length < 3000, `Module exceeds line budget: ${file}`);
}
const receipt = JSON.parse(readFileSync(`${directory}/replay-receipt.json`));
const clean = JSON.parse(readFileSync(`${directory}/clean-replay-receipt.json`));
assert.deepEqual(clean.results, receipt.results);
const archive = execFileSync("tar", ["-czf", "-", ...files], {
  maxBuffer: 8 * 1024 * 1024, env: { ...process.env, COPYFILE_DISABLE: "1" },
});
const listed = execFileSync("tar", ["-tzf", "-"], {
  input: archive, encoding: "utf8", env: { ...process.env, COPYFILE_DISABLE: "1" },
}).trim().split("\n").sort();
assert.deepEqual(listed, files);
assert.equal(listed.some(file => file.split("/").some(component => component.startsWith("._"))), false);
const parts = [];
for (let offset = 0, index = 1; offset < archive.length; offset += 240 * 1024, index++) {
  const bytes = archive.subarray(offset, offset + 240 * 1024);
  const file = `${prefix}.tar.gz.part-${String(index).padStart(3, "0")}`;
  writeFileSync(file, bytes);
  parts.push({ path: file, bytes: bytes.length, sha256: sha256(bytes) });
}
const manifest = {
  schemaVersion: 1, cohort: "go-dependency",
  checkpoint: "ce52f9bb36e7a1747f544a912978a87c925fa096",
  intent: "Owned-only additive handoff; no source, global skill, portfolio or policy overwrites.",
  archive: { format: "concatenated ordered parts are tar+gzip", bytes: archive.length, sha256: sha256(archive), parts },
  files: files.map(file => {
    const bytes = readFileSync(file);
    return { path: file, bytes: bytes.length, sha256: sha256(bytes) };
  }),
  assessment: `${directory}/assessment.json`,
  independentReplay: `${directory}/clean-replay-receipt.json`,
  replayCommand: "node docs/operational-value/proof/go-dependency/replay.mjs",
  testsCommand: "node --test tests/unit/operational-value-go-dependency.test.mjs",
};
const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`), file = `${prefix}.manifest.json`;
writeFileSync(file, bytes);
console.log(JSON.stringify({ manifest: { path: file, bytes: bytes.length, sha256: sha256(bytes) },
  archive: manifest.archive, files: files.length }, null, 2));
