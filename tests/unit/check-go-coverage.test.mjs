import assert from "node:assert/strict";
import { test } from "node:test";
import { checkGoCoverage } from "../../scripts/check-go-coverage.mjs";

const profile = `mode: atomic
github.com/githubnext/gh-aw-cao/server/internal/foo/a.go:1.1,3.2 3 1
github.com/githubnext/gh-aw-cao/server/internal/foo/a.go:4.1,5.2 1 0
github.com/githubnext/gh-aw-cao/server/internal/foo/b.go:1.1,4.2 3 0
github.com/githubnext/gh-aw-cao/server/internal/foo/b.go:5.1,6.2 1 1
`;

test("gates each modified production Go file by covered statements", () => {
  assert.deepEqual(
    checkGoCoverage(["server/internal/foo/a.go", "server/internal/foo/b.go"], profile),
    [
      { file: "server/internal/foo/a.go", total: 4, covered: 3, passed: false },
      { file: "server/internal/foo/b.go", total: 4, covered: 1, passed: false },
    ],
  );
  assert.equal(checkGoCoverage(["server/internal/foo/a.go"], profile.replace("3 1", "4 1"))[0].passed, true);
});

test("ignores tests and other directories but fails closed on missing coverage", () => {
  assert.deepEqual(checkGoCoverage(["server/internal/foo/a_test.go", "dashboard/a.go"], profile), []);
  assert.deepEqual(checkGoCoverage(["server/internal/foo/new.go"], profile), [
    { file: "server/internal/foo/new.go", total: 0, covered: 0, passed: false },
  ]);
  assert.throws(() => checkGoCoverage(["server/internal/foo/a.go"], "mode: atomic\nbad line"), /Invalid Go coverage/);
});

test("merges repeated coverpkg blocks from separate test packages", () => {
  const repeated = `${profile}github.com/githubnext/gh-aw-cao/server/internal/foo/a.go:1.1,3.2 3 0
github.com/githubnext/gh-aw-cao/server/internal/foo/a.go:4.1,5.2 1 1
`;
  assert.deepEqual(checkGoCoverage(["server/internal/foo/a.go"], repeated), [
    { file: "server/internal/foo/a.go", total: 4, covered: 4, passed: true },
  ]);
});
