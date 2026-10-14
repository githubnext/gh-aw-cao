import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { assertDialogSelector } from "./site/src/dialog-selector.js";
import { cliActionTemplateFields } from "./site/src/cli-action-template.js";

const executeFile = promisify(execFile);

export async function lookupDialogOptions(action, text, {
  workingDirectory, ghExecutable = "gh", signal, execute = executeFile,
} = {}) {
  assertDialogSelector(action.selector, cliActionTemplateFields(action.command));
  if (typeof text !== "string" || text.trim().length < 2 || text.length > 200 || /[\u0000-\u001f]/.test(text)) {
    throw new Error("Repository search must contain 2 to 200 characters without control characters.");
  }
  const { query, mapping } = action.selector;
  const result = await execute(ghExecutable, [
    "search", "repos", "--limit", String(query.limit), "--json", query.fields.join(","), "--", text.trim(),
  ], { cwd: workingDirectory, signal, timeout: 15_000, maxBuffer: 256 * 1024, windowsHide: true });
  const rows = JSON.parse(result.stdout);
  if (!Array.isArray(rows) || rows.length > query.limit) throw new Error("Repository search returned invalid results.");
  return rows.map((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row)
      || typeof row[mapping.value] !== "string" || typeof row[mapping.label] !== "string"
      || (mapping.description && row[mapping.description] != null && typeof row[mapping.description] !== "string")) {
      throw new Error("Repository search returned an invalid mapped option.");
    }
    const value = row[mapping.value];
    if (!value || !row[mapping.label]) throw new Error("Repository search returned an empty mapped option.");
    return { value, label: row[mapping.label], description: mapping.description ? row[mapping.description] ?? "" : "" };
  });
}
