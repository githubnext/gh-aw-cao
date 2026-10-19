import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { engineConformanceModule } from "./native-engine-conformance.mjs";

export function agyConformanceModule(contract) {
  if (contract.engine !== "agy" || contract.agyModelSha256 !== createHash("sha256")
    .update(readFileSync(import.meta.filename)).digest("hex")) {
    throw new Error("Frozen Agy partial-facet interpreter or engine scope changed");
  }
  const native = engineConformanceModule(contract);
  return { ...native, definition: { ...native.definition,
    intent: { ...native.definition.intent,
      goal: "Verify experimental Agy production authentication, AWF, native MCP and safe-output behavior.",
      acceptance: "Partial facet: the five shared protected host assertions establish observed schema, file, inference, shell/environment and tool-round-trip behavior. Native MCP transport, inference accounting and staged native safe-output extensions are separate and not established by these five cases." },
    evidence: { ...native.definition.evidence, key: "agy-shared-host-core-five-v1",
      agyModelSha256: contract.agyModelSha256,
      filters: [...native.definition.evidence.filters,
        "The separate native Agy host gate is not silently inferred from the shared suite or generic engine success."] },
  } };
}
