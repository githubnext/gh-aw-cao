import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { censusDigest, readCensusJson, writeCensusJson } from "./operational-value-census-io.mjs";
import { credoHash, executeCredoSnippet } from "./native-credo-snippet-value.mjs";

const [project] = process.argv.slice(2);
if (!project) throw new Error("Private native Credo project required");
const directory = "docs/operational-value/proof/credo-snippets";
const functionPath = "docs/operational-value/proof/functions/daily-elixir-credo-snippet-audit.mjs";
const predecessor = "7bf2fd839f2474ec17da0e95237a2127c739f622b25da984451d48eef9d682c2";
const version = `${directory}/versions/${predecessor}`;
if (credoHash(readFileSync(functionPath)) !== predecessor
  || credoHash(readFileSync(`${version}/function.txt`)) !== predecessor) {
  throw new Error("Completed Credo predecessor was not preserved");
}
const ast = file => execFileSync("elixir", ["-e",
  "[file] = System.argv(); File.read!(file) |> Code.string_to_quoted!() |> Macro.to_string() |> IO.write()", file],
{ timeout: 15000 }).toString();
if (ast(`${version}/probe.txt`) !== ast("scripts/credo-snippet-probe.exs")) {
  throw new Error("Native formatter changed probe semantics");
}
const previousContract = readCensusJson(`${version}/contract.json`);
const contract = { ...previousContract, predecessorSha256: predecessor,
  probeSha256: credoHash(readFileSync("scripts/credo-snippet-probe.exs")),
  formattingMigrationSha256: credoHash(readFileSync(import.meta.filename)) };
const previousProbes = readCensusJson(`${version}/probes.json`);
const probes = { ...previousProbes, probes: previousProbes.probes.map(probe => {
  const result = executeCredoSnippet(probe, project);
  const stable = value => Object.fromEntries(Object.entries(value).filter(([key]) => key !== "stdoutSha256"));
  if (censusDigest(stable(result)) !== censusDigest(stable(probe.result))) throw new Error("Native formatting probe result changed");
  return { ...probe, result };
}) };
const priorIndex = readCensusJson(`${version}/index.json`);
const priorHistoryIndex = readCensusJson(`${version}/history-index.json`);
writeCensusJson(`${directory}/contract.json`, contract);
writeCensusJson(`${directory}/probes.json`, probes);
writeCensusJson(`${directory}/index.json`, { ...priorIndex, contractSha256: censusDigest(contract),
  probesSha256: censusDigest(probes), predecessorIndexSha256: censusDigest(priorIndex) });
writeCensusJson(`${directory}/history-index.json`, { ...priorHistoryIndex, contractSha256: censusDigest(contract),
  predecessorIndexSha256: censusDigest(priorHistoryIndex) });
writeFileSync(functionPath, 'import { nativeCredoSnippetModule } from "../../../../scripts/native-credo-snippet-value.mjs";\n\n'
  + `export const { definition, collectBatch, scoreMetric } = nativeCredoSnippetModule(${JSON.stringify(contract, null, 2)});\n`);
writeCensusJson(`${version}/preservation.json`, { schemaVersion: 1, status: "preserved-complete-predecessor",
  change: "mix format changes argument layout only; Elixir AST normalization and every independent native probe result agree.",
  originalInputRoot: directory, sourceClosure: "index.json and history-index.json source file references resolve from originalInputRoot; all referenced immutable inputs are retained unchanged.",
  historySha256: priorHistoryIndex.historySha256, factsSha256: priorIndex.factsSha256,
  toolsSha256: priorIndex.toolsSha256, nextContractSha256: censusDigest(contract) });
console.log(JSON.stringify({ functionSha256: credoHash(readFileSync(functionPath)), contractSha256: censusDigest(contract),
  retainedPredecessor: predecessor, astEqual: true, independentNativeProbesEqual: true }));
