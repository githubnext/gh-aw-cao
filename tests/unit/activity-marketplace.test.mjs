import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";

import { parsePolicy } from "../../.github/workflows/shared/policy.mjs";
import { parsePackageManifest, resolveMarketplace } from "../../activity/marketplace.mjs";

const SHA = "a".repeat(40);

function response(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return payload;
    },
  };
}

function registry(id, overrides = {}) {
  return {
    id,
    repository: "example/packages",
    ref: "main",
    auth: { type: "none" },
    ...overrides,
  };
}

function registryFetch({
  manifest = "name: Demo\ndescription: Example\nincludes:\n  - demo.md\n",
  readme = "# Demo\n\nExample package readme.\n",
  readmeUnavailable = false,
  fail = false,
  repository = { private: false, visibility: "public", stargazers_count: 12, forks_count: 3 },
} = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    if (fail) return response({}, 503);
    if (url.includes("/commits/")) return response({ sha: SHA });
    if (url.endsWith("/repos/example/packages")) return response(repository);
    if (url.includes("/git/trees/")) {
      return response({
        tree: [
          { type: "blob", path: "demo/aw.yml", sha: "blob" },
          { type: "blob", path: "demo/README.md", sha: "readme", size: readme.length },
        ],
      });
    }
    if (url.endsWith("/git/blobs/readme")) {
      return readmeUnavailable
        ? response({}, 404)
        : response({ encoding: "base64", content: Buffer.from(readme).toString("base64") });
    }
    if (url.includes("/git/blobs/")) {
      return response({ encoding: "base64", content: Buffer.from(manifest).toString("base64") });
    }
    throw new Error(`unexpected URL: ${url}`);
  };
  return { calls, fetchImpl };
}

test("package manifests normalize immutable coordinates and the canonical add command", () => {
  const normalized = parsePackageManifest("name: Demo\nversion: v1\nincludes:\n  - workflow.md\n", {
    registryId: "official",
    registryName: "Official",
    precedence: 0,
    repository: "example/packages",
    path: "demo/aw.yml",
    ref: "main",
    resolvedCommit: SHA,
  });
  assert.equal(normalized.id, "example/packages/demo");
  assert.equal(normalized.source, `example/packages/demo@${SHA}`);
  assert.equal(normalized["add-command"], `./cao.sh add example/packages/demo@${SHA}`);
  assert.deepEqual(normalized["repository-link"], {
    relation: "repository",
    href: "https://github.com/example/packages",
    label: "Open example/packages on GitHub",
  });
  assert.deepEqual(normalized.contents, ["workflow.md"]);
});

test("marketplace repository links use the configured GitHub Enterprise host", () => {
  const normalized = parsePackageManifest("name: Demo\n", {
    registryId: "enterprise",
    registryName: "Enterprise",
    precedence: 0,
    repository: "example/packages",
    apiUrl: "https://github.example/api/v3",
    path: "demo/aw.yml",
    ref: "main",
    resolvedCommit: SHA,
  });
  assert.equal(normalized["repository-link"].href, "https://github.example/example/packages");
});

test("packages carry the README preview published beside their manifest", async () => {
  const fake = registryFetch();
  const result = await resolveMarketplace({ registries: [registry("official")] }, { fetchImpl: fake.fetchImpl });
  assert.equal(result.packages[0].readme, "# Demo\n\nExample package readme.\n");
  assert.equal(result.packages[0]["readme-path"], "demo/README.md");
});

test("marketplace accepts a pre-minted GitHub App installation token", async () => {
  const fake = registryFetch();
  await resolveMarketplace({
    registries: [registry("official", { auth: { type: "github-app", secret: "APP_TOKEN" } })],
  }, {
    fetchImpl: fake.fetchImpl,
    environment: { APP_TOKEN: "installation-token" },
  });
  assert.equal(fake.calls[0].init.headers.Authorization, ["Bearer", "installation-token"].join(" "));
});

test("marketplace records include public GitHub repository counts but no inferred signals", async () => {
  const fake = registryFetch();
  const result = await resolveMarketplace({
    registries: [registry("approved")],
  }, { fetchImpl: fake.fetchImpl });
  const pkg = result.packages[0];
  assert.equal(pkg.stars, 12);
  assert.equal(pkg.forks, 3);
  for (const field of ["verification-status", "verification-source", "maintenance-status",
    "maintenance-source", "last-maintained-at", "popularity-source", "signals-observed-at",
    "installation-status", "adoption-count", "adoption-source"]) {
    assert.equal(Object.hasOwn(pkg, field), false, field);
  }
});

test("private, inaccessible or incomplete repositories never leak counts", async () => {
  for (const repository of [
    { private: true, stargazers_count: 500, forks_count: 50 },
    { private: false, visibility: "public", stargazers_count: 12 },
    null,
  ]) {
    const fake = registryFetch({ repository });
    const fetchImpl = async (url, init) => url.endsWith("/repos/example/packages") && repository === null
      ? response({}, 403)
      : fake.fetchImpl(url, init);
    const { packages } = await resolveMarketplace({ registries: [registry("private")] }, { fetchImpl });

    assert.equal(packages.length, 1);
    assert.equal(packages[0].stars, null);
    assert.equal(packages[0].forks, null);
  }
});

test("installed records never contribute marketplace package fields", async () => {
  const fake = registryFetch();
  const result = await resolveMarketplace({ registries: [registry("official")] }, {
    fetchImpl: fake.fetchImpl,
    controlRepository: "example/control",
    installedRecords: [
      { source: "example/packages/demo@main", resolvedCommit: SHA },
      { source: "example/packages/demo@main", resolvedCommit: SHA },
      { source: "example/packages/other@main", resolvedCommit: "invalid" },
    ],
  });
  const missing = await resolveMarketplace({ registries: [registry("official")] }, {
    fetchImpl: fake.fetchImpl, controlRepository: "example/control", installedRecords: [],
  });
  assert.deepEqual(result.packages, missing.packages);
});

test("an unreadable README leaves the package resolvable", async () => {
  const fake = registryFetch({ readmeUnavailable: true });
  const result = await resolveMarketplace({ registries: [registry("official")] }, { fetchImpl: fake.fetchImpl });
  assert.equal(result.diagnostics[0].status, "available");
  assert.equal(result.packages[0].readme, "");
  assert.equal(result.packages[0]["readme-path"], "");
});

test("marketplace resolves multiple registries in order and isolates failures", async () => {
  const healthy = registryFetch();
  const unavailable = registryFetch({ fail: true });
  const result = await resolveMarketplace({
    registries: [
      registry("unavailable", { "api-url": "https://unavailable.invalid/api/v3" }),
      registry("third-party"),
    ],
  }, {
    fetchImpl: async (url, init) => (
      url.includes("unavailable.invalid")
        ? unavailable.fetchImpl(url, init)
        : healthy.fetchImpl(url, init)
    ),
  });
  assert.equal(result.packages.length, 1);
  assert.equal(result.packages[0]["registry-id"], "third-party");
  assert.deepEqual(result.diagnostics.map(({ status }) => status), ["unavailable", "available"]);
});

test("registry precedence keeps the earliest duplicate package", async () => {
  const fake = registryFetch();
  const result = await resolveMarketplace({
    registries: [registry("first"), registry("second")],
  }, { fetchImpl: fake.fetchImpl });
  assert.equal(result.packages.length, 1);
  assert.equal(result.packages[0]["registry-id"], "first");
});

test("PAT and Enterprise configuration remain resolver-only", async () => {
  const fake = registryFetch();
  const result = await resolveMarketplace({
    registries: [registry("private", {
      "api-url": "https://github.example/api/v3",
      auth: { type: "pat", secret: "PRIVATE_REGISTRY_TOKEN" },
    })],
  }, {
    fetchImpl: fake.fetchImpl,
    environment: { PRIVATE_REGISTRY_TOKEN: "not-client-data" },
  });
  assert.match(fake.calls[0].url, /^https:\/\/github\.example\/api\/v3\//);
  assert.equal(fake.calls[0].init.headers.Authorization, ["Bearer", "not-client-data"].join(" "));
  assert.doesNotMatch(JSON.stringify(result), /not-client-data|PRIVATE_REGISTRY_TOKEN|Authorization/);
});

test("registry diagnostics redact referenced secret values", async () => {
  const result = await resolveMarketplace({
    registries: [registry("private", {
      auth: { type: "pat", secret: "PRIVATE_REGISTRY_TOKEN" },
    })],
  }, {
    fetchImpl: async () => {
      throw new Error("request rejected for not-client-data");
    },
    environment: { PRIVATE_REGISTRY_TOKEN: "not-client-data" },
  });
  assert.equal(result.diagnostics[0].status, "unavailable");
  assert.doesNotMatch(JSON.stringify(result), /not-client-data|PRIVATE_REGISTRY_TOKEN/);
});

test("GitHub App authentication exchanges registry-scoped secret references", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" });
  const fake = registryFetch();
  const fetchImpl = async (url, init) => {
    if (url.endsWith("/app/installations/123/access_tokens")) {
      assert.equal(init.headers.Authorization?.split(" ")[1]?.split(".").length, 3);
      return response({ token: "installation-token" });
    }
    const answer = await fake.fetchImpl(url, init);
    assert.equal(init.headers.Authorization, ["Bearer", "installation-token"].join(" "));
    return answer;
  };
  const result = await resolveMarketplace({
    registries: [registry("app", {
      auth: {
        type: "github-app",
        "app-id-secret": "APP_ID",
        "private-key-secret": "APP_KEY",
        "installation-id-secret": "INSTALLATION_ID",
      },
    })],
  }, {
    fetchImpl,
    environment: { APP_ID: "42", APP_KEY: pem, INSTALLATION_ID: "123" },
  });
  assert.equal(result.packages.length, 1);
  assert.doesNotMatch(JSON.stringify(result), /installation-token|BEGIN PRIVATE KEY/);
});

test("policy permits removing the official registry and validates registry auth", () => {
  const policy = parsePolicy(JSON.stringify({
    version: 1,
    "gh-aw-version": "v1.0.0",
    "control-plane": {
      marketplace: {
        registries: [registry("private", { auth: { type: "pat", secret: "REGISTRY_PAT" } })],
      },
    },
  }));
  assert.deepEqual(policy["control-plane"].marketplace.registries.map(({ id }) => id), ["private"]);
  assert.throws(() => parsePolicy(JSON.stringify({
    version: 1,
    "gh-aw-version": "v1.0.0",
    "control-plane": {
      marketplace: {
        registries: [registry("private", { auth: { type: "pat", secret: "literal-token" } })],
      },
    },
  })), /invalid value/);
  assert.throws(() => parsePolicy(JSON.stringify({
    version: 1,
    "gh-aw-version": "v1.0.0",
    "control-plane": {
      marketplace: {
        registries: [registry("private", { "verified-publisher": true })],
      },
    },
  })), /unknown key.*verified-publisher/);
});
