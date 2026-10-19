import { nativeCleanupModule } from "../../../../scripts/native-cleanup-outcomes.mjs";

export const { definition, collectBatch, scoreMetric } = nativeCleanupModule("draft-pr-cleanup", {
  inputsSha256: "14a272e473a4221a18c1c79f83f8fb419aedd092ef72dddd01e37cc128e7beca",
  oracleSha256: "d3bd37bbc2b08d8395709dc327a1549e962c31c9b69fc6f1ff819e177b72318b",
  archiveReaderSha256: "18045c03ca00fc5f8cccf2a02486255e03a0df22adddf0c426c9182fc6e2554b",
});
