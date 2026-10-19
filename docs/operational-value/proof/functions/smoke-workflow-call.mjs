import { reusableCallModule } from "../../../../scripts/collect-reusable-call-value.mjs";
const module = reusableCallModule("worker");
export const { definition, collectBatch, scoreMetric } = module;
