import { reusableCallModule } from "../../../../scripts/collect-reusable-call-value.mjs";
const module = reusableCallModule("orchestrator");
export const { definition, collectBatch, scoreMetric } = module;
