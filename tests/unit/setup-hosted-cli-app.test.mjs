import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  HOSTED_CLI_APP_PERMISSIONS,
  SENSITIVE_APP_PERMISSIONS,
  addRepositoriesToInstallation,
  assertLeastPrivilege,
  configurationInstructions,
  hostedCliManifest,
  hostedCliTargets,
  parseHostedCliArgs,
  writePrivateKey,
} from "../../.github/workflows/shared/setup-hosted-cli-app.mjs";

const script = path.join(".github", "workflows", "shared", "setup-hosted-cli-app.mjs");

test("hosted CLI App requests only the executor's repository permissions", () => {
  const manifest = hostedCliManifest("acme/control", "cao-acme-control-cli");
  assert.deepEqual(manifest.default_permissions, {
    actions: "write",
    contents: "write",
    metadata: "read",
    pull_requests: "write",
    workflows: "write",
  });
  for (const permission of SENSITIVE_APP_PERMISSIONS) {
    assert.equal(permission in manifest.default_permissions, false, permission);
  }
  assert.equal(manifest.public, false);
  assert.equal(manifest.hook_attributes.active, false);
  assert.equal(manifest.request_oauth_on_install, false);
  assert.deepEqual(manifest.default_events, []);
  assert.ok(Object.isFrozen(HOSTED_CLI_APP_PERMISSIONS));
});

test("least-privilege guard rejects sensitive and organization permissions", () => {
  for (const permission of ["administration", "repository_creation", "installation_repositories", "organization_secrets"]) {
    assert.throws(() => assertLeastPrivilege({ contents: "write", [permission]: "write" }), new RegExp(permission));
  }
});

test("hosted CLI arguments require a control repository and a key destination", () => {
  assert.throws(() => parseHostedCliArgs([]), /--repo/);
  assert.throws(() => parseHostedCliArgs(["--repo", "acme/control"]), /--private-key-out/);
  assert.throws(() => parseHostedCliArgs(["--repo", "acme"]), /invalid repository/);
  assert.throws(() => parseHostedCliArgs(["--repo", "acme/control", "--bogus"]), /unknown argument/);
  const options = parseHostedCliArgs([
    "--repo", "acme/control", "--target-repository", "acme/one", "--target-repository", "acme/two",
    "--private-key-out", "key.pem", "--no-open",
  ]);
  assert.deepEqual(options.targetRepositories, ["acme/one", "acme/two"]);
  assert.equal(options.openBrowser, false);
  assert.equal(parseHostedCliArgs(["--repo", "acme/control", "--dry-run"]).privateKeyOut, "");
});

test("hosted CLI targets stay within the control repository owner", () => {
  assert.deepEqual(hostedCliTargets("acme/control", ["acme/one", "acme/control"]), [
    { owner: "acme", repositories: ["control", "one"] },
  ]);
  assert.throws(() => hostedCliTargets("acme/control", ["other/one"]), /cannot be installed on other/);
});

test("private key is written owner-only and never overwritten", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "cao-hosted-cli-"));
  const file = path.join(directory, "key.pem");
  writePrivateKey(file, "-----BEGIN KEY-----");
  assert.equal(readFileSync(file, "utf8"), "-----BEGIN KEY-----\n");
  if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.throws(() => writePrivateKey(file, "replacement"), /EEXIST/);
  writeFileSync(path.join(directory, "existing"), "keep");
  assert.throws(() => writePrivateKey(path.join(directory, "existing"), "x"), /EEXIST/);
  assert.equal(readFileSync(path.join(directory, "existing"), "utf8"), "keep");
});

test("repository additions use the installation repository API", async () => {
  const calls = [];
  const runner = (args) => {
    calls.push(args);
    return args[1].startsWith("/repos/") ? "4242" : "";
  };
  assert.deepEqual(await addRepositoriesToInstallation(7, "acme", ["one"], runner), ["acme/one"]);
  assert.deepEqual(calls, [
    ["api", "/repos/acme/one", "--jq", ".id"],
    ["api", "-X", "PUT", "/user/installations/7/repositories/4242", "--silent"],
  ]);
  await assert.rejects(addRepositoriesToInstallation(7, "acme", ["one"], () => "not-an-id"), /repository ID/);
});

test("configuration instructions name the executor environment without key material", () => {
  const lines = configurationInstructions({
    repo: "acme/control",
    app: { id: "123", pem: "-----BEGIN SECRET-----" },
    privateKeyOut: "/secure/key.pem",
    environment: { GITHUB_SERVER_URL: "https://github.com" },
  });
  assert.deepEqual(lines, [
    "CAO_HOSTED_CLI_APP_ID=123",
    "CAO_HOSTED_CLI_PRIVATE_KEY_FILE=/secure/key.pem",
    "CAO_HOSTED_CLI_CONTROL_REPOSITORY=acme/control",
    "CAO_HOSTED_CLI_GITHUB_API_URL=https://api.github.com",
  ]);
  assert.equal(lines.join("\n").includes("SECRET"), false);
});

test("dry run prints the manifest without contacting GitHub", () => {
  const result = spawnSync(process.execPath, [script, "--repo", "acme/control", "--dry-run"], {
    encoding: "utf8",
    env: { ...process.env, PATH: "", GITHUB_SERVER_URL: "https://github.com" },
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.manifest.name, "cao-acme-control-cli");
  assert.equal(output.manifest.default_permissions.workflows, "write");
  assert.deepEqual(output.installationTargets, [{ owner: "acme", repositories: ["control"] }]);
});

test("setup help identifies the key file as temporary bootstrap material", () => {
  const result = spawnSync(process.execPath, [script, "--help"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /temporary bootstrap file/);
});
