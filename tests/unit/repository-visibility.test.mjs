import assert from "node:assert/strict";
import test from "node:test";
import { main, validateRepositoryVisibility } from "../../activity/repository-visibility.mjs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function requestFor(repositories) {
  return async (_route, { owner, repo }) => ({
    data: repositories.get(`${owner}/${repo}`),
  });
}

test("private control repositories may access private repositories", async () => {
  const repositories = new Map([
    ["octo/control", { full_name: "octo/control", private: true }],
  ]);
  await validateRepositoryVisibility({
    controlRepository: "octo/control",
    allowedRepositories: ["octo/private"],
    request: requestFor(repositories),
    paginate: async () => {
      throw new Error("private controls must not enumerate repositories");
    },
  });
});

test("public-only collection verifies every exact repository and rejects unknown, renamed or non-public visibility", async () => {
  const control = { full_name: "octo/control", private: false, visibility: "public" };
  for (const target of [
    { full_name: "octo/public", private: false, visibility: "public" },
    { full_name: "octo/public", private: true, visibility: "private" },
    { full_name: "octo/public", private: false, visibility: "internal" },
    { full_name: "octo/public" },
    { full_name: "other/renamed", private: false, visibility: "public" },
  ]) {
    const action = validateRepositoryVisibility({
      controlRepository: "octo/control", allowedRepositories: ["octo/public"], publicOnly: true,
      request: requestFor(new Map([["octo/control", control], ["octo/public", target]])),
      paginate: () => assert.fail("public-only collection cannot enumerate an owner"),
    });
    if (target.visibility === "public" && target.full_name === "octo/public") await action;
    else await assert.rejects(action, /verified public visibility and unchanged identity/);
  }
  await assert.rejects(validateRepositoryVisibility({
    controlRepository: "octo/control", allowedRepositories: ["octo/public"], publicOnly: true,
    request: requestFor(new Map([["octo/control", { ...control, full_name: "octo/moved" }]])),
  }), /verified control repository visibility and unchanged identity/);
  await assert.rejects(validateRepositoryVisibility({
    controlRepository: "octo/control", allowedRepositories: [], publicOnly: true, request: requestFor(new Map([["octo/control", control]])),
  }), /exact nonempty/);
});

test("public-only monitoring allows only the actual control repository to be non-public", async (t) => {
  for (const visibility of ["private", "internal"]) {
    const repositories = new Map([
      ["octo/control", { full_name: "octo/control", visibility, private: true }],
      ["octo/public", { full_name: "octo/public", visibility: "public", private: false }],
    ]);
    const options = {
      controlRepository: "octo/control", allowedRepositories: ["octo/control", "octo/public"],
      publicOnly: true, request: requestFor(repositories),
      paginate: () => assert.fail("monitoring cannot enumerate an owner"),
    };
    await validateRepositoryVisibility(options);
    repositories.set("octo/public", { full_name: "octo/public", visibility, private: true });
    await assert.rejects(validateRepositoryVisibility(options), /verified public visibility/);
    for (const control of [
      { full_name: "octo/control" },
      { full_name: "octo/control", visibility: "private", private: false },
      { full_name: "octo/moved", visibility, private: true },
    ]) {
      repositories.set("octo/control", control);
      await assert.rejects(validateRepositoryVisibility(options), /verified control repository visibility/);
    }
  }

  const directory = await mkdtemp(path.join(os.tmpdir(), "cao-monitoring-visibility-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const settings = path.join(directory, "settings.json");
  await writeFile(settings, JSON.stringify({
    activity_public_only: true, allowed_repositories: ["octo/target"],
  }));
  for (const [name, value] of Object.entries({
    GITHUB_REPOSITORY: "octo/control", ACTIVITY_VISIBILITY_REPOSITORY: "octo/target",
  })) {
    const previous = process.env[name];
    t.after(() => {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    });
    process.env[name] = value;
  }
  await assert.rejects(main({
    core: { startGroup() {}, endGroup() {} },
    github: { request: requestFor(new Map([
      ["octo/control", { full_name: "octo/control", visibility: "private", private: true }],
      ["octo/target", { full_name: "octo/target", visibility: "private", private: true }],
    ])) },
  }, [settings]), /verified public visibility/);
});

test("public control repositories may access only public repositories", async () => {
  const repositories = new Map([
    ["octo/control", { full_name: "octo/control", private: false }],
    ["octo/public", { full_name: "octo/public", private: false }],
  ]);
  await validateRepositoryVisibility({
    controlRepository: "octo/control",
    allowedRepositories: ["octo/public"],
    request: requestFor(repositories),
    paginate: async () => [],
  });
});

test("public control repositories reject private repositories without naming them", async () => {
  const repositories = new Map([
    ["octo/control", { full_name: "octo/control", private: false }],
    ["secret/private", { full_name: "secret/private", private: true }],
  ]);
  await assert.rejects(
    validateRepositoryVisibility({
      controlRepository: "octo/control",
      allowedRepositories: ["secret/private"],
      request: requestFor(repositories),
      paginate: async () => [],
    }),
    (error) => {
      assert.match(error.message, /Public control repository cannot access non-public repositories/);
      assert.doesNotMatch(error.message, /secret\/private/);
      return true;
    },
  );
});

test("public control repositories reject internal repositories", async () => {
  const repositories = new Map([
    ["octo/control", { full_name: "octo/control", visibility: "public", private: false }],
    ["octo/internal", { full_name: "octo/internal", visibility: "internal", private: false }],
  ]);
  await assert.rejects(validateRepositoryVisibility({
    controlRepository: "octo/control",
    allowedRepositories: ["octo/internal"],
    request: requestFor(repositories),
    paginate: async () => [],
  }), /non-public repository count: 1/);
});

test("owner-wide public controls inspect every repository", async () => {
  const repositories = new Map([
    ["octo/control", { full_name: "octo/control", private: false }],
  ]);
  await assert.rejects(validateRepositoryVisibility({
    controlRepository: "octo/control",
    allowedRepositories: [],
    request: requestFor(repositories),
    paginate: async () => [
      { full_name: "octo/public", private: false },
      { full_name: "octo/private", private: true },
    ],
  }), /non-public repository count: 1/);
});

test("owner-wide user controls fall back to installation repositories", async () => {
  const repositories = new Map([
    ["octo/control", { full_name: "octo/control", visibility: "public" }],
  ]);
  const routes = [];
  await validateRepositoryVisibility({
    controlRepository: "octo/control",
    allowedRepositories: [],
    request: requestFor(repositories),
    paginate: async (route, _params, map) => {
      routes.push(route);
      if (route === "GET /orgs/{org}/repos") throw Object.assign(new Error("not an organization"), { status: 404 });
      return map({ data: { repositories: [{ full_name: "octo/public", visibility: "public" }] } });
    },
  });
  assert.deepEqual(routes, ["GET /orgs/{org}/repos", "GET /installation/repositories"]);
});

test("owner-wide user controls inspect authenticated repositories when installation discovery is unavailable", async () => {
  const repositories = new Map([
    ["octo/control", { full_name: "octo/control", visibility: "public" }],
  ]);
  const routes = [];
  await assert.rejects(validateRepositoryVisibility({
    controlRepository: "octo/control",
    allowedRepositories: [],
    request: requestFor(repositories),
    paginate: async (route, _params, map) => {
      routes.push(route);
      if (route === "GET /orgs/{org}/repos") throw Object.assign(new Error("not an organization"), { status: 404 });
      if (route === "GET /installation/repositories") throw new Error("not an installation token");
      return map({ data: [
        { full_name: "octo/private", visibility: "private" },
        { full_name: "other/private", visibility: "private" },
      ] });
    },
  }), /non-public repository count: 1/);
  assert.deepEqual(routes, ["GET /orgs/{org}/repos", "GET /installation/repositories", "GET /user/repos"]);
});
