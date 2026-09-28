import assert from "node:assert/strict";
import test from "node:test";

import { setupCaoAuthentication } from "../../../activity/cao.mjs";
import {
  controlRepository,
  runJourney,
  setupExecutor,
} from "./helpers.mjs";

test("clean repository follows the owner-scoped fine-grained PAT pathway", async (t) => {
  const journey = await runJourney(t, {
    repositories: {
      [controlRepository]: { nameWithOwner: controlRepository, visibility: "PRIVATE" },
      "platform/aw-playground": { nameWithOwner: "platform/aw-playground", visibility: "PRIVATE" },
    },
    selectedRepositories: ["platform/aw-playground"],
    profile: "token",
    configureAuthentication({ method, arguments_, fixture, browserUrls, instructions }) {
      return setupCaoAuthentication(method, arguments_, {
        execute: setupExecutor(fixture.environment, fixture.consumer),
        launchBrowser(url) {
          browserUrls.push(url);
          return true;
        },
        writeInstruction(message) {
          instructions.push(message);
        },
      });
    },
  });
  const commands = await journey.commands();

  assert.equal(journey.browserUrls.length, 2);
  assert.ok(journey.browserUrls.every((url) => new URL(url).pathname === "/settings/personal-access-tokens/new"));
  assert.match(journey.instructions.join("\n"), /Only select repositories/);
  assert.deepEqual(journey.result.authentication.repositories.write, {
    [controlRepository]: "GH_AW_GITHUB_WRITE_PAT_PLATFORM",
  });
  assert.ok(commands.some((arguments_) => arguments_.includes("GH_AW_GITHUB_READ_PAT_PLATFORM")));
  assert.ok(commands.some((arguments_) => arguments_.includes("GH_AW_GITHUB_WRITE_PAT_PLATFORM")));
  assert.ok(commands.some((arguments_) => arguments_.includes("GH_AW_GITHUB_AUTH_MODE") && arguments_.includes("pat")));
});
