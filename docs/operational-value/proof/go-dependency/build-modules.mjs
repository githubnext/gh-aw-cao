import { readFileSync, writeFileSync } from "node:fs";
import { sha256 } from "./custody.mjs";

const base = new URL("./", import.meta.url);
const bindings = Object.fromEntries([
  "custody.mjs", "native.mjs", "oracle.go", "evidence.mjs", "evaluate-cases.mjs", "modules.mjs",
  "contracts-v1.json", "instrument-v2.json", "burner-era-v3.json",
].map(file => [file, sha256(readFileSync(new URL(file, base)))]));
const shared = {
  profilesSha256: sha256(readFileSync(new URL("profiles.json", base))),
  custodySha256: sha256(readFileSync(new URL("cache-originals.json.br", base))),
  originalsSha256: sha256(readFileSync(new URL("selected-originals.json.br", base))),
  bindings,
};
for (const [slug, evaluate, score] of [
  ["dependabot-burner", "evaluateBurner", "input => scoreUpdateInput(input, { directOnly: false, skipMajor: false })"],
  ["dependabot-go-checker", "evaluateChecker", "input => scoreUpdateInput(input, { directOnly: true, skipMajor: true })"],
  ["go-fan", "evaluateGoFan", "scoreUsageInput"],
]) {
  const module = `import { dependencyModule, ${slug === "go-fan" ? "scoreUsageInput" : "scoreUpdateInput"} } from "../go-dependency/modules.mjs";\n`
    + `import { ${evaluate} } from "../go-dependency/evaluate-cases.mjs";\n\n`
    + `export const { definition, collectBatch, scoreMetric } = dependencyModule(${JSON.stringify({ slug, ...shared }, null, 2)},\n`
    + `  ${evaluate}, ${score});\n`;
  const file = new URL(`../functions/${slug}.mjs`, base);
  writeFileSync(file, module);
  console.log(`${slug} ${sha256(Buffer.from(module))}`);
}
