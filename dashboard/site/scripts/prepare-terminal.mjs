import { chmodSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

if (process.platform === "darwin") {
  const require = createRequire(import.meta.url);
  const root = dirname(require.resolve("node-pty/package.json"));
  // node-pty 1.1.0's macOS prebuilt spawn-helper is published without execute bits.
  const helpers = [
    join(root, "prebuilds", `darwin-${process.arch}`, "spawn-helper"),
    join(root, "build", "Release", "spawn-helper"),
  ].filter(existsSync);
  if (!helpers.length) throw new Error("The node-pty terminal spawn helper is missing.");
  for (const helper of helpers) chmodSync(helper, 0o755);
}
