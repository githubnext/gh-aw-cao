import { gplAuditModule } from "../../../../scripts/native-gpl-audit-value.mjs";

export const { definition, collectBatch, scoreMetric } = gplAuditModule({
  "scripts/native-gpl-audit-value.mjs": "a8e8d52233b79eb8395a561dc5b0a54eea2b0696cd93bbd4fbfa1f30a283c87e",
  "scripts/native-smoke-pydantic.mjs": "0df4eafb26e80d27ef8c99c7eee66b443518f2c9ed4fed0d5094d2593aebb8f5",
  "scripts/collect-smoke-pydantic.mjs": "3001086bb3b8631d7ac953d5263d47a9924faf7a3f7f0bffeda73f62baa50232",
  ".github/skills/add-operational-value/scripts/json-archive.mjs": "18045c03ca00fc5f8cccf2a02486255e03a0df22adddf0c426c9182fc6e2554b",
  ".github/skills/add-operational-value/scripts/collect-output-history.mjs": "52ed43049cff5a15209397bee042bbb950aa5fe0628c3c2a6e03c41a5c9e5eea",
  ".github/skills/add-operational-value/scripts/common.mjs": "c865f10a46d4ad3e6f20ea2afba98f280910f8e3c7049e2e303e9daf3605a836",
  ".github/skills/add-operational-value/scripts/github-lineage.mjs": "f35d6546c78197c49a91b08bf2ac88cba0af37125df726fa6b7c2926c83eccf5",
  "docs/operational-value/proof/gpl-audit/index.json.gz": "a636de5091e67b95bf5bc561f4f63ee6b3a1798791bcf7640ab047f217704930",
  "docs/operational-value/proof/gpl-audit/frozen-contract-v1.json": "147c8bd821479cc1cec32c830797ce2add65790a8f42d7e5dd345c2c4ec0a7ae",
  "docs/operational-value/proof/gpl-audit/frozen-facet-v2.json": "91672704b6de9b477d5b55ce1d469a33a97acc949da414b32158bd9a21a25461",
});
