import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const packageDetail = readFileSync(new URL("../../docs/pages/catalog/[slug].astro", import.meta.url), "utf8");
const packageReadmeContent = readFileSync(new URL("../../docs/components/PackageReadmeContent.astro", import.meta.url), "utf8");

test("package detail keeps the embedded README title out of the page heading outline", () => {
  assert.match(packageDetail, /<PackageReadmeContent>\s*<ReadmeContent \/>\s*<\/PackageReadmeContent>/);
  assert.match(packageReadmeContent, /content\.replace\(\/<h1\\b\[\^>\]\*>\[\\s\\S\]\*\?<\\\/h1>\/, ""\)/);
  assert.doesNotMatch(packageDetail, /\.package-readme :global\(h1\)/);
});

test("package detail code examples scroll without widening the page", () => {
  assert.match(packageDetail, /\.package-guide :global\(pre\),\s*\.install-package pre \{[\s\S]*?max-width: 100%;[\s\S]*?overflow-x: auto;/);
});
