export function runAuditJsonl({
  options,
  auditJsonlDirectory,
  DEFAULT_SHARDS_PATH,
  option,
  rejectUnknownOptions,
}) {
  rejectUnknownOptions(options, ["input-dir"]);
  return auditJsonlDirectory(option(options, "input-dir", false) || DEFAULT_SHARDS_PATH);
}
