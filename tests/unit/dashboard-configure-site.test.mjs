import assert from "node:assert/strict";
import test from "node:test";
import { configureSite } from "../../dashboard/report/configure-site.mjs";

const html = '<head><link rel="icon" href="./favicon.svg"></head>';

test("dashboard site configuration applies a configured favicon", () => {
  assert.equal(
    configureSite(html, {
      web: { favicon: "https://example.com/favicon.ico" },
    }),
    '<head><link rel="icon" href="https://example.com/favicon.ico"></head>',
  );
});

test("dashboard site configuration keeps and safely encodes favicon defaults", () => {
  assert.equal(configureSite(html, {}), html);
  assert.equal(
    configureSite(html, { web: { favicon: 'https://example.com/a&"b.svg' } }),
    '<head><link rel="icon" href="https://example.com/a&amp;&quot;b.svg"></head>',
  );
});
