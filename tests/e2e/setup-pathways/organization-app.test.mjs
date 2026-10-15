import assert from "node:assert/strict";
import test from "node:test";

import { setupCaoAuthentication } from "../../../activity/cao.mjs";
import {
  controlRepository,
  runJourney,
  setupExecutor,
} from "./helpers.mjs";

test("clean repository follows the one-organization GitHub App pathway", async (t) => {
  const journey = await runJourney(t, {
    repositories: {
      [controlRepository]: { nameWithOwner: controlRepository, visibility: "PRIVATE" },
      "platform/aw-playground": { nameWithOwner: "platform/aw-playground", visibility: "PRIVATE" },
    },
    selectedRepositories: ["platform/aw-playground"],
    profile: "github-app",
    configureAuthentication({ method, arguments_, fixture }) {
      assert.equal(method, "github-app");
      assert.deepEqual(arguments_.slice(-2), ["--write-repository", controlRepository]);
      return setupCaoAuthentication(method, [...arguments_, "--dry-run"], {
        execute: setupExecutor(fixture.environment, fixture.consumer),
      });
    },
  });

  assert.deepEqual(journey.prompt.selections[0].choices.map(({ value }) => value), [
    "github-app",
    "approved-app",
    "token",
  ]);
  assert.equal(journey.result.authentication.profile, "github-app");
});

test("clean repository can reuse approved Apps without registering replacements", async (t) => {
  const journey = await runJourney(t, {
    repositories: {
      [controlRepository]: { nameWithOwner: controlRepository, visibility: "PRIVATE" },
      "platform/aw-playground": { nameWithOwner: "platform/aw-playground", visibility: "PRIVATE" },
    },
    selectedRepositories: ["platform/aw-playground"],
    profile: "approved-app",
    clientIds: ["Iv1.read", "Iv1.write"],
    configureAuthentication({ method, arguments_, fixture }) {
      assert.equal(method, "github-app");
      assert.deepEqual(arguments_.slice(-4), ["--read-client-id", "Iv1.read", "--write-client-id", "Iv1.write"]);
      return setupCaoAuthentication(method, [...arguments_, "--dry-run"], {
        execute: setupExecutor(fixture.environment, fixture.consumer),
      });
    },
  });
  assert.equal(journey.result.profile, "approved-app");
  assert.equal(journey.result.authentication.profile, "github-app");
  assert.equal((await journey.commands()).some((args) => args.includes("secret") || args.includes("variable")), false);
});
