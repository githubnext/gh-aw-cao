import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { packageOwned } from "./package-native-go-quality.mjs";
import { base, readJson, sha256 } from "../docs/operational-value/proof/native-go-quality/custody.mjs";

const destination = process.argv[2];
const sharedCache = process.argv[3];
if (!destination || !path.isAbsolute(destination) || !sharedCache || !path.isAbsolute(sharedCache)) throw new Error("Supply external artifact directory and read-only shared cache path for denied-read probes");
const bundle = packageOwned(destination);
const clean = mkdtempSync(path.join(destination, "clean-extraction-"));
execFileSync("python3", ["-c", `
import io,json,pathlib,sys,tarfile,hashlib
root=pathlib.Path(sys.argv[1]); clean=pathlib.Path(sys.argv[2])
m=json.loads((root/'native-go-quality.manifest.json').read_bytes())
expected={r['path']:r for r in m['files']}
b=b''.join((root/p['file']).read_bytes() for p in m['chunks'])
with tarfile.open(fileobj=io.BytesIO(b),mode='r:gz') as t:
    members=t.getmembers()
    assert len(members)==len(expected) and {r.name for r in members}==set(expected)
    for r in members:
        assert r.isfile() and not pathlib.PurePosixPath(r.name).is_absolute() and '..' not in pathlib.PurePosixPath(r.name).parts
        data=t.extractfile(r).read()
        assert len(data)==expected[r.name]['bytes'] and hashlib.sha256(data).hexdigest()==expected[r.name]['sha256']
        target=clean/r.name; target.parent.mkdir(parents=True,exist_ok=True); target.write_bytes(data)
assert not list(clean.rglob('.git')) and not list(clean.rglob('node_modules'))
`, destination, clean]);
for (const directory of ["home", "tmp", "go-build", "gopath"]) mkdirSync(path.join(clean, directory));
const workspace = process.cwd();
const ownBuildCache = path.resolve(destination, "../go-quality-build-cache");
const profile = `(version 1)(allow default)(deny network*)(deny file-read* (subpath ${JSON.stringify(workspace)}) (subpath ${JSON.stringify(sharedCache)}) (subpath ${JSON.stringify(ownBuildCache)}))`;
const env = {
  PATH: process.env.PATH, HOME: path.join(clean, "home"), TMPDIR: `${path.join(clean, "tmp")}/`,
  GOPROXY: "off", GOSUMDB: "off", GOTOOLCHAIN: "local", GOENV: "off", GOWORK: "off",
  GOCACHE: path.join(clean, "go-build"), NATIVE_GO_QUALITY_GOCACHE: path.join(clean, "go-build"),
  GOPATH: path.join(clean, "gopath"),
};
const probe = `
const fs=require("node:fs"),net=require("node:net"),assert=require("node:assert/strict");
for(const file of process.argv.slice(1)){let code;try{fs.readFileSync(file)}catch(error){code=error.code}assert.ok(["EPERM","EACCES"].includes(code),file+" was not denied: "+code)}
assert.ok(!fs.existsSync(".git")&&!fs.existsSync("node_modules"));
const socket=net.createConnection({host:"127.0.0.1",port:9});
socket.on("error",error=>{assert.ok(["EPERM","EACCES"].includes(error.code));console.log(JSON.stringify({networkDenied:true,originalWorkspaceDenied:true,sharedGitCacheDenied:true,gitDirectory:false,nodeModules:false}))});
socket.on("connect",()=>{socket.destroy();throw Error("Network isolation failed")});
`;
const probeOutput = execFileSync("/usr/bin/sandbox-exec", ["-p", profile, process.execPath, "-e", probe,
  path.join(workspace, "CODEBASE.yml"), path.join(sharedCache, "config")], { cwd: clean, env, encoding: "utf8" }).trim();
const replayOutput = execFileSync("/usr/bin/sandbox-exec", ["-p", profile, process.execPath, "scripts/replay-native-go-quality.mjs"], {
  cwd: clean, env, encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: 180000,
});
const testOutput = execFileSync("/usr/bin/sandbox-exec", ["-p", profile, process.execPath, "--test", "tests/unit/native-go-quality.test.mjs"], {
  cwd: clean, env, encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: 180000,
});
const isolated = JSON.parse(replayOutput), original = readJson(new URL("assessment.json", base));
if (JSON.stringify(isolated) !== JSON.stringify(original)) throw new Error("Clean extracted replay differs from original native assessment");
writeFileSync(path.join(destination, "clean-replay.log"), replayOutput);
writeFileSync(path.join(destination, "clean-tests.log"), testOutput);
const receipt = { schemaVersion: 1, ...bundle, extraction: clean,
  isolation: JSON.parse(probeOutput), sandboxProfile: profile, sourceBytesVerifiedBeforeExtraction: true,
  network: "Denied at OS sandbox boundary including loopback; explicit EPERM/EACCES probe passed.",
  toolchain: "Go 1.25.3, fresh isolated GOCACHE/GOPATH/HOME; system toolchain/stdlib only",
  replayMatchesOriginal: true, focusedTestsPassed: /(?:pass 11|# pass 11)/.test(testOutput),
  nativeAssessmentSha256: sha256(Buffer.from(replayOutput)),
  finiteUsefulMeasuredWorkflowCount: isolated.finiteUsefulMeasuredWorkflowCount,
  nativeQuantities: Object.fromEntries(Object.entries(isolated.quantities).map(([slug, row]) => [slug, row.nativeQuantity])),
  targetCodeExecution: false, unchangedBaselineRuntimeDependencies: false,
};
if (!receipt.focusedTestsPassed) throw new Error("Expected all eleven focused tests in clean extraction");
writeFileSync(new URL("clean-replay-receipt.json", base), `${JSON.stringify(receipt, null, 2)}\n`);
console.log(JSON.stringify(receipt, null, 2));
