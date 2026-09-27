import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const astroConfig = await readFile(new URL("../../astro.config.mjs", import.meta.url), "utf8");

test("documentation scrollable regions are keyboard-focusable and named", () => {
  assert.match(astroConfig, /querySelectorAll\("table, pre"\)/);
  assert.match(astroConfig, /region\.setAttribute\("tabindex", "0"\)/);
  assert.match(astroConfig, /region\.setAttribute\("aria-label", label\)/);
  assert.match(astroConfig, /Scrollable code example/);
});
