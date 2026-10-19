import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { runTerminal } from "../helpers/terminal.mjs";

import {
  APP_PROFILES,
  authenticateExistingApp,
  appInstallationUrl,
  appPermissionsForServer,
  appRegistrationUrl,
  buildGitHubAppManifest,
  deriveAppName,
  deriveInstallationTargets,
  deriveWriteInstallationTargets,
  findInstallationForApp,
  githubApiUrl,
  githubServerUrl,
  installationIncludesRepository,
  installationIncludesTarget,
  installationInstruction,
  installationTargetInstruction,
  isManifestCode,
  listInstallationRepositoriesForApp,
  parseArgs,
  promptPrivateKey,
  selectedInstallationForSetup,
  setRepositoryAuthenticationMode,
  setRepositoryCredentials,
  validateAppName,
  validateInstallationScope,
} from "../../.github/workflows/shared/setup-github-apps.mjs";

const root = process.cwd();
const script = join(root, ".github", "workflows", "shared", "setup-github-apps.mjs");

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
  for (const profile of APP_PROFILES) {
    assert.equal(profile.permissions.repository_creation, undefined);
    assert.equal(profile.permissions.installation_repositories, undefined);
  }
});

test("existing App selection requires distinct read/write client IDs without creation options", () => {
  assert.equal(parseArgs(["--read-client-id", "Iv1.read", "--write-client-id", "Iv1.write"]).readClientId, "Iv1.read");
  assert.throws(() => parseArgs(["--read-client-id", "Iv1.read"]), /supplied together/);
  assert.throws(() => parseArgs(["--read-client-id", "Iv1.same", "--write-client-id", "Iv1.same"]), /distinct/);
  for (const option of [["--force"], ["--read-app-name", "new-read"]]) {
    assert.throws(() => parseArgs(["--read-client-id", "Iv1.read", "--write-client-id", "Iv1.write", ...option]), /cannot be combined/);
  }
});

function testAppCredentials() {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return { id: "42", clientId: "Iv1.read", pem: privateKey.export({ type: "pkcs8", format: "pem" }) };
}

test("private-key entry is hidden and restores terminal mode", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  input.isTTY = output.isTTY = true;
  const modes = [];
  input.setRawMode = (mode) => { modes.push(mode); };
  const visible = [];
  output.on("data", (chunk) => visible.push(chunk.toString()));
  const pem = "-----BEGIN PRIVATE KEY-----\nprivate-material\n-----END PRIVATE KEY-----\n";
  const pending = promptPrivateKey("read-only", { input, output });
  input.write(pem);
  assert.equal(await pending, pem);
  assert.doesNotMatch(visible.join(""), /private-material|BEGIN PRIVATE KEY/);
  assert.deepEqual(modes, [true, false]);
  await assert.rejects(promptPrivateKey("read-only", { input: { isTTY: false }, output }), /interactive terminal/);
});

test("private-key entry never echoes pasted material in a real terminal", {
  skip: process.platform === "win32",
}, async () => {
  let entered = false;
  const result = await runTerminal(process.execPath, ["--input-type=module", "-e", `
    import { promptPrivateKey } from ${JSON.stringify(pathToFileURL(script).href)};
    const pem = await promptPrivateKey("read-only");
    console.log(pem.includes("terminal-private-material") ? "key received" : "missing key");
  `], {
    env: process.env,
    onOutput(output, write) {
      if (!entered && output.includes("finish with its END line")) {
        entered = true;
        write("-----BEGIN PRIVATE KEY-----\nterminal-private-material\n-----END PRIVATE KEY-----\n");
      }
    },
  });
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /key received/);
  assert.doesNotMatch(result.stdout + result.stderr, /terminal-private-material|BEGIN PRIVATE KEY|END PRIVATE KEY/);
});

test("private-key entry fails closed on cancellation and incomplete input", async () => {
  for (const cancel of [true, false]) {
    const input = new PassThrough();
    const output = new PassThrough();
    input.isTTY = output.isTTY = true;
    const modes = [];
    input.setRawMode = (mode) => { modes.push(mode); };
    const pending = promptPrivateKey("read-only", { input, output });
    if (cancel) input.write("\u0003");
    else input.end("-----BEGIN PRIVATE KEY-----\n");
    await assert.rejects(pending, cancel ? /cancelled/ : /ended before/);
    assert.deepEqual(modes, [true, false]);
  }
});

test("approved App authentication uses its own credentials and enforces role ceilings", async () => {
  const { clientId, pem } = testAppCredentials();
  const profile = APP_PROFILES[0];
  const payload = {
    id: 42, client_id: clientId, slug: "approved-read", public: false,
    permissions: { ...profile.permissions, members: "read" },
  };
  const fetchImpl = async (url, options) => {
    assert.equal(url, "https://api.github.com/app");
    const jwt = options.headers.Authorization.slice("Bearer ".length).split(".");
    assert.equal(JSON.parse(Buffer.from(jwt[1], "base64url")).iss, clientId);
    return { ok: true, json: async () => payload };
  };
  const app = await authenticateExistingApp(clientId, pem, profile, { fetchImpl });
  assert.equal(app.id, "42");
  assert.equal(app.pem, pem);
  payload.public = true;
  await assert.rejects(authenticateExistingApp(clientId, pem, profile, { fetchImpl }), /selected private/);
  payload.public = false;
  payload.permissions.installation_repositories = "write";
  await assert.rejects(authenticateExistingApp(clientId, pem, profile, { fetchImpl }), /unsupported permission/);
  delete payload.permissions.installation_repositories;
  payload.permissions.contents = "write";
  await assert.rejects(authenticateExistingApp(clientId, pem, profile, { fetchImpl }), /requires contents: read/);
  payload.permissions.contents = "read";
  payload.client_id = "Iv1.other";
  await assert.rejects(authenticateExistingApp(clientId, pem, profile, { fetchImpl }), /selected private/);
});

test("App-authenticated installation lookup needs no organization administrator inventory", async () => {
  const app = testAppCredentials();
  const payload = { id: 123, app_id: 42, account: { login: "Octo" }, repository_selection: "selected" };
  let status = 200;
  const fetchImpl = async (url, options) => {
    assert.equal(url, "https://github.acme.test/api/v3/orgs/octo/installation");
    assert.match(options.headers.Authorization, /^Bearer /);
    return { ok: status === 200, status, json: async () => payload };
  };
  const options = { fetchImpl, apiUrl: "https://github.acme.test/api/v3" };
  assert.deepEqual(await findInstallationForApp(app, "octo", options), { id: "123", repositorySelection: "selected" });
  status = 404;
  assert.equal(await findInstallationForApp(app, "octo", options), undefined);
  status = 403;
  await assert.rejects(findInstallationForApp(app, "octo", options), /HTTP 403/);
  status = 200;
  payload.account.login = "another-owner";
  await assert.rejects(findInstallationForApp(app, "octo", options), /unexpected App installation identity/);
});

test("App setup verifies every selected repository and fails closed on unreadable or broad installations", async () => {
  const target = { owner: "octo", repositories: ["control", "service"] };
  const installation = { id: "123", repositorySelection: "selected" };
  const options = {
    findInstallation: async () => installation,
    listRepositories: async () => ["octo/control", "octo/service"],
  };
  assert.equal(await selectedInstallationForSetup({}, target, options), installation);
  options.listRepositories = async () => ["octo/control"];
  assert.equal(await selectedInstallationForSetup({}, target, options), undefined);
  options.listRepositories = async () => { throw new Error("HTTP 403"); };
  await assert.rejects(selectedInstallationForSetup({}, target, options), /unable to verify.*HTTP 403/);
  installation.repositorySelection = "all";
  options.listRepositories = () => assert.fail("must reject all-repository scope before minting a token");
  await assert.rejects(selectedInstallationForSetup({}, target, options), { name: "InstallationScopeError" });
});

test("existing App dry run supports enterprise scope without credentials or new manifests", () => {
  const result = spawnSync(script, [
    "--repo", "githubnext/gh-cao", "--read-client-id", "Iv1.read", "--write-client-id", "Iv1.write", "--dry-run",
  ], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(output.apps.map(({ clientId }) => clientId), ["Iv1.read", "Iv1.write"]);
  assert.ok(output.apps.every((app) => !Object.hasOwn(app, "manifest")));
  assert.ok(output.installationTargets.read.some(({ owner }) => owner === "github"));
  assert.deepEqual(output.installationTargets.write, [{ owner: "githubnext", repositories: ["gh-cao"] }]);
  assert.doesNotMatch(result.stdout, /pem|PRIVATE KEY/);
});

test("GitHub App manifests omit the unsupported campaigns permission", () => {
  const read = APP_PROFILES.find((profile) => profile.role === "read");
  assert.ok(read);
  assert.equal(Object.hasOwn(appPermissionsForServer(read, "https://github.com"), "campaigns"), false);
  assert.equal(Object.hasOwn(appPermissionsForServer(read, "https://contoso-aw.ghe.com"), "campaigns"), false);
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

test("GitHub App manifests remain private even if a public value is supplied", () => {
  const manifest = buildGitHubAppManifest({
    name: "octo-control-read",
    homepageUrl: "https://github.com/octo/control",
    redirectUrl: "http://127.0.0.1:1234/callback",
    description: "Read App",
    permissions: { contents: "read" },
    public: true,
  });

  assert.equal(manifest.public, false);
});

test("App registration targets organization ownership", () => {
  assert.equal(
    appRegistrationUrl("octo", "state"),
    "https://github.com/organizations/octo/settings/apps/new?state=state",
  );
});

test("GitHub App setup honors GitHub Enterprise Cloud host configuration", () => {
  assert.equal(
    githubServerUrl({ GH_HOST: "contoso-aw.ghe.com" }),
    "https://contoso-aw.ghe.com",
  );
  assert.equal(
    githubServerUrl({ GITHUB_SERVER_URL: "https://example.ghe.com/" }),
    "https://example.ghe.com",
  );
  assert.equal(
    appRegistrationUrl("octo", "state", "https://contoso-aw.ghe.com"),
    "https://contoso-aw.ghe.com/organizations/octo/settings/apps/new?state=state",
  );
  assert.equal(
    appInstallationUrl("octo", "control-read", "https://github.com"),
    "https://github.com/apps/control-read/installations/new",
  );
  assert.equal(
    appInstallationUrl("octo", "control-read", "https://contoso-aw.ghe.com"),
    "https://contoso-aw.ghe.com/organizations/octo/settings/apps/control-read/installations",
  );
  assert.equal(githubApiUrl({ GH_HOST: "github.com" }), "https://api.github.com");
  assert.equal(githubApiUrl({ GH_HOST: "contoso-aw.ghe.com" }), "https://api.contoso-aw.ghe.com");
  assert.equal(githubApiUrl({ GH_HOST: "github.acme.test" }), "https://github.acme.test/api/v3");
  assert.equal(
    githubApiUrl({ GITHUB_API_URL: "https://github.acme.test/api/v3/" }),
    "https://github.acme.test/api/v3",
  );
});

test("App setup derives selected-repository installations from CAO policy", () => {
  const targets = deriveInstallationTargets({
    "control-plane": {
      scope: {
        "allowed-repositories": [
          "other-org/service-b",
          "octo/service-a",
          "other-org/service-a",
        ],
      },
    },
  }, "octo/control");

  assert.deepEqual(targets, [
    { owner: "octo", repositories: ["control", "service-a"] },
    { owner: "other-org", repositories: ["service-a", "service-b"] },
  ]);
});

test("App setup scopes write installations independently", () => {
  assert.deepEqual(
    deriveWriteInstallationTargets("octo/control"),
    [{ owner: "octo", repositories: ["control"] }],
  );
  assert.deepEqual(
    deriveWriteInstallationTargets("octo/control", ["octo/output-b", "octo/output-a"]),
    [{ owner: "octo", repositories: ["output-a", "output-b"] }],
  );
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

test("read App setup activates App authentication independently of the write App", () => {
  const calls = [];
  setRepositoryAuthenticationMode("octo/control", (args) => calls.push(args));
  assert.deepEqual(calls, [[
    "variable", "set", "GH_AW_GITHUB_AUTH_MODE", "--repo", "octo/control", "--body", "app",
  ]]);
});

test("App setup verifies selected repositories with a short-lived installation token", async () => {
  const calls = [];
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const app = {
    id: "42",
    pem: privateKey.export({ type: "pkcs8", format: "pem" }),
  };
  const fetchImpl = async (url, options) => {
    calls.push({ url, authorization: options.headers.Authorization });
    if (url.endsWith("/access_tokens")) {
      assert.deepEqual(JSON.parse(options.body), { permissions: { metadata: "read" } });
      return {
        ok: true,
        json: async () => ({ token: "installation-token" }),
      };
    }
    return {
      ok: true,
      json: async () => ({ total_count: 1, repositories: [{ full_name: "octo/control" }] }),
    };
  };

  assert.deepEqual(
    await listInstallationRepositoriesForApp(app, "123", { fetchImpl }),
    ["octo/control"],
  );
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "https://api.github.com/app/installations/123/access_tokens");
  assert.match(calls[0].authorization, /^Bearer eyJ/);
  assert.equal(calls[1].url, "https://api.github.com/installation/repositories?per_page=100&page=1");
  assert.equal(calls[1].authorization, "Bearer installation-token");
});

test("organization dry run emits private manifests without requiring GitHub access", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "cao-setup-policy-"));
  const policy = join(directory, "cao.json");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(policy, JSON.stringify({
    version: 1,
    "gh-aw-version": "v0.89.21",
    "control-plane": {
      scope: { "allowed-repositories": ["githubnext/gh-cao"] },
      campaigns: {},
    },
  }));
  const result = spawnSync(script, [
    "--repo", "githubnext/gh-cao",
    "--policy", policy,
    "--dry-run",
  ], {
    encoding: "utf8",
  });

  test("organization dry run uses the configured GitHub Enterprise Cloud host", (t) => {
    const directory = mkdtempSync(join(tmpdir(), "cao-setup-policy-"));
    const policy = join(directory, "cao.json");
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    writeFileSync(policy, JSON.stringify({
      version: 1,
      "gh-aw-version": "v0.89.21",
      "control-plane": {
        scope: { "allowed-repositories": ["platform/control"] },
        campaigns: {},
      },
    }));
    const result = spawnSync(script, [
      "--repo", "platform/control",
      "--policy", policy,
      "--dry-run",
    ], {
      encoding: "utf8",
      env: { ...process.env, GH_HOST: "contoso-aw.ghe.com" },
    });

    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.ok(output.apps.every(
      (app) => app.manifest.url === "https://contoso-aw.ghe.com/platform/control",
    ));
  });

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.repo, "githubnext/gh-cao");
  assert.deepEqual(output.installationTargets.write, [
    { owner: "githubnext", repositories: ["gh-cao"] },
  ]);
  assert.ok(output.apps.every((app) => app.manifest.public === false));
  assert.deepEqual(output.apps.map((app) => app.manifest.name), [
    "cao-githubnext-gh-cao-read",
    "cao-githubnext-gh-cao-write",
  ]);
  assert.deepEqual(output.apps.map((app) => app.manifest.redirect_url), [
    "http://127.0.0.1:0/callback",
    "http://127.0.0.1:0/callback",
  ]);
});

test("organization App setup rejects cross-organization policy scope", () => {
  const result = spawnSync(script, ["--repo", "githubnext/gh-cao", "--dry-run"], {
    encoding: "utf8",
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /private organization-owned Apps cannot be installed on github/);
  assert.match(result.stderr, /configure existing enterprise-owned Apps/);
});

test("cao-setup is exposed as an executable Node CLI", (t) => {
  const campaignJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const directory = mkdtempSync(join(tmpdir(), "cao-setup-bin-"));
  const bin = join(directory, "cao-setup");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  symlinkSync(script, bin);
  const result = spawnSync(bin, ["--help"], { encoding: "utf8" });

  assert.equal(campaignJson.bin["cao-setup"], ".github/workflows/shared/setup-github-apps.mjs");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Usage: cao-setup \[options\]/);
});

test("App setup validates callback codes and bounded generated names", () => {
  assert.equal(isManifestCode("abc_DEF-123"), true);
  assert.equal(isManifestCode("../bad"), false);
  assert.equal(deriveAppName("githubnext/gh-cao", "read"), "cao-githubnext-gh-cao-read");
  assert.equal(
    deriveAppName("octodemo/zava-social-cao-ops-20260929111840", "read"),
    "cao-octodemo-zava-social-cao-read",
  );
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

test("App setup verifies the control repository is selected", () => {
  const installation = { id: "123", repositorySelection: "selected" };
  assert.equal(
    installationIncludesRepository(installation, "octo/control", () => ["octo/other", "octo/control"]),
    true,
  );
  assert.equal(
    installationIncludesRepository(installation, "octo/control", () => ["octo/other"]),
    false,
  );
});

test("App setup verifies every selected repository for an account installation", () => {
  const installation = { id: "123", repositorySelection: "selected" };
  const target = { owner: "other-org", repositories: ["service-a", "service-b"] };
  assert.equal(
    installationIncludesTarget(installation, target, () => [
      "other-org/service-a",
      "other-org/service-b",
      "other-org/unrelated",
    ]),
    true,
  );
  assert.equal(
    installationIncludesTarget(installation, target, () => ["other-org/service-a"]),
    false,
  );
  assert.equal(
    installationTargetInstruction(target),
    'Choose "other-org", choose "Only select repositories", select other-org/service-a, other-org/service-b, and save.',
  );
});
