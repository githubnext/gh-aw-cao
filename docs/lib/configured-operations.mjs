function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function buildWizardPolicy(controlPolicy, owner, operationSlug, host) {
  const controlPlane = isRecord(controlPolicy) ? controlPolicy["control-plane"] : undefined;
  const configuredCampaigns = isRecord(controlPlane) ? controlPlane.campaigns : undefined;
  const campaignConfig = isRecord(configuredCampaigns) && isRecord(configuredCampaigns[operationSlug])
    ? configuredCampaigns[operationSlug]
    : {};

  const { icon, ...runtimeCampaignConfig } = JSON.parse(JSON.stringify(campaignConfig));

  const policy = {
    version: 1,
    "control-plane": {
      scope: { "allowed-owners": [owner] },
      campaigns: {
        [operationSlug]: runtimeCampaignConfig,
      },
    },
  };
  if (host) policy["control-plane"].web = { host };
  return policy;
}

export function buildWizardHost(targetModule, redisModule) {
  if (targetModule === "none") return undefined;
  if (!["container", "azure-functions"].includes(targetModule)) {
    throw new Error(`Unsupported app target module: ${targetModule}`);
  }
  if (redisModule === "upstash" && targetModule !== "container") {
    throw new Error("Upstash requires the container app target");
  }

  const redis = {
    module: redisModule,
    "namespace-env": targetModule === "azure-functions" ? "CAO_REDIS_NAMESPACE" : "REDIS_NAMESPACE",
  };
  if (targetModule === "azure-functions" && redisModule !== "gcp-memorystore") {
    redis["url-env"] = "CAO_REDIS_URL";
  }
  if (redisModule === "local") {
    redis["allow-private-plaintext"] = true;
    redis.tls = { mode: "disabled" };
  } else if (["railway", "render"].includes(redisModule)) {
    redis.tls = { mode: "auto" };
    redis["allow-private-plaintext"] = true;
  } else {
    redis.tls = { mode: "required" };
  }

  return {
    target: { module: targetModule },
    redis,
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
