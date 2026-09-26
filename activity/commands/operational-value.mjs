export function runOperationalValueCommand({
  options,
  indexedDB,
  databasePath,
  signal,
  runOperationalValue,
  operationalValueReserve,
  REPOSITORY_COORDINATE,
  retentionWindowMs,
  option,
  rejectUnknownOptions,
  UsageError,
}) {
  rejectUnknownOptions(options, ["database", "root", "output", "timestamp", "repository", "retention-days", "max-github-api-rate-limit", "campaign", "history-campaign"]);
  const repositories = options.repository === undefined
    ? []
    : Array.isArray(options.repository) ? options.repository : [options.repository];
  for (const repository of repositories) {
    if (!REPOSITORY_COORDINATE.test(repository)) {
      throw new UsageError("--repository must use OWNER/REPO form");
    }
  }
  const campaign = option(options, "campaign", false);
  const historyCampaign = option(options, "history-campaign", false);
  if (campaign && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(campaign)) {
    throw new UsageError("--campaign must use a lowercase campaign slug");
  }
  if (historyCampaign && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(historyCampaign)) {
    throw new UsageError("--history-campaign must use a lowercase campaign slug");
  }
  if (campaign && historyCampaign && campaign !== historyCampaign) {
    throw new UsageError("--history-campaign must match --campaign");
  }
  const retentionWindow = retentionWindowMs(options);
  if (historyCampaign && retentionWindow === undefined) {
    throw new UsageError("--history-campaign requires --retention-days");
  }
  return runOperationalValue({
    campaign,
    historyCampaign,
    indexedDB,
    databasePath,
    root: option(options, "root", false) || ".",
    outputPath: option(options, "output", false),
    timestamp: option(options, "timestamp", false) || new Date().toISOString(),
    repositories,
    rateLimitReserve: operationalValueReserve(option(options, "max-github-api-rate-limit", false), UsageError),
    retentionWindow,
    signal,
  });
}
