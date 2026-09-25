import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..", "..");
const cao = path.join(root, "activity", "cao.mjs");

test("operational-value runs locally and contains an injected GitHub permission failure", () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), "cao-operational-value-local-"));
  const packages = path.join(temporary, "packages");
  const source = path.join(temporary, "source");
  const archive = path.join(temporary, "repository.tar.gz");
  const fakeGh = path.join(temporary, "gh");
  const output = path.join(temporary, "operational-values.jsonl");
  const token = "read-only-test-token";
  const timestamp = "2026-09-24T19:30:24Z";
  const commit = "0123456789abcdef0123456789abcdef01234567";

  try {
    mkdirSync(packages);
    mkdirSync(path.join(source, "pkg"), { recursive: true });
    writeFileSync(path.join(source, "pkg", "large.go"), "line\n".repeat(1200));
    writeFileSync(path.join(source, "pkg", "healthy.go"), "line\n".repeat(800));
    spawnSync("tar", ["-czf", archive, "-C", source, "."], { stdio: "inherit" });
    cpSync(path.join(root, "daily-file-diet"), path.join(packages, "daily-file-diet"), { recursive: true });
    cpSync(path.join(root, "dependabot"), path.join(packages, "dependabot"), { recursive: true });
    writeFileSync(output, `${JSON.stringify({
      schema_version: 2,
      kind: "operational_value",
      operational_value: {
        timestamp: "2026-09-20T10:00:00.000Z",
        repository: "githubnext/gh-aw-cao",
        campaign: "dependabot",
        campaign_id: "campaign:dependabot",
        value_id: "dependabot-update-planner.consumed-plan-share",
        value: 1,
      },
    })}\n`);
    writeFileSync(fakeGh, `#!/usr/bin/env bash
set -euo pipefail
if [[ " $* " == *"repos/github/gh-aw/tarball/"* ]]; then
  cat ${JSON.stringify(archive)}
elif [[ " $* " == *"repos/github/gh-aw/commits"* ]]; then
  printf '[{"sha":"${commit}","commit":{"committer":{"date":"2026-09-24T18:00:00Z"}}}]\\n'
elif [[ " $* " == *"repos/githubnext/gh-aw-cao/issues"* ]]; then
  echo "gh: Resource not accessible by integration: $GH_TOKEN (HTTP 403)" >&2
  exit 1
else
  echo "unexpected gh invocation: $*" >&2
  exit 1
fi
`);
    chmodSync(fakeGh, 0o755);

    const execution = spawnSync(process.execPath, [
      cao,
      "operational-value",
      "--database", path.join(temporary, "dashboard.sqlite"),
      "--root", packages,
      "--output", output,
      "--timestamp", timestamp,
      "--repository", "github/gh-aw",
      "--repository", "githubnext/gh-aw-cao",
      "--retention-days", "30",
    ], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${temporary}:${process.env.PATH}`,
        CAO_OPERATIONAL_VALUE_GH_TOKEN: token,
      },
    });

    assert.equal(execution.status, 0, execution.stderr);
    assert.match(execution.stderr, /Warning: .*dependabot\/operational-value\.mjs failed.*HTTP 403/);
    assert.doesNotMatch(execution.stderr, new RegExp(token));
    const result = JSON.parse(execution.stdout);
    assert.deepEqual(result.warnings.map(({ package: campaign }) => campaign), ["dependabot"]);
    assert.doesNotMatch(result.warnings[0].message, new RegExp(token));
    assert.deepEqual(
      result.values.map(({ campaign, valueId }) => ({ campaign, valueId })),
      [
        { campaign: "daily-file-diet", valueId: "daily-file-diet.largest-file-health" },
        { campaign: "daily-file-diet", valueId: "daily-file-diet.compliant-line-mass-share" },
      ],
    );

    const envelopes = readFileSync(output, "utf8").trim().split("\n").map(JSON.parse);
    assert.deepEqual(
      envelopes.map(({ operational_value: value }) => ({
        campaign: value.campaign,
        valueId: value.value_id,
        value: value.value,
      })),
      [
        { campaign: "dependabot", valueId: "dependabot-update-planner.consumed-plan-share", value: 1 },
        { campaign: "daily-file-diet", valueId: "daily-file-diet.largest-file-health", value: 0.8325 },
        { campaign: "daily-file-diet", valueId: "daily-file-diet.compliant-line-mass-share", value: 0.4 },
      ],
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
