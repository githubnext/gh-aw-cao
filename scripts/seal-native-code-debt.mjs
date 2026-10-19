import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { sha256 } from "../docs/operational-value/proof/native-code-debt/native.mjs";

const dir = "docs/operational-value/proof/native-code-debt";
const env = { ...process.env, GOTOOLCHAIN: "local", GO111MODULE: "off", GOPROXY: "off", GOSUMDB: "off", GOENV: "off", GOWORK: "off" };
function go(args) {
  const result = spawnSync("go", args, { env, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}
const root = go(["env", "GOROOT"]);
const files = go(["list", "-deps", "-f", '{{.Dir}}|{{join .GoFiles ","}}|{{join .CgoFiles ","}}|{{join .SFiles ","}}|{{join .HFiles ","}}|{{join .EmbedFiles ","}}', `${dir}/oracle.go`])
  .split("\n").flatMap(line => {
    const [directory, ...groups] = line.split("|");
    if (!directory.startsWith(`${root}/`)) return [];
    return groups.flatMap(group => group.split(",").filter(Boolean)).map(file => path.relative(root, path.join(directory, file)));
  });
files.push("bin/go", ...["compile", "link", "asm"].map(name => `pkg/tool/darwin_arm64/${name}`));
writeFileSync(`${dir}/toolchain.json`, `${JSON.stringify({ version: go(["version"]),
  nodeVersion: process.version, nodePlatform: process.platform, nodeArch: process.arch,
  nodeBinarySha256: sha256(readFileSync(process.execPath)),
  oracleSha256: sha256(readFileSync(`${dir}/oracle.go`)), files: [...new Set(files)].sort().map(file => ({
    path: file, sha256: sha256(readFileSync(path.join(root, file))),
  })) }, null, 2)}\n`);
console.log(JSON.stringify({ pinnedGoFiles: new Set(files).size }));
if (process.argv.includes("--closure")) {
  const baseline = [
    ...readdirSync(".github/skills/add-operational-value/scripts").filter(name => /\.(?:mjs|css)$/.test(name))
      .map(name => `.github/skills/add-operational-value/scripts/${name}`),
    "docs/operational-value/proof/native-go-quality/custody.mjs",
  ].sort();
  writeFileSync(`${dir}/replay-baseline.json`, `${JSON.stringify({ kind: "unchanged-baseline-replay-dependencies",
    baselineCommit: "f4a8753b47d4a1345efb4e3cec525e7f5390bc5d",
    files: baseline.map(file => { const bytes = readFileSync(file); return { path: file, bytes: bytes.length, sha256: sha256(bytes) }; }),
  }, null, 2)}\n`);
  const names = [];
  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = `${directory}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name !== "reports") walk(file);
      } else if (entry.isFile() && !["instrument-lock.json", "assessment.json", "clean-replay-receipt.json", "validation.json"].includes(entry.name)) names.push(file);
      else if (!entry.isFile()) throw new Error("Nonregular instrument file");
    }
  }
  walk(dir);
  names.push(...baseline);
  const lock = { schemaVersion: 1, kind: "native-code-debt-closure", unchangedBaselineDependencies: baseline,
    files: names.sort().map(file => {
      const bytes = readFileSync(file);
      if (bytes.length > 256 * 1024) throw new Error(`Oversized instrument file: ${file}`);
      return { path: file, bytes: bytes.length, sha256: sha256(bytes) };
    }) };
  const bytes = Buffer.from(`${JSON.stringify(lock, null, 2)}\n`);
  writeFileSync(`${dir}/instrument-lock.json`, bytes);
  for (const slug of ["daily-code-debt-aider", "code-simplifier"]) {
    writeFileSync(`docs/operational-value/proof/functions/${slug}.mjs`,
      `import { debtModule } from "../native-code-debt/model.mjs";\n\nexport const { definition, collectBatch, scoreMetric } = debtModule(${JSON.stringify(slug)}, ${JSON.stringify(sha256(bytes))});\n`);
  }
  console.log(JSON.stringify({ lockedFiles: lock.files.length, lockSha256: sha256(bytes), unchangedBaselineDependencies: baseline }));
}
