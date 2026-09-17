import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
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
  const packageJson = JSON.parse(readFileSync(resolve(root, "dashboard/site/package.json"), "utf8"));
  assert.match(packageJson.scripts.lint, /npm run validate:dashboards/);
  execFileSync("npm", ["--prefix", "dashboard/site", "run", "validate:dashboards"], {
    cwd: root,
    encoding: "utf8",
    stdio: "pipe",
  });
});
