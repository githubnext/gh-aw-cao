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
const campaignList = readFileSync(
  new URL("../../docs/pages/catalog/index.astro", import.meta.url),
  "utf8",
);

test("campaign detail keeps the embedded README title out of the page heading outline", () => {
  assert.match(campaignDetail, /<CampaignReadmeContent>\s*<ReadmeContent \/>\s*<\/CampaignReadmeContent>/);
  assert.match(campaignReadmeContent, /content\.replace\(\/<h1\\b\[\^>\]\*>\[\\s\\S\]\*\?<\\\/h1>\/, ""\)/);
  assert.doesNotMatch(campaignDetail, /\.campaign-readme :global\(h1\)/);
});

test("campaign detail code examples scroll without widening the page", () => {
  assert.match(
    campaignDetail,
    /\.campaign-guide :global\(pre\),\s*\.install-campaign pre \{[\s\S]*?max-width: 100%;[\s\S]*?overflow-x: auto;/,
  );
});

test("experimental campaigns are labeled in catalog links and detail titles", () => {
  assert.match(campaignList, /\{entry\.experimental && <span class="catalog-experimental-label">Experimental<\/span>\}/);
  assert.match(campaignDetail, /title: entry\.experimental \? `\$\{entry\.name\} · Experimental` : entry\.name,/);
});
