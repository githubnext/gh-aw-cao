import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { packageOwned } from "./package-native-code-debt.mjs";
import { withoutGeneratedAt } from "./replay-native-code-debt.mjs";
import { sha256 } from "../docs/operational-value/proof/native-code-debt/native.mjs";

const destination = process.argv[2], sharedAcquisitions = process.argv[3];
if (!destination || !path.isAbsolute(destination) || !sharedAcquisitions || !path.isAbsolute(sharedAcquisitions)) throw new Error("Supply external artifact directory and shared acquisition root");
const bundle = packageOwned(destination), clean = mkdtempSync(path.join(tmpdir(), "native-code-debt-clean-"));
execFileSync("python3", ["-c", `
import hashlib,io,json,pathlib,sys,tarfile
root=pathlib.Path(sys.argv[1]); clean=pathlib.Path(sys.argv[2])
m=json.loads((root/'native-code-debt.manifest.json').read_bytes()); expected={r['path']:r for r in m['files']}
b=b''.join((root/p['file']).read_bytes() for p in m['chunks'])
assert hashlib.sha256(b).hexdigest()==m['archive']['sha256']
with tarfile.open(fileobj=io.BytesIO(b),mode='r:gz') as t:
    members=t.getmembers()
    assert len(members)==len(expected) and {r.name for r in members}==set(expected)
    for r in members:
        p=pathlib.PurePosixPath(r.name)
        assert r.isfile() and not p.is_absolute() and '..' not in p.parts
        assert not any(x.startswith('._') or x=='__MACOSX' for x in p.parts)
        data=t.extractfile(r).read()
        assert len(data)==expected[r.name]['bytes'] and hashlib.sha256(data).hexdigest()==expected[r.name]['sha256']
        target=clean/r.name; target.parent.mkdir(parents=True,exist_ok=True); target.write_bytes(data)
assert not list(clean.rglob('.git')) and not list(clean.rglob('node_modules'))
`, destination, clean]);
const baseline = JSON.parse(readFileSync("docs/operational-value/proof/native-code-debt/replay-baseline.json"));
for (const row of baseline.files) {
  const bytes = readFileSync(row.path);
  assert.equal(bytes.length, row.bytes);
  assert.equal(sha256(bytes), row.sha256);
  const target = path.join(clean, row.path);
  mkdirSync(path.dirname(target), { recursive: true });
  copyFileSync(row.path, target);
}
for (const directory of ["home", "tmp", "go-build", "gopath"]) mkdirSync(path.join(clean, directory));
assert.deepEqual(readdirSync(path.join(clean, "go-build")), []);
const workspace = process.cwd();
const profile = `(version 1)(allow default)(deny network*)(deny file-read* (subpath ${JSON.stringify(workspace)}) (subpath ${JSON.stringify(sharedAcquisitions)}) (subpath ${JSON.stringify(destination)}))`;
const env = { PATH: process.env.PATH, HOME: path.join(clean, "home"), TMPDIR: `${path.join(clean, "tmp")}/`,
  GOCACHE: path.join(clean, "go-build"), GOPATH: path.join(clean, "gopath"),
  GOPROXY: "off", GOSUMDB: "off", GOTOOLCHAIN: "local", GOENV: "off", GOWORK: "off" };
const probe = `
const fs=require("node:fs"),net=require("node:net"),assert=require("node:assert/strict");
for(const file of process.argv.slice(1)){let code;try{fs.readFileSync(file)}catch(e){code=e.code}assert.ok(["EPERM","EACCES"].includes(code),file+" not denied: "+code)}
assert.ok(!fs.existsSync(".git")&&!fs.existsSync("node_modules"));
const socket=net.createConnection({host:"127.0.0.1",port:9});
socket.on("error",e=>{assert.ok(["EPERM","EACCES"].includes(e.code));console.log(JSON.stringify({networkDenied:true,originalWorkspaceDenied:true,sharedAcquisitionDenied:true,originalBundleDenied:true,gitDirectory:false,nodeModules:false}))});
socket.on("connect",()=>{socket.destroy();throw Error("Network isolation failed")});
`;
function sandbox(args) {
  return execFileSync("/usr/bin/sandbox-exec", ["-p", profile, process.execPath, ...args], {
    cwd: clean, env, encoding: "utf8", timeout: 600000, maxBuffer: 32 * 1024 * 1024,
  });
}
const probes = JSON.parse(sandbox(["-e", probe, path.join(workspace, "CODEBASE.yml"),
  path.join(sharedAcquisitions, "native-go-git-cache/config"), path.join(destination, "native-code-debt.manifest.json")]).trim());
const replayOutput = sandbox(["scripts/replay-native-code-debt.mjs"]);
const isolated = JSON.parse(replayOutput), original = JSON.parse(readFileSync("docs/operational-value/proof/native-code-debt/assessment.json"));
assert.deepEqual(isolated, original, "Fresh isolated complete assessment differs");
for (const slug of ["daily-code-debt-aider", "code-simplifier"]) {
  const file = `docs/operational-value/proof/native-code-debt/reports/github-gh-aw/${slug}-timeline.json`;
  assert.deepEqual(withoutGeneratedAt(JSON.parse(readFileSync(path.join(clean, file)))), withoutGeneratedAt(JSON.parse(readFileSync(file))));
}
const testOutput = sandbox(["--test", "tests/unit/native-code-debt.test.mjs"]);
assert.match(testOutput, /(?:# |ℹ )pass 12/);
writeFileSync(path.join(destination, "native-code-debt-clean-replay.log"), replayOutput);
writeFileSync(path.join(destination, "native-code-debt-clean-tests.log"), testOutput);
const receipt = { schemaVersion: 1, ...bundle, extraction: clean, isolation: probes, sandboxProfile: profile,
  freshGoBuildCache: true, unchangedBaselineDependenciesCopiedAndVerified: baseline.files,
  originalAssessmentMatches: true, wholeStandardTimelinesEqualExceptGeneratedAt: true, focusedTestsPassed: 12,
  finiteUsefulMeasuredWorkflowCount: isolated.finiteUsefulMeasuredWorkflowCount,
  nativeQuantities: Object.fromEntries(Object.entries(isolated.quantities).map(([key, row]) => [key, row.nativeUnits])),
  targetCodeExecuted: false, nodeModulesPresent: false,
  toolchain: "Pinned system Go/Node binaries and standard-library source closure; fresh isolated GOCACHE, GOPATH and HOME. No target code execution.",
  limitations: isolated.limitations };
writeFileSync(path.join(destination, "native-code-debt-clean-replay-receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
console.log(JSON.stringify(receipt, null, 2));
