import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  APP_PROFILES,
  appInstallationUrl,
  appRegistrationUrl,
  buildGitHubAppManifest,
  deriveAppName,
  deriveWriteInstallationTargets,
  findInstallationForApp,
  githubApiUrl,
  githubServerUrl,
  installationIncludesTarget,
  installationTargetInstruction,
  isManifestCode,
  listInstallationRepositoriesForApp,
  repositoryState,
  repositoryVariableValue,
  selectedInstallationForSetup,
  validateAppName,
  validateInstallationScope,
} from "../../.github/workflows/shared/github-apps.mjs";

const root = process.cwd();
const helpers = join(root, ".github", "workflows", "shared", "github-apps.mjs");

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

function testAppCredentials() {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return { id: "42", clientId: "Iv1.read", pem: privateKey.export({ type: "pkcs8", format: "pem" }) };
}

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

test("GitHub App manifests omit the unsupported campaigns permission", () => {
  const read = APP_PROFILES.find((profile) => profile.role === "read");
  assert.ok(read);
  assert.equal(Object.hasOwn(read.permissions, "campaigns"), false);
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

test("repository credential inspection reads paginated names and individual variables", () => {
  const calls = [];
  const state = repositoryState("octo/control", (args) => {
    calls.push(args);
    return args[1].includes("/variables?") ? "GH_AW_GITHUB_READ_APP_ID\n" : "GH_AW_GITHUB_READ_APP_PRIVATE_KEY\n";
  });
  assert.deepEqual(state.variables, new Set(["GH_AW_GITHUB_READ_APP_ID"]));
  assert.deepEqual(state.secrets, new Set(["GH_AW_GITHUB_READ_APP_PRIVATE_KEY"]));
  assert.equal(repositoryVariableValue("octo/control", "GH_AW_GITHUB_READ_APP_ID", (args) => {
    calls.push(args);
    return "Iv1.read";
  }), "Iv1.read");
  assert.deepEqual(calls, [
    ["api", "/repos/octo/control/actions/variables?per_page=100", "--paginate", "--jq", ".variables[].name"],
    ["api", "/repos/octo/control/actions/secrets?per_page=100", "--paginate", "--jq", ".secrets[].name"],
    ["api", "/repos/octo/control/actions/variables/GH_AW_GITHUB_READ_APP_ID", "--jq", ".value"],
  ]);
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

test("GitHub App helpers do not expose a standalone setup CLI", () => {
  const campaignJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
  assert.equal(Object.hasOwn(campaignJson.bin, "cao-setup"), false);
  assert.equal(Object.hasOwn(campaignJson.scripts, "setup:github-apps"), false);
  assert.deepEqual(lock.packages[""].bin, campaignJson.bin);
  assert.equal(existsSync(join(root, ".github", "workflows", "shared", "setup-github-apps.mjs")), false);
  assert.doesNotMatch(readFileSync(helpers, "utf8"), /^#!|Usage: cao-setup|function main\(|export function parseArgs/m);
  if (process.platform !== "win32") {
    assert.equal(statSync(helpers).mode & 0o111, 0);
  }
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
