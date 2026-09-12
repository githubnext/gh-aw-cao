import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  APP_PROFILES,
  buildGitHubAppManifest,
  deriveAppName,
  installationInstruction,
  isManifestCode,
  setRepositoryCredentials,
  validateAppName,
  validateInstallationScope,
} from "../../.github/cao/setup-github-apps.mjs";

const root = process.cwd();
const script = join(root, ".github", "cao", "setup-github-apps.mjs");

test("GitHub App profiles preserve separate permission ceilings", () => {
  const read = APP_PROFILES.find((profile) => profile.role === "read");
  const write = APP_PROFILES.find((profile) => profile.role === "write");

  assert.ok(read);
  assert.ok(write);
  assert.equal(read.variable, "GH_AW_GITHUB_READ_APP_ID");
  assert.equal(read.secret, "GH_AW_GITHUB_READ_APP_PRIVATE_KEY");
  assert.equal(write.variable, "GH_AW_GITHUB_WRITE_APP_ID");
  assert.equal(write.secret, "GH_AW_GITHUB_WRITE_APP_PRIVATE_KEY");
  assert.ok(Object.values(read.permissions).every((level) => level === "read"));
  assert.equal(write.permissions.actions, "write");
  assert.equal(write.permissions.administration, "read");
  assert.equal(write.permissions.contents, "write");
  assert.equal(write.permissions.issues, "write");
  assert.equal(write.permissions.pull_requests, "write");
});

test("GitHub App manifests are private and disable webhooks and OAuth", () => {
  const manifest = buildGitHubAppManifest({
    name: "octo-control-read",
    homepageUrl: "https://github.com/octo/control",
    redirectUrl: "http://127.0.0.1:1234/callback",
    description: "Read App",
    permissions: { contents: "read" },
  });

  assert.equal(manifest.public, false);
  assert.equal(manifest.request_oauth_on_install, false);
  assert.deepEqual(manifest.hook_attributes, {
    url: "https://github.com/octo/control",
    active: false,
  });
  assert.deepEqual(manifest.default_events, []);
  assert.deepEqual(manifest.default_permissions, { contents: "read" });
});

test("repository credentials keep the private key out of command arguments", () => {
  const calls = [];
  const profile = APP_PROFILES[0];
  const pem = "-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----\n";

  setRepositoryCredentials(profile, { clientId: "Iv1.example", pem }, "octo/control", (args, options = {}) => {
    calls.push({ args, input: options.input });
  });

  assert.deepEqual(calls[0], {
    args: ["variable", "set", profile.variable, "--repo", "octo/control", "--body", "Iv1.example"],
    input: undefined,
  });
  assert.deepEqual(calls[1], {
    args: ["secret", "set", profile.secret, "--repo", "octo/control"],
    input: pem,
  });
  assert.equal(calls.flatMap((call) => call.args).includes(pem), false);
});

test("dry run emits both exact manifests without requiring GitHub access", () => {
  const result = spawnSync(script, ["--repo", "githubnext/gh-aw-cao", "--dry-run"], {
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.repo, "githubnext/gh-aw-cao");
  assert.deepEqual(output.apps.map((app) => app.manifest.name), [
    "cao-githubnext-gh-aw-cao-read",
    "cao-githubnext-gh-aw-cao-write",
  ]);
  assert.deepEqual(output.apps.map((app) => app.manifest.redirect_url), [
    "http://127.0.0.1:0/callback",
    "http://127.0.0.1:0/callback",
  ]);
});

test("cao-setup is exposed as an executable Node CLI", () => {
  const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const result = spawnSync(script, ["--help"], { encoding: "utf8" });

  assert.equal(packageJson.bin["cao-setup"], ".github/cao/setup-github-apps.mjs");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Usage: cao-setup \[options\]/);
});

test("App setup validates callback codes and bounded generated names", () => {
  assert.equal(isManifestCode("abc_DEF-123"), true);
  assert.equal(isManifestCode("../bad"), false);
  assert.equal(deriveAppName("githubnext/gh-aw-cao", "read"), "cao-githubnext-gh-aw-cao-read");
  assert.ok(deriveAppName("very-long-organization/example-control-repository", "write").length <= 34);
  assert.throws(() => validateAppName("GitHub-control-read", "--read-app-name"), /must not begin with GitHub or Gist/);
  assert.throws(() => validateAppName("gist-control-write", "--write-app-name"), /must not begin with GitHub or Gist/);
});

test("App setup rejects all-repository installations", () => {
  assert.doesNotThrow(() => validateInstallationScope({ id: "123", repositorySelection: "selected" }, "octo"));
  let error;
  try {
    validateInstallationScope({ id: "123", repositorySelection: "all" }, "octo");
  } catch (caught) {
    error = caught;
  }
  assert.ok(error);
  assert.equal(error.name, "InstallationScopeError");
  assert.match(error.message, /installed for all octo repositories; select only approved repositories/);
  assert.match(error.message, /organizations\/octo\/settings\/installations\/123/);
});

test("App setup directs installation to only the control repository", () => {
  assert.equal(
    installationInstruction("octo/control"),
    'Choose "Only select repositories", select only octo/control, and save.',
  );
});