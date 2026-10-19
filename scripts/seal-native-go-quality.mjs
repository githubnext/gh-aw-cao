import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { base, sha256 } from "../docs/operational-value/proof/native-go-quality/custody.mjs";

const dir = base.pathname;
const predecessor = readFileSync(path.join(dir, "contracts-v1.json"));
const version = {
  schemaVersion: 1, version: "native-go-quality-v2",
  authoring: "Explicit outcome-informed retrospective refinement after the frozen v1 contract and first native AST pass. Not ex ante, prospective or historical executor certification.",
  predecessor: { file: "contracts-v1.json", sha256: sha256(predecessor) },
  unchangedStrictAcceptance: true,
  firstPass: { testifyPotentialSites: 3, rejected: [{
    path: "pkg/cli/health_command_test.go", function: "TestHealthCommand",
    site: "cmd.Name()", reason: "A method call on a nil pointer is not automatically an unsafe field dereference; no general credit for assert-to-require substitution.",
  }], acceptedAfterIndependentLibraryProof: 2 },
  refinements: [
    "Testify acceptance is narrowed to actual nil-prone *pflag.Flag DefValue accesses after the exact unchanged Flags().Lookup prerequisite in the retained health-command transition.",
    "Independently pin both endpoint go.mod files, constructor return type, Cobra/pflag pointer and field declarations, and Testify fatal versus nonfatal assertion source.",
    "Only real *testing.T prerequisites, unchanged initializer and immediate unconditional dependent access are considered; alias shadowing and method-call-only cases are rejected.",
    "Go Logger's existing-computation guard facet is unchanged. Added logging by itself never qualifies.",
    "Detector issue 4145 and its real downstream implementation are retained; apparently dead display fields do not prove the frozen required-JSON-field restoration goal. No acceptance relaxation or invented improvement.",
  ],
  nativeToolchain: { language: "Go", version: "1.25.3", dependencies: "standard library only for the locally authored oracle; target/library source is parsed, never imported, built, tested or executed" },
  limits: { fullGoalAcceptance: null, safeguards: null, costs: null, receiptBackedAttribution: null,
    historicalExecutorContinuity: null, keepDecision: "not rated" },
};
const text = `${JSON.stringify(version, null, 2)}\n`;
const versionPath = path.join(dir, "contract-v2.json");
if (existsSync(versionPath) && readFileSync(versionPath, "utf8") !== text) throw new Error("Material version change requires preserved successor, not overwrite");
writeFileSync(versionPath, text);
const files = [];
function walk(directory, prefix = "") {
  for (const row of readdirSync(directory, { withFileTypes: true })) {
    const name = `${prefix}${row.name}`;
    if (row.isDirectory()) {
      if (row.name !== "reports") walk(path.join(directory, row.name), `${name}/`);
    } else if (!["instrument-lock.json", "assessment.json", "clean-replay-receipt.json", "validation-receipt.json"].includes(name)) {
      const bytes = readFileSync(path.join(directory, row.name));
      if (bytes.length > 256 * 1024) throw new Error(`Oversized owned file ${name}`);
      files.push({ file: name, bytes: bytes.length, sha256: sha256(bytes) });
    }
  }
}
walk(dir);
files.sort((a, b) => a.file.localeCompare(b.file));
const lock = { schemaVersion: 1, kind: "native-go-quality-closure", files };
const lockPath = path.join(dir, "instrument-lock.json");
writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
const instrument = sha256(readFileSync(lockPath));
const bindings = Object.fromEntries(["custody.mjs", "native.mjs", "oracle.go", "model.mjs",
  "contracts-v1.json", "contract-v2.json", "instrument-lock.json"].map(file => [file, sha256(readFileSync(path.join(dir, file)))]));
for (const slug of ["go-logger", "go-pattern-detector", "daily-testify-uber-super-expert"]) {
  const filename = path.join(dir, "../functions", `${slug}.mjs`);
  writeFileSync(filename, `import { qualityModule } from "../native-go-quality/model.mjs";\n\nexport const { definition, collectBatch, scoreMetric } = qualityModule(${JSON.stringify({ slug, instrument, bindings }, null, 2)});\n`);
}
console.log(JSON.stringify({ instrument, files: files.length }));
