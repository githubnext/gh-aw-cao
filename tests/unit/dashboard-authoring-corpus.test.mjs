import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "../..");

test("generate-dashboard-ir corpus is indexed and valid", () => {
  execFileSync("npm", ["--prefix", "dashboard/site", "run", "validate:corpus"], {
    cwd: root,
    encoding: "utf8",
    stdio: "pipe",
  });
});

test("dashboard lint validates every dashboard.json", () => {
  const campaignJson = JSON.parse(readFileSync(resolve(root, "dashboard/site/package.json"), "utf8"));
  assert.match(campaignJson.scripts.lint, /npm run validate:dashboards/);
  execFileSync("npm", ["--prefix", "dashboard/site", "run", "validate:dashboards"], {
    cwd: root,
    encoding: "utf8",
    stdio: "pipe",
  });
});

test("dashboard lint excludes disposable staging without excluding campaign documents", () => {
  const stagingRoot = resolve(root, ".tmp");
  mkdirSync(stagingRoot, { recursive: true });
  const directory = mkdtempSync(resolve(stagingRoot, "dashboard-validator-"));
  try {
    writeFileSync(resolve(directory, "dashboard.json"), "not a canonical dashboard");
    const output = execFileSync("npm", ["--prefix", "dashboard/site", "run", "validate:dashboards"], {
      cwd: root, encoding: "utf8", stdio: "pipe",
    });
    assert.match(output, /Validated [1-9][0-9]* dashboard\.json file/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
