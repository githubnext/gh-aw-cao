import { fileURLToPath } from "node:url";
import { readCensusJson } from "../../../../scripts/operational-value-census-io.mjs";
import { workQueueModule } from "../../../../scripts/native-work-queue-value.mjs";

const contract = readCensusJson(fileURLToPath(new URL("../work-queue/contract.json", import.meta.url)));
const value = workQueueModule(contract,
  "217d7fb18ca492af4e9a9546d933a26afdbb9620dbe096494c19496349c7b1cb",
  "d8dc3c03d18ec07a275c33e2c2072d1825997c83ed5ddde091e7e5c4830482e8");
export const { definition, collectBatch, scoreMetric } = value;
