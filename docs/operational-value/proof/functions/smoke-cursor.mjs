import { capabilityModule } from "../../../../scripts/native-smoke-capabilities.mjs";
import pins from "../native-smoke-capabilities/implementation.json" with { type: "json" };

export const { definition, collectBatch, scoreMetric } = capabilityModule("smoke-cursor", pins);
