import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { environmentDefaultsFile, parseEnvironmentDefaults } from "./site/src/environment-defaults.js";

/** gh-aw env uses files, not stdin/stdout. Keep its complete document private and outside the checkout. */
export async function executeEnvironmentDefaults({ operation, input, run, onOutput, signal }) {
  if (operation === "update") parseEnvironmentDefaults(input);
  const directory = await mkdtemp(join(tmpdir(), "cao-governance-"));
  const file = join(directory, environmentDefaultsFile);
  try {
    signal?.throwIfAborted();
    if (operation === "update") await writeFile(file, input, { mode: 0o600 });
    const result = await run(directory, ({ data }) => onOutput?.({ stream: "stderr", data }));
    if (!result.ok || operation !== "get") return result;
    signal?.throwIfAborted();
    const stdout = await readFile(file, "utf8");
    parseEnvironmentDefaults(stdout);
    onOutput?.({ stream: "stdout", data: stdout });
    return { ...result, stdout, stderr: [result.stdout, result.stderr].filter(Boolean).join("\n") };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
