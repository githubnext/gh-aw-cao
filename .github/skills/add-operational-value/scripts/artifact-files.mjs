import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

export const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function localFile(root, file) {
  assert.ok(typeof file === "string" && file.length > 0 && !file.includes("\\")
    && !path.isAbsolute(file) && file.split("/").every(part => part && part !== "." && part !== ".."),
  "Expected a repository-relative file");
  const base = realpathSync(root);
  const resolved = path.join(base, file);
  assert.ok(!lstatSync(resolved).isSymbolicLink() && lstatSync(resolved).isFile(), "Expected a regular file");
  assert.ok(realpathSync(resolved).startsWith(`${base}${path.sep}`), "File escapes repository");
  return resolved;
}

export function fileHash(root, file) {
  return createHash("sha256").update(readFileSync(localFile(root, file))).digest("hex");
}

export function verifyPins(root, pins) {
  assert.ok(Array.isArray(pins) && pins.length > 0 && pins.length <= 4096, "Missing bounded file pins");
  assert.equal(new Set(pins.map(pin => pin.path)).size, pins.length, "Duplicate file pin");
  for (const pin of pins) {
    assert.match(pin.sha256, /^[a-f0-9]{64}$/, "Invalid file digest");
    assert.equal(fileHash(root, pin.path), pin.sha256, `Pinned file changed: ${pin.path}`);
  }
}
