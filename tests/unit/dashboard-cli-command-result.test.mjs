import assert from "node:assert/strict";
import test from "node:test";
import { lastPullRequestUrl } from "../../dashboard/cli-command-result.mjs";

test("command results select the last PR URL, including enterprise hosts and path prefixes", () => {
  assert.equal(lastPullRequestUrl([
    "https://github.com/octo/repo/pull/1",
    "Created https://ghe.example.test:8443/github/team/project/pull/42",
    "See https://ghe.example.test/team/project/issues/99",
  ].join("\n")), "https://ghe.example.test:8443/github/team/project/pull/42");
  assert.equal(lastPullRequestUrl("https://github.internal/team/project/pull/7"), "https://github.internal/team/project/pull/7");
});

test("command results handle terminal colors, hyperlink escapes, and prose punctuation", () => {
  assert.equal(lastPullRequestUrl("\x1b[32mhttps://ghe.example.test/team/project/pull/2\x1b[0m"),
    "https://ghe.example.test/team/project/pull/2");
  assert.equal(lastPullRequestUrl("\x1b]8;;https://example.test\x07https://ghe.example.test/team/project/pull/3\x1b]8;;\x07"),
    "https://ghe.example.test/team/project/pull/3");
  assert.equal(lastPullRequestUrl("[PR](https://ghe.example.test/team/project/pull/4/)."),
    "https://ghe.example.test/team/project/pull/4");
});

test("command results exclude credentials and discard query strings and fragments", () => {
  assert.equal(lastPullRequestUrl("https://user:password@ghe.example.test/team/project/pull/1"), undefined);
  assert.equal(lastPullRequestUrl("https://ghe.example.test/team/project/pull/5?access=private#details"),
    "https://ghe.example.test/team/project/pull/5");
});

test("non-PR, malformed, and unsafe URLs do not become command results", () => {
  for (const value of [
    "", "No PR was created.", "https://", "https://[invalid/team/project/pull/1",
    "javascript:alert(1)", "file:///team/project/pull/1", "ftp://ghe.example.test/team/project/pull/1",
    "http://ghe.example.test/team/project/pull/1",
    "https://ghe.example.test/team/project/pulls/1", "https://ghe.example.test/team/project/issues/1",
    "https://ghe.example.test/team/project/pull/0", "https://ghe.example.test/team/project/pull/1/files",
  ]) assert.equal(lastPullRequestUrl(value), undefined, value);
});
