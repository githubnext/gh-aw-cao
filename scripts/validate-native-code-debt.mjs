import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { sha256 } from "../docs/operational-value/proof/native-code-debt/native.mjs";

const compiler = process.argv[2];
if (!compiler?.startsWith("/")) throw new Error("Supply the exact pinned compiler binary");
const records = [];
function run(command, args, label = command) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 600000, maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw result.error;
  records.push({ command: [label, ...args.map(arg => arg === compiler ? "pinned-gh-aw-v0.92.4" : arg)],
    exitStatus: result.status, stdout: result.stdout, stderr: result.stderr });
  if (result.status !== 0) throw new Error(`${label} failed:\n${result.stdout}\n${result.stderr}`);
}
run("npm", ["run", "lint"]);
run("npm", ["run", "typecheck:cao"]);
run("npm", ["run", "typecheck:copilot"]);
run(process.execPath, ["scripts/check-file-sizes.mjs"], "node");
run(process.execPath, ["--test", "tests/unit/native-code-debt.test.mjs"], "node");
for (const slug of ["daily-code-debt-aider", "code-simplifier"]) {
  run(process.execPath, [".github/skills/add-operational-value/scripts/verify-value-function.mjs", "--collector", `docs/operational-value/proof/functions/${slug}.mjs`], "node");
}
run(process.execPath, ["scripts/replay-native-code-debt.mjs", "--write"], "node");
const profile = "(version 1)(allow default)(deny network*)";
run("/usr/bin/sandbox-exec", ["-p", profile, process.execPath, "-e",
  'const assert=require("node:assert/strict"),net=require("node:net");let s=net.createConnection({host:"127.0.0.1",port:9});s.on("error",e=>{assert.ok(["EPERM","EACCES"].includes(e.code));console.log("Compiler sandbox network-denial probe passed")});s.on("connect",()=>{s.destroy();throw Error("network unexpectedly available")});']);
run("/usr/bin/sandbox-exec", ["-p", profile, compiler, "compile", "--strict", "--no-emit", "--no-check-update", "--schedule-seed", "githubnext/gh-aw-cao"]);
writeFileSync("docs/operational-value/proof/native-code-debt/validation.json", `${JSON.stringify({
  schemaVersion: 1, records, compilerSha256: sha256(readFileSync(compiler)), allPassed: true,
  dependencyRestoration: "Initial root validation lacked yaml/typescript. Restored exact lockfile with npm ci --ignore-scripts; no manifest changes.",
  fullTargetBuildOrTestsExecuted: false,
}, null, 2)}\n`);
console.log(JSON.stringify({ checksPassed: records.length, compilerSha256: sha256(readFileSync(compiler)), allPassed: true }));
