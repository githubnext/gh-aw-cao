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
      assert.match(error.message, /Public control repository cannot access private repositories/);
      assert.doesNotMatch(error.message, /secret\/private/);
      return true;
    },
  );
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
  }), /private repository count: 1/);
});
