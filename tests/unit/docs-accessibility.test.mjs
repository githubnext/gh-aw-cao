import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const astroConfig = await readFile(new URL("../../astro.config.mjs", import.meta.url), "utf8");
const branding = await readFile(new URL("../../docs/styles/branding.css", import.meta.url), "utf8");
const dispatchIllustration = await readFile(
  new URL("../../docs/components/DispatchIllustration.astro", import.meta.url),
  "utf8",
);

test("documentation scrollable regions are keyboard-focusable and named", () => {
  assert.match(astroConfig, /querySelectorAll\("table, pre"\)/);
  assert.match(astroConfig, /region\.setAttribute\("tabindex", "0"\)/);
  assert.match(astroConfig, /region\.setAttribute\("aria-label", label\)/);
  assert.match(astroConfig, /Scrollable code example/);
});

test("dark documentation diagrams and illustration metadata use accessible contrast tokens", () => {
  assert.match(branding, /:root\[data-theme="dark"\] \.mermaid \.edgeLabel > p/);
  assert.match(branding, /background-color: #30363d !important/);
  assert.match(branding, /color: #f0f6fc !important/);
  assert.match(dispatchIllustration, /\.repository-copy > small \{\s*color: color-mix\(in srgb, var\(--muted\) 16%, var\(--sl-color-white\)\);/);
  assert.match(dispatchIllustration, /--muted: #c9d1d9/);
});
