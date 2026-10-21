import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const campaignDetail = readFileSync(
  new URL("../../docs/pages/catalog/[slug].astro", import.meta.url),
  "utf8",
);
const campaignReadmeContent = readFileSync(
  new URL("../../docs/components/CampaignReadmeContent.astro", import.meta.url),
  "utf8",
);

test("campaign detail keeps the embedded README title out of the page heading outline", () => {
  assert.match(campaignDetail, /<CampaignReadmeContent>\s*<ReadmeContent \/>\s*<\/CampaignReadmeContent>/);
  assert.match(campaignReadmeContent, /content\.replace\(\/<h1\\b\[\^>\]\*>\[\\s\\S\]\*\?<\\\/h1>\/, ""\)/);
  assert.doesNotMatch(campaignDetail, /\.campaign-readme :global\(h1\)/);
});

test("campaign detail uses CAO lifecycle commands without a version placeholder", () => {
  assert.match(
    campaignDetail,
    /const installCommand = entry\.builtin[\s\S]*?"gh cao update"[\s\S]*?`gh cao campaigns add githubnext\/gh-cao\/\$\{entry\.slug\}`;/,
  );
  assert.doesNotMatch(campaignDetail, /catalog-release/);
});

test("catalog resolves README and manifest paths from repository-relative campaign directories", () => {
  const source = readFileSync(new URL("../../docs/lib/catalog.ts", import.meta.url), "utf8");
  assert.match(source, /const campaignPath = manifestPath\.replace/);
  const expression = /const campaignPath = (.+);/.exec(source)[1];
  const campaignPath = new Function("manifestPath", `return ${expression}`);
  assert.equal(campaignPath("../../repo-status/aw.yml"), "repo-status");
  assert.equal(campaignPath("../../.experimental/example/aw.yaml"), ".experimental/example");
});

test("campaign detail code examples scroll without widening the page", () => {
  assert.match(
    campaignDetail,
    /\.campaign-guide :global\(pre\),\s*\.install-campaign pre \{[\s\S]*?max-width: 100%;[\s\S]*?overflow-x: auto;/,
  );
});
