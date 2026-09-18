function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function buildWizardPolicy(controlPolicy, owner, operationSlug) {
  const controlPlane = isRecord(controlPolicy) ? controlPolicy["control-plane"] : undefined;
  const configuredCampaigns = isRecord(controlPlane) ? controlPlane.campaigns : undefined;
  const campaignConfig = isRecord(configuredCampaigns) && isRecord(configuredCampaigns[operationSlug])
    ? configuredCampaigns[operationSlug]
    : {};

  const { icon, ...runtimeCampaignConfig } = JSON.parse(JSON.stringify(campaignConfig));

  return {
    version: 1,
    "control-plane": {
      scope: { "allowed-owners": [owner] },
      campaigns: {
        [operationSlug]: runtimeCampaignConfig,
      },
    },
  };
}

export function selectConfiguredOperations(controlPolicy, catalogEntries) {
  const controlPlane = isRecord(controlPolicy) ? controlPolicy["control-plane"] : undefined;
  const configuredCampaigns = isRecord(controlPlane) ? controlPlane.campaigns : undefined;

  if (!isRecord(configuredCampaigns)) {
    throw new Error(".github/workflows/cao.json must define control-plane.campaigns as an object");
  }

  const catalogEntriesBySlug = new Map(catalogEntries.map((entry) => [entry.slug, entry]));
  return Object.keys(configuredCampaigns)
    .map((slug) => {
      const entry = catalogEntriesBySlug.get(slug);
      if (!entry) throw new Error(`Configured campaign ${slug} must have a catalog manifest`);
      return entry;
    })
    .filter((entry) => !entry.private && !entry.builtin);
}
