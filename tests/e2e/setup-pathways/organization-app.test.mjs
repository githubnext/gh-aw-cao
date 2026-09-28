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
    "token",
  ]);
  assert.equal(journey.result.authentication.profile, "github-app");
});
