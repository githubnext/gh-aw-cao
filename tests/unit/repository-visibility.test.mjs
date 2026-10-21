import assert from "node:assert/strict";
import test from "node:test";
import { validateRepositoryVisibility } from "../../activity/repository-visibility.mjs";

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
    request: requestFor(new Map([["octo/control", { ...control, visibility: "private", private: true }]])),
  }), /verified public visibility/);
  await assert.rejects(validateRepositoryVisibility({
    controlRepository: "octo/control", allowedRepositories: [], publicOnly: true, request: requestFor(new Map([["octo/control", control]])),
  }), /exact nonempty/);
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
