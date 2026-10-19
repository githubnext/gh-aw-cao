import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const hash = bytes => createHash("sha256").update(bytes).digest("hex");
export const checkerPath = "scripts/check-safe-outputs-conformance.sh";
export const specPath = "docs/src/content/docs/specs/safe-outputs-specification.md";
const prefix = "actions/setup/js/";
const cache = new Map();

export function nativeMatch(text, pattern, flags = "E") {
  const key = hash(text) + "|" + flags + "|" + pattern;
  if (cache.has(key)) return cache.get(key);
  const result = spawnSync("/usr/bin/grep", [`-${flags}c`, "--", pattern], {
    input: text, encoding: "utf8", timeout: 10000, maxBuffer: 1024 * 1024,
    env: { ...process.env, LC_ALL: "C" },
  });
  if (result.error || ![0, 1].includes(result.status)) {
    throw new Error(`Native grep failed: ${result.error?.message ?? result.stderr}`);
  }
  cache.set(key, result.status === 0);
  return result.status === 0;
}

export function toolIdentity() {
  return {
    grepSha256: hash(readFileSync("/usr/bin/grep")),
    awkSha256: hash(readFileSync("/usr/bin/awk")),
    grepVersion: spawnSync("/usr/bin/grep", ["--version"], { encoding: "utf8" }).stdout.trim(),
    locale: "C",
    instrumentSha256: hash(readFileSync(new URL(import.meta.url))),
  };
}

export function nativeInventory(checker) {
  return [...checker.matchAll(/^\s*echo "Running ([A-Z0-9]+-\d+): (.*?)\.\.\."/gm)]
    .map(match => ({ id: match[1], name: match[2] }));
}

export function assess(files, inventory) {
  const rows = [];
  const get = file => files[file]?.content ?? null;
  const exists = file => Object.hasOwn(files, file);
  const add = (rule, file, test, severity, detail, extra = {}) => rows.push({
    id: `${rule}|${file}|${detail}`, rule, file, severity, detail,
    status: test === null ? "unknown" : test ? "pass" : "fail", ...extra,
  });
  const check = (rule, file, pattern, severity, detail = pattern, flags = "E") =>
    add(rule, file, get(file) === null ? null
      : nativeMatch(get(file), pattern, flags), severity, detail);
  const topHandlers = Object.keys(files).filter(file => /^actions\/setup\/js\/[^/]+\.cjs$/.test(file));
  for (const file of topHandlers) {
    if (/test|_checks\.cjs$/.test(file)) continue;
    const text = get(file);
    for (const rule of ["SEC-002", "SEC-003", "SEC-005", "USE-001", "USE-003"]) {
      if (rule === "SEC-002" && /parse|buffer/.test(file)) continue;
      if (rule === "SEC-003" && /parse|buffer|factory/.test(file)) continue;
      if (["USE-001", "USE-003"].includes(rule)
        && /apm_unpack|run_apm_unpack|observability|generate_observability/.test(file)) continue;
      if (text === null) {
        add(rule, file, null, "unknown", "handler-source-unavailable");
        continue;
      }
      if (rule === "SEC-002" && nativeMatch(text, "octokit\\.")) {
        const result = spawnSync("/usr/bin/awk", [
          "/octokit\\./{api_line=NR} /validate|sanitize|enforceLimit/{if(NR<api_line || api_line==0) valid=1} END{exit !valid}",
        ], { input: text, encoding: "utf8", timeout: 10000, env: { ...process.env, LC_ALL: "C" } });
        if (result.error || ![0, 1].includes(result.status)) throw new Error("Native validation-order predicate failed");
        add(rule, file, result.status === 0, "CRITICAL", "validation-before-api-native-awk");
      }
      if (rule === "SEC-003" && nativeMatch(text, "octokit\\.")) {
        check(rule, file, "\\.length.*>.*\\.max|enforceMaxLimit|checkLimit|max.*exceeded|enforceArrayLimit|tryEnforceArrayLimit|limit_enforcement_helpers", "MEDIUM");
      }
      if (rule === "SEC-005" && nativeMatch(text, "\\btarget-repo\\b|\\btargetRepo\\b|\\btarget_repo\\b")) {
        const raw = nativeMatch(text, "allowed.*[Rr]epos|validateTargetRepo|checkAllowedRepo");
        const suppressed = nativeMatch(text, "@safe-outputs-exempt.*SEC-005");
        add(rule, file, raw, "HIGH", "cross-repository-allowlist", { suppressed });
      }
      if (rule === "USE-001" && nativeMatch(text, "octokit\\.|safe_output|safeOutput|NDJSON")
        && nativeMatch(text, "throw.*Error|core\\.setFailed")) {
        check(rule, file, "E[0-9]{3}|ERROR_|ERR_", "LOW");
      }
      if (rule === "USE-003" && nativeMatch(text, "GH_AW_SAFE_OUTPUTS_STAGED|logStagedPreviewInfo|generateStagedPreview")) {
        check(rule, file, "🎭|Staged Mode.*Preview|logStagedPreviewInfo|generateStagedPreview", "LOW");
      }
    }
  }
  const contentHandlers = ["add_comment", "create_issue", "create_discussion", "create_pull_request",
    "update_issue", "close_issue", "close_discussion", "close_pull_request", "add_labels",
    "remove_labels", "create_check_run", "approve_workflow_run", "create_pr_review_comment",
    "comment_memory", "create_agent_session", "assign_milestone", "create_project", "create_forecast_issue"];
  for (const name of contentHandlers) {
    const file = `${prefix}${name}.cjs`;
    if (!exists(file)) continue;
    const text = get(file);
    if (text === null) add("SEC-004", file, null, "MEDIUM", "content-sanitization");
    else if (nativeMatch(text, '"body"|body:|"title"|title:|"content"|content:')) {
      add("SEC-004", file, nativeMatch(text, "sanitize|stripHTML|escapeMarkdown|cleanContent"),
        "MEDIUM", "content-sanitization", {
          suppressed: nativeMatch(text, "@safe-outputs-exempt[[:space:]]+SEC-004"),
        });
    }
  }
  for (const name of ["create_issue", "create_pull_request", "create_discussion", "add_comment"]) {
    const file = `${prefix}${name}.cjs`;
    if (exists(file)) check("USE-002", file, "footer|addFooter|attribution|AI generated", "LOW");
  }
  for (const name of ["create_issue", "add_comment", "close_issue", "update_issue", "add_labels", "remove_labels"]) {
    const file = `${prefix}${name}.cjs`;
    add("IMP-001", file, exists(file), "HIGH", "standard-handler-exists");
  }
  check("IMP-002", "pkg/workflow/safe_outputs_permissions.go", "ComputePermissionsForSafeOutputs", "HIGH");
  check("IMP-003", "pkg/workflow/safe_outputs_config_generation.go", "generateCustomJobToolDefinition", "MEDIUM");
  check("IMP-003", "pkg/workflow/js/safe_outputs_tools.json", '"inputSchema"', "MEDIUM");
  if (exists("pkg/workflow/safe_outputs_config.go")) {
    check("IMP-003", "pkg/workflow/safe_outputs_config.go", "Schema Generation Architecture", "MEDIUM");
  }
  for (const file of ["actions/setup/sh/setup_cache_memory_git.sh", "actions/setup/sh/commit_cache_memory_git.sh"]) {
    add("CI-001", file, exists(file), "HIGH", "cache-integrity-script-exists");
  }
  const staticChecks = [
    ["CI-003", "pkg/workflow/cache_integrity.go", "sha256|crypto/sha256", "HIGH"],
    ["CI-003", "pkg/workflow/cache_integrity.go", "nopolicy|noPolicySentinel", "HIGH"],
    ["CI-003", "pkg/workflow/cache_integrity.go", "\\[:8\\]|first.*8|8.*char|hex\\[:8\\]", "MEDIUM"],
    ["CI-004", "actions/setup/sh/setup_cache_memory_git.sh", "\\.git|not -path .*\\.git|prune.*\\.git|exclude.*git|skip.*\\.git", "MEDIUM"],
    ["MCE-001", "pkg/workflow/js/safe_outputs_tools.json", "65536", "MEDIUM", "Ei"],
    ["MCE-001", "pkg/workflow/js/safe_outputs_tools.json", "10 mention", "MEDIUM", "Ei"],
    ["MCE-001", "pkg/workflow/js/safe_outputs_tools.json", "50 link", "MEDIUM", "Ei"],
    ["MCE-002", `${prefix}safe_outputs_handlers.cjs`, "comment_limit_helpers|enforceCommentLimits", "MEDIUM"],
    ["MCE-002", `${prefix}add_comment.cjs`, "comment_limit_helpers|enforceCommentLimits", "MEDIUM"],
    ["MCE-004", `${prefix}safe_outputs_handlers.cjs`, "enforceCommentLimits|enforceConstraints|validateEarly", "HIGH"],
    ["MCE-004", `${prefix}safe_outputs_handlers.cjs`, "MCE1|Early Validation|tool invocation", "MEDIUM"],
    ["TYPE-001", `${prefix}merge_pull_request.cjs`, "isDefault", "CRITICAL"],
    ["TYPE-001", `${prefix}merge_pull_request.cjs`, "requiredChecks|review_decision|required_labels|allowed_labels", "HIGH"],
    ["TYPE-001", `${prefix}merge_pull_request.cjs`, "mergeable", "HIGH"],
    ["TYPE-002", `${prefix}comment_memory.cjs`, "MAX_SCAN_PAGES|maxScanPages|scan.*limit|COMMENT_MEMORY_MAX_SCAN", "HIGH"],
    ["TYPE-002", `${prefix}comment_memory.cjs`, "sanitize|validateBody|enforceComment", "HIGH"],
    ["TYPE-007", `${prefix}git_helpers.cjs`, 'GIT_TERMINAL_PROMPT.*"0"|GIT_TERMINAL_PROMPT.*=.*0', "CRITICAL"],
    ["TYPE-007", `${prefix}git_helpers.cjs`, "timeout|TIMEOUT", "CRITICAL"],
    ["TYPE-007", `${prefix}push_to_pull_request_branch.cjs`, "git_helpers", "HIGH"],
    ["EXEC-001", `${prefix}safe_output_handler_manager.cjs`, "missing_tool.*missing_data.*noop|collect.*missing|system.*type", "MEDIUM"],
    ["EXEC-001", `${prefix}safe_output_handler_manager.cjs`, "report_incomplete", "MEDIUM"],
  ];
  for (const [rule, file, pattern, severity, flags] of staticChecks) {
    check(rule, file, pattern, severity, pattern, flags);
  }
  const coveredRules = new Set(rows.map(row => row.rule));
  return {
    rows,
    ruleCoverage: inventory.map(rule => ({
      ...rule,
      status: coveredRules.has(rule.id) ? "partial-native-predicate-replay" : "unimplemented",
      reason: "Read-only lexical predicates do not establish full behavioral specification acceptance.",
    })),
    coverageStatus: "partial",
    fullGoalCompletion: null,
  };
}

export function compare(before, after) {
  const previous = new Map(before.rows.map(row => [row.id, row]));
  const current = new Map(after.rows.map(row => [row.id, row]));
  const remediated = [], introduced = [], unresolved = [], scopeExits = [];
  for (const row of previous.values()) {
    const next = current.get(row.id);
    if (row.status === "fail" && !next) scopeExits.push(row.id);
    if (row.status === "fail" && next?.status === "pass" && !row.suppressed && !next.suppressed) {
      remediated.push({ id: row.id, rule: row.rule, file: row.file, severity: row.severity });
    }
    if (row.status === "unknown" || next?.status === "unknown") unresolved.push(row.id);
  }
  for (const row of current.values()) {
    if (row.status === "fail" && previous.get(row.id)?.status === "pass") introduced.push(row.id);
  }
  return { remediated, introduced, unresolved, scopeExits };
}
