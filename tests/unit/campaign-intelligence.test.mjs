import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  CAMPAIGN_INTELLIGENCE_DECLARATION,
  canonicalIntelligenceValue,
  normalizeCampaignIntelligenceDeclaration,
} from "../../activity/campaign-intelligence.mjs";
import {
  compileCampaignIntelligenceContracts,
} from "../../activity/computations/intelligence-contracts.mjs";

function declaration(overrides = {}) {
  return {
    contractVersion: CAMPAIGN_INTELLIGENCE_DECLARATION.version,
    campaign: "maintenance",
    fields: {
      intendedOutcome: {
        statement: "Reduce unresolved maintenance work.",
      },
    },
    ...overrides,
  };
}

test("normalizes a versioned Campaign intelligence declaration deterministically", () => {
  const normalized = normalizeCampaignIntelligenceDeclaration(declaration({
    fields: {
      intendedOutcome: { statement: "Reduce unresolved maintenance work." },
      repositoryNativeProblem: { statement: "Maintenance work remains unresolved." },
    },
  }), { expectedCampaign: "maintenance" });

  assert.deepEqual(Object.keys(normalized.fields), [
    "intendedOutcome",
    "repositoryNativeProblem",
  ]);
  assert.equal(normalized.contractVersion, "1.0.0");
  assert.equal(normalized.campaign, "maintenance");
  assert.deepEqual(
    canonicalIntelligenceValue({ b: 2, a: 1 }),
    { a: 1, b: 2 },
  );
});

test("rejects malformed, ambiguous, and mismatched Campaign intelligence declarations", () => {
  assert.throws(() => normalizeCampaignIntelligenceDeclaration(null), /must be an object/);
  assert.throws(() => normalizeCampaignIntelligenceDeclaration(declaration({
    contractVersion: "2.0.0",
  })), /contractVersion must be 1\.0\.0/);
  assert.throws(() => normalizeCampaignIntelligenceDeclaration(declaration({
    campaign: "Maintenance",
  })), /lowercase Campaign slug/);
  assert.throws(() => normalizeCampaignIntelligenceDeclaration(declaration(), {
    expectedCampaign: "other",
  }), /must match other/);
  assert.throws(() => normalizeCampaignIntelligenceDeclaration({
    ...declaration(),
    authority: "live",
  }), /unknown field\(s\): authority/);
  assert.throws(() => normalizeCampaignIntelligenceDeclaration(declaration({
    fields: { executionAuthority: "live" },
  })), /unknown field\(s\): executionAuthority/);
  assert.throws(() => normalizeCampaignIntelligenceDeclaration(declaration({
    fields: {},
  })), /declare at least one semantic field/);
  assert.throws(() => normalizeCampaignIntelligenceDeclaration(declaration({
    fields: { intendedOutcome: null },
  })), /must be omitted instead of null/);
  assert.throws(() => normalizeCampaignIntelligenceDeclaration(declaration({
    fields: { intendedOutcome: { invalid: Number.NaN } },
  })), /finite JSON numbers/);
});

test("Dependabot pilot preserves one explicit unknown in its compiled contract", async () => {
  const source = JSON.parse(await readFile(
    new URL("../../dependabot/intelligence.json", import.meta.url),
    "utf8",
  ));
  const intelligenceDeclaration = normalizeCampaignIntelligenceDeclaration(source, {
    expectedCampaign: "dependabot",
  });
  const [contract] = compileCampaignIntelligenceContracts([{
    id: "campaign:dependabot",
    slug: "dependabot",
    intelligenceDeclaration,
  }], []);

  assert.deepEqual(contract.quality.coverage, {
    state: "partial",
    numerator: 16,
    denominator: 17,
  });
  assert.equal(contract.backoff, null);
  assert.equal(
    contract.operationalValueDefinition.path,
    "dependabot/operational-value/dependabot-update-planner.mjs",
  );
});
