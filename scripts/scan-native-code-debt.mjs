import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readJsonArchive as read } from "../.github/skills/add-operational-value/scripts/json-archive.mjs";

const dir = "docs/operational-value/proof/native-code-debt";
const objects = new Map(read(`${dir}/objects.json.gz`, { maxDecodedBytes: 64 * 1024 * 1024, maxParts: 512 }).map(x => [x.id, x]));
const custody = read(`${dir}/custody.json.gz`);
const inputs = custody.paths.filter(x => x.path.endsWith(".go") && x.blob).map(x => ({
  id: `${x.commit}:${x.path}`, text: Buffer.from(objects.get(x.blob).contentBase64, "base64").toString(),
}));
const temp = mkdtempSync(path.join(tmpdir(), "native-code-debt-scan-"));
try {
  const build = spawnSync("go", ["build", "-o", `${temp}/oracle`, `${dir}/oracle.go`], {
    env: { ...process.env, GOTOOLCHAIN: "local", GOPROXY: "off", GOSUMDB: "off", GO111MODULE: "off" },
  });
  if (build.status !== 0) throw new Error(build.stderr.toString());
  const run = spawnSync(`${temp}/oracle`, [], { input: JSON.stringify(inputs), maxBuffer: 32 * 1024 * 1024 });
  if (run.status !== 0) throw new Error(run.stderr.toString());
  const parsed = new Map(JSON.parse(run.stdout).map(x => [x.id, x]));
  for (const row of custody.implementations) for (const file of row.paths.filter(x => x.endsWith(".go") && !x.endsWith("_test.go"))) {
    const before = parsed.get(`${row.parent}:${file}`), after = parsed.get(`${row.commit}:${file}`);
    if (!before?.valid || !after?.valid) continue;
    const removed = before.functions.filter(fn => !fn.receiver && !fn.entry && /^[a-z]/.test(fn.name) && fn.name !== "init"
      && !after.functions.some(other => other.name === fn.name));
    if (removed.length) console.log(JSON.stringify({ slug: row.slug, number: row.number, commit: row.commit, parent: row.parent, file, removed }));
  }
} finally { rmSync(temp, { recursive: true }); }
