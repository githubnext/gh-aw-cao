export const CAMPAIGN_INTELLIGENCE_DECLARATION = Object.freeze({
  id: "campaign-intelligence-declaration",
  version: "1.0.0",
});

export const CAMPAIGN_INTELLIGENCE_FIELDS = Object.freeze([
  "repositoryNativeProblem",
  "eligibleOpportunity",
  "intendedOutcome",
  "outcomeAttainmentEvidence",
  "targetPopulation",
  "interventionClass",
  "triggerAndSchedule",
  "scheduleRationale",
  "maxDetectionDelay",
  "resourceEnvelope",
  "overlapIdentity",
  "outputApprovalPolicy",
  "maturationPeriod",
  "deduplication",
  "backoff",
  "stopConditions",
  "operationalValueDefinition",
]);

const DECLARATION_KEYS = new Set(["contractVersion", "campaign", "fields"]);
const FIELD_KEYS = new Set(CAMPAIGN_INTELLIGENCE_FIELDS);
const CAMPAIGN_SLUG = /^[a-z0-9][a-z0-9-]*$/;

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function canonicalIntelligenceValue(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Intelligence inputs must contain finite JSON numbers");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalIntelligenceValue);
  if (!isPlainObject(value)) throw new TypeError("Intelligence inputs must contain plain JSON objects");
  return Object.fromEntries(Object.keys(value).sort().map((key) => {
    if (value[key] === undefined) throw new TypeError("Intelligence inputs must not contain undefined values");
    return [key, canonicalIntelligenceValue(value[key])];
  }));
}

export function normalizeCampaignIntelligenceDeclaration(value, {
  expectedCampaign = null,
  label = "Campaign intelligence declaration",
} = {}) {
  if (!isPlainObject(value)) throw new TypeError(`${label} must be an object`);
  const unknownKeys = Object.keys(value).filter((key) => !DECLARATION_KEYS.has(key)).sort();
  if (unknownKeys.length > 0) {
    throw new TypeError(`${label} contains unknown field(s): ${unknownKeys.join(", ")}`);
  }
  if (value.contractVersion !== CAMPAIGN_INTELLIGENCE_DECLARATION.version) {
    throw new TypeError(
      `${label}.contractVersion must be ${CAMPAIGN_INTELLIGENCE_DECLARATION.version}`,
    );
  }
  if (typeof value.campaign !== "string" || !CAMPAIGN_SLUG.test(value.campaign)) {
    throw new TypeError(`${label}.campaign must be a lowercase Campaign slug`);
  }
  if (expectedCampaign !== null && value.campaign !== expectedCampaign) {
    throw new TypeError(
      `${label}.campaign must match ${expectedCampaign}, received ${value.campaign}`,
    );
  }
  if (!isPlainObject(value.fields)) throw new TypeError(`${label}.fields must be an object`);
  const unknownFields = Object.keys(value.fields).filter((key) => !FIELD_KEYS.has(key)).sort();
  if (unknownFields.length > 0) {
    throw new TypeError(`${label}.fields contains unknown field(s): ${unknownFields.join(", ")}`);
  }
  if (Object.keys(value.fields).length === 0) {
    throw new TypeError(`${label}.fields must declare at least one semantic field`);
  }
  for (const [field, fieldValue] of Object.entries(value.fields)) {
    if (fieldValue === null) {
      throw new TypeError(`${label}.fields.${field} must be omitted instead of null`);
    }
  }
  return {
    contractVersion: CAMPAIGN_INTELLIGENCE_DECLARATION.version,
    campaign: value.campaign,
    fields: canonicalIntelligenceValue(value.fields),
  };
}
