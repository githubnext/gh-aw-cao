import { formatValidationReport, validateRepository } from "../validation.mjs";

export async function runValidate({
  options,
  rejectUnknownOptions,
  validateCaoRepository = validateRepository,
}) {
  rejectUnknownOptions(options, ["json", "strict-warnings"]);
  const report = await validateCaoRepository({ strictWarnings: Boolean(options["strict-warnings"]) });
  return {
    ...report,
    command: "validate",
    output: options.json ? JSON.stringify(report, null, 2) : formatValidationReport(report),
  };
}
