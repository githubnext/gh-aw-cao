function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function buildWizardPolicy(controlPolicy, owner, operationSlug) {
  const controlPlane = isRecord(controlPolicy) ? controlPolicy["control-plane"] : undefined;
  const configuredPackages = isRecord(controlPlane) ? controlPlane.packages : undefined;
  const packageConfig = isRecord(configuredPackages) && isRecord(configuredPackages[operationSlug])
    ? configuredPackages[operationSlug]
    : {};

  const { icon, ...runtimePackageConfig } = JSON.parse(JSON.stringify(packageConfig));

  return {
    version: 1,
    "control-plane": {
      scope: { "allowed-owners": [owner] },
      packages: {
        [operationSlug]: runtimePackageConfig,
      },
    },
  };
}

export function selectConfiguredOperations(controlPolicy, catalogEntries) {
  const controlPlane = isRecord(controlPolicy) ? controlPolicy["control-plane"] : undefined;
  const configuredPackages = isRecord(controlPlane) ? controlPlane.packages : undefined;

  if (!isRecord(configuredPackages)) {
    throw new Error(".github/workflows/cao.json must define control-plane.packages as an object");
  }

  const catalogEntriesBySlug = new Map(catalogEntries.map((entry) => [entry.slug, entry]));
  return Object.keys(configuredPackages)
    .map((slug) => {
      const entry = catalogEntriesBySlug.get(slug);
      if (!entry) throw new Error(`Configured package ${slug} must have a catalog manifest`);
      return entry;
    })
    .filter((entry) => !entry.private);
}
