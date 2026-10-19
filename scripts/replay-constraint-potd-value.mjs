import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const proof = "docs/operational-value/proof/constraint-potd";
const modulePath = "docs/operational-value/proof/functions/constraint-solving-potd.mjs";
const helper = "scripts/native-constraint-potd-value.mjs";
const skill = ".github/skills/add-operational-value";

export function replay() {
  if (process.platform !== "darwin") throw new Error("This isolated replay harness requires macOS sandbox-exec; the instrument itself is portable Node.js.");
  const temporary = realpathSync(mkdtempSync(path.join(os.tmpdir(), "cao-math-replay-")));
  try {
    for (const name of [proof, modulePath, helper, skill, "tests/unit/operational-value-constraint-potd.test.mjs"]) {
      const destination = path.join(temporary, name);
      mkdirSync(path.dirname(destination), { recursive: true });
      cpSync(path.join(root, name), destination, {
        recursive: true, filter: name => !name.split(path.sep).includes("node_modules"),
      });
    }
    const denied = [root.replace(/\/$/, ""), path.join(os.homedir(), ".copilot/session-state"),
      path.join(os.homedir(), ".copilot/copilot-worktrees")];
    const profile = `(version 1)(allow default)(deny network*)(deny file-read* ${denied.map(name =>
      `(subpath ${JSON.stringify(name)})`).join(" ")})`;
    const run = args => execFileSync("/usr/bin/sandbox-exec", ["-p", profile, process.execPath, ...args], {
      cwd: temporary, encoding: "utf8", timeout: 120000, stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: process.env.PATH, HOME: temporary, TMPDIR: temporary },
    });
    assert.match(run(["--input-type=module", "-e", `import{readFileSync}from'node:fs';
try{readFileSync(${JSON.stringify(path.join(root, "package.json"))});process.exit(2)}
catch(e){if(e.code!=='EPERM')throw e;console.log('denied')}`]), /denied/);
    assert.match(run(["--input-type=module", "-e", `import net from'node:net';
const s=net.connect({host:'127.0.0.1',port:9});s.on('connect',()=>process.exit(2));
s.on('error',e=>{if(!['EPERM','EACCES'].includes(e.code))throw e;console.log('denied')})`]), /denied/);
    const tests = run(["--test", "--test-reporter=tap", "tests/unit/operational-value-constraint-potd.test.mjs"]);
    assert.match(tests, /# fail 0/);
    run([`${skill}/scripts/verify-value-function.mjs`, "--collector", modulePath]);
    const expected = JSON.parse(readFileSync(path.join(temporary, proof, "reports/github-gh-aw/constraint-solving-potd-timeline.json")));
    delete expected.generatedAt;
    for (let iteration = 0; iteration < 2; iteration++) {
      run([`${skill}/scripts/evaluate.mjs`, "--root", temporary, "--end", "2026-10-18T15:00:12Z",
        "--function", modulePath, "--output-dir", "fresh", "--refresh", "github/gh-aw", "constraint-solving-potd"]);
      const fresh = JSON.parse(readFileSync(path.join(temporary, "fresh/github-gh-aw/constraint-solving-potd-timeline.json")));
      delete fresh.generatedAt;
      assert.deepEqual(fresh, expected);
    }
    writeFileSync(path.join(temporary, helper), `${readFileSync(path.join(temporary, helper), "utf8")}\n`);
    assert.throws(() => run(["--input-type=module", "-e", `await import('./${modulePath}')`]),
      error => /instrument dependency changed/.test(String(error.stderr)));
    const receipt = {
      schemaVersion: 1, kind: "independent-native-mathematical-replay",
      tests: Number(/# tests (\d+)/.exec(tests)?.[1]), collectorChecks: 1, standardRefreshes: 2,
      equality: "Complete timelines, definitions and evidence identical except generatedAt.",
      timelineSha256WithoutGeneratedAt: createHash("sha256").update(JSON.stringify(expected)).digest("hex"),
      networkDeniedByOSAndProbed: true, originalWorkspaceReadDeniedAndProbed: true,
      sharedSessionCachesDeniedByOS: true, gitCheckoutAndNodeModulesAbsent: true, helperTamperingRejected: true,
      periods: expected.snapshots.length,
      finiteValues: expected.snapshots.map(row => row.metrics["verified-worked-instances"]).filter(value => value !== null),
      nativeSubtotal: 3, selectedLessons: 4, missingWitnesses: 1, fullGoal: null, costs: null,
    };
    writeFileSync(path.join(root, proof, "integration-replay-receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
    return receipt;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  console.log(JSON.stringify(replay()));
}
