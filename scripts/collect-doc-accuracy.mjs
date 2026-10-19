import path from "node:path";
import { writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { base, contract } from "../docs/operational-value/proof/doc-accuracy/objects.mjs";
import { createFunction } from "../docs/operational-value/proof/doc-accuracy/runtime.mjs";

const output = {};
for (const slug of Object.keys(contract.sources)) {
  const module = createFunction(slug);
  const { observationWindows } = await import("../.github/skills/add-operational-value/scripts/common.mjs");
  const requests = observationWindows(module.definition, module.definition.adoption.adoptedAt, contract.cutoff);
  const batches = await module.collectBatch(requests);
  output[slug] = requests.map((request, index) => ({ request, ...batches[index],
    scores: Object.fromEntries(module.definition.metrics.map(metric =>
      [metric.id, module.scoreMetric(metric.id, batches[index].evidence)])) }));
}
const file = path.join(base, "native-observations.json.gz");
writeFileSync(file, gzipSync(JSON.stringify(output) + "\n"));
console.log(file);
