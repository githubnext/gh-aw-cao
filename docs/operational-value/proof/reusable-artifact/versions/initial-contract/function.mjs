import { readCensusJson } from "../../../../scripts/operational-value-census-io.mjs";
import { reusableArtifactModule } from "../../../../scripts/reusable-artifact-value.mjs";
const module = reusableArtifactModule(readCensusJson("docs/operational-value/proof/reusable-artifact/contract.json"));
export const { definition, collectBatch, scoreMetric } = module;
