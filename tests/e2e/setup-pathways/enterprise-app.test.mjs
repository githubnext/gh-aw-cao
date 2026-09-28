import assert from "node:assert/strict";
import test from "node:test";

import { setupCaoAuthentication } from "../../../activity/cao.mjs";
import {
  controlRepository,
  runJourney,
  setupExecutor,
} from "./helpers.mjs";

test("clean repository follows the multi-organization enterprise App pathway", async (t) => {
  const journey = await runJourney(t, {
    repositories: {
      [controlRepository]: { nameWithOwner: controlRepository, visibility: "PRIVATE" },
      "automation/cao-auth-e2e-target": {
        nameWithOwner: "automation/cao-auth-e2e-target",
        visibility: "PRIVATE",
      },
    },
    selectedRepositories: ["automation/cao-auth-e2e-target"],
    profile: "enterprise-app",
    clientIds: ["Iv1.read", "Iv1.write"],
    configureAuthentication({ method, arguments_, fixture }) {
      return setupCaoAuthentication(method, arguments_, {
        execute: setupExecutor(fixture.environment, fixture.consumer),
      });
    },
  });
  const commands = await journey.commands();

  assert.deepEqual(journey.prompt.selections[0].choices.map(({ value }) => value), [
    "enterprise-app",
    "token",
  ]);
  assert.equal(journey.result.authentication.profile, "enterprise-app");
  assert.deepEqual(journey.result.authentication.repositories, {
    read: [controlRepository, "automation/cao-auth-e2e-target"],
    write: [controlRepository],
  });
  assert.ok(commands.some((arguments_) => arguments_.includes("GH_AW_GITHUB_READ_APP_ID")));
  assert.ok(commands.some((arguments_) => arguments_.includes("GH_AW_GITHUB_WRITE_APP_PRIVATE_KEY")));
  assert.ok(commands.some((arguments_) => arguments_.includes("GH_AW_GITHUB_AUTH_MODE") && arguments_.includes("app")));
});
