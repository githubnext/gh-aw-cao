import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "../..");
const scripts = path.join(root, ".github/skills/add-operational-value/scripts");

test("campaign workflow listing returns only direct manifest workflows", () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), "operational-value-campaign-list-"));
  mkdirSync(path.join(temporary, ".github/workflows"), { recursive: true });
  mkdirSync(path.join(temporary, "example"), { recursive: true });
  for (const workflow of ["example", "example-worker", "unrelated"]) {
    writeFileSync(path.join(temporary, ".github/workflows", `${workflow}.md`), `# ${workflow}\n`);
  }
  writeFileSync(path.join(temporary, "example/aw.yml"), `name: Example
includes:
  - ../aw.yml
  - .github/workflows/example.md
  - .github/workflows/example-worker.md
`);

  const output = execFileSync(
    process.execPath,
    [path.join(scripts, "list-workflows.mjs"), "--campaign", "example"],
    { cwd: temporary, encoding: "utf8" },
  );
  assert.equal(output, "example\nexample-worker\n");
  assert.equal(execFileSync(
    process.execPath,
    [path.join(scripts, "list-workflows.mjs"), "example-worker", "--campaign", "example"],
    { cwd: temporary, encoding: "utf8" },
  ), ".github/workflows/example-worker.md\n");
  assert.throws(() => execFileSync(
    process.execPath,
    [path.join(scripts, "list-workflows.mjs"), "unrelated", "--campaign", "example"],
    { cwd: temporary, stdio: "pipe" },
  ), /workflow not found: unrelated/);
});

test("campaign wiring creates one standard adapter and idempotent manifest entries", () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), "operational-value-campaign-wire-"));
  mkdirSync(path.join(temporary, "example/operational-value"), { recursive: true });
  writeFileSync(path.join(temporary, "example/aw.yml"), `name: Example
includes:
  - ../aw.yml
  - .github/workflows/example.md
`);
  writeFileSync(
    path.join(temporary, "example/operational-value/example.mjs"),
    "export const definition = {};\n",
  );
  const command = [
    path.join(scripts, "wire-campaign.mjs"),
    "example",
    "example",
    "--root",
    temporary,
  ];
  execFileSync(process.execPath, command);
  execFileSync(process.execPath, command);

  assert.equal(
    readFileSync(path.join(temporary, "example/operational-value.mjs"), "utf8"),
    readFileSync(path.join(root, ".github/skills/add-operational-value/templates/campaign-operational-value.mjs"), "utf8"),
  );
  const manifest = readFileSync(path.join(temporary, "example/aw.yml"), "utf8");
  assert.equal((manifest.match(/- operational-value\.mjs/g) ?? []).length, 1);
  assert.equal((manifest.match(/- operational-value\/example\.mjs/g) ?? []).length, 1);

  writeFileSync(path.join(temporary, "example/operational-value.mjs"), "custom adapter\n");
  assert.throws(
    () => execFileSync(process.execPath, command, { stdio: "pipe" }),
    /already exists and is not the standard campaign adapter/,
  );
});

test("CAO verification accepts namespaced metrics for multiple repositories", () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), "operational-value-multi-repository-"));
  const source = path.join(root, "daily-file-diet/operational-value/daily-file-diet.mjs");
  const valueModule = path.join(temporary, "daily-file-diet.mjs");
  const adapter = path.join(temporary, "operational-value.mjs");
  writeFileSync(valueModule, `
import * as original from ${JSON.stringify(pathToFileURL(source).href)};
export const definition = {
  ...original.definition,
  evidence: {
    ...original.definition.evidence,
    repositories: ["github/gh-aw", "githubnext/gh-aw-cao"]
  }
};
export const collectBatch = original.collectBatch;
export const scoreMetric = original.scoreMetric;
`);
  writeFileSync(adapter, `
const request = JSON.parse(await new Promise((resolve) => {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { input += chunk; });
  process.stdin.on("end", () => resolve(input));
}));
for (const repository of request.repositories) {
  for (const valueId of [
    "daily-file-diet.largest-file-health",
    "daily-file-diet.compliant-line-mass-share"
  ]) {
    console.log(JSON.stringify({repository, valueId, value: 0.5, timestamp: request.timestamp}));
  }
}
`);

  const output = execFileSync(
    process.execPath,
    [
      path.join(scripts, "verify-value-function.mjs"),
      "--cao-adapter",
      adapter,
      valueModule,
    ],
    { encoding: "utf8" },
  );
  assert.equal(output, `verified ${valueModule}\n`);
});
