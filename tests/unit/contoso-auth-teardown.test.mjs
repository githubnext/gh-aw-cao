import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const teardown = readFileSync("tests/e2e/contoso-auth-teardown.mjs", "utf8");
const reset = readFileSync("tests/e2e/reset-contoso-setup-repository.sh", "utf8");

test("Contoso setup teardown revokes credentials before repository cleanup", () => {
  assert.match(teardown, /\/credentials\/revoke/);
  assert.match(teardown, /\/app\/installations/);
  assert.match(teardown, /DELETE_APP_REGISTRATION=/);
  assert.match(teardown, /Refusing to teardown unexpected GitHub App slug/);
  assert.match(teardown, /expected a fine-grained PAT/);
});

test("Contoso setup reset preserves only the E2E harness", () => {
  assert.match(reset, /README\.md\|\.\/reset\.sh\|\.\/setup-auth\.sh/);
  assert.match(reset, /auth-e2e\.yml/);
  assert.match(reset, /setup-walkthrough\.yml/);
  assert.match(reset, /rm -rf -- "\$path"/);
});
