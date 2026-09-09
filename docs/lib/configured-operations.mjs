function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// SelfCare runs repository-local live checks against this catalog repository
// itself, so it isn't meant to be installed into a consumer's control plane.
// Exclude it from the wizard's operations list even though it's configured
// in cao.json for this repository's own control plane.
const WIZARD_EXCLUDED_SLUGS = new Set(["self-care"]);

export function buildWizardPolicy(controlPolicy, owner, operationSlug) {
  const controlPlane = isRecord(controlPolicy) ? controlPolicy["control-plane"] : undefined;
  const configuredPackages = isRecord(controlPlane) ? controlPlane.packages : undefined;
  const packageConfig = isRecord(configuredPackages) && isRecord(configuredPackages[operationSlug]) ? configuredPackages[operationSlug] : {};

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
    .filter((slug) => !WIZARD_EXCLUDED_SLUGS.has(slug))
    .map((slug) => {
      const entry = catalogEntriesBySlug.get(slug);
      if (!entry) throw new Error(`Configured package ${slug} must have a catalog manifest`);
      return entry;
    });
}
