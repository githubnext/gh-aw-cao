import { createHash } from "node:crypto";

export const oracleVersion = "doc-consolidation-v1";
export const digest = bytes => createHash("sha256").update(bytes).digest("hex");

function decode(bytes) {
  if (!Buffer.isBuffer(bytes)) throw new TypeError("Original content must be bytes");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (text.includes("\0") || text.includes("\r")) throw new Error("Unsupported markdown encoding");
  return text;
}

function parseDocument(bytes) {
  const text = decode(bytes), lines = text.split("\n"), blocks = [];
  let index = 0, context = "", frontmatter = "";
  const headings = [];
  if (lines[0] === "---") {
    const end = lines.indexOf("---", 1);
    if (end < 0) throw new Error("Unterminated frontmatter");
    frontmatter = lines.slice(0, end + 1).join("\n");
    index = end + 1;
  }
  while (index < lines.length) {
    if (!lines[index].trim()) { index++; continue; }
    const start = index;
    const fence = /^ {0,3}(`{3,}|~{3,})/.exec(lines[index]);
    if (fence) {
      index++;
      while (index < lines.length && !new RegExp(`^ {0,3}${fence[1][0]}{${fence[1].length},}\\s*$`).test(lines[index])) index++;
      if (index === lines.length) throw new Error("Unterminated fenced code");
      index++;
    } else {
      while (index < lines.length && lines[index].trim()) index++;
    }
    const value = lines.slice(start, index).join("\n");
    const heading = /^(#{1,6}) /m.exec(value);
    if (heading) {
      const level = heading[1].length;
      headings.length = level;
      headings[level - 1] = value;
      context = headings.map(item => item ?? "").join("\n");
    }
    const prose = !fence && !heading && !/[[\]<>`*_!|\\]|\b(?:warning|caution|note|danger)\b/i.test(value)
      && !/^(?: {4}|\t|[-+>]|\d+[.)])/m.test(value);
    blocks.push({ text: value, context, prose });
  }
  return { text, frontmatter, blocks, protected: /^disable-agentic-editing:\s*true\s*$/m.test(frontmatter) };
}

function counts(values) {
  const result = new Map();
  for (const value of values) result.set(value, (result.get(value) ?? 0) + 1);
  return result;
}

export function inspectUnbloat(beforeBytes, afterBytes, filename) {
  if (!/^docs\/src\/content\/docs\/.+\.md$/.test(filename)
    || filename.startsWith("docs/src/content/docs/blog/")
    || filename.endsWith("/frontmatter-full.md")) return { status: "ineligible", removed: null };
  const before = parseDocument(beforeBytes), after = parseDocument(afterBytes);
  if (before.protected || after.protected) return { status: "ineligible", removed: null };
  if (before.frontmatter !== after.frontmatter) return { status: "unverified", removed: null, reason: "Metadata changed" };
  const key = block => `${block.context}\0${block.text}`;
  const oldCounts = counts(before.blocks.map(key)), newCounts = counts(after.blocks.map(key));
  const oldProse = new Set(before.blocks.filter(block => block.prose).map(key));
  let removed = 0;
  for (const [value, oldCount] of oldCounts) {
    const newCount = newCounts.get(value) ?? 0;
    if (newCount > oldCount) return { status: "unverified", removed: null, reason: "Content added or reordered" };
    if (newCount < oldCount) {
      if (!oldProse.has(value) || newCount < 1) return { status: "unverified", removed: null, reason: "Distinct or non-prose content removed" };
      removed += oldCount - newCount;
    }
  }
  if ([...newCounts].some(([value]) => !oldCounts.has(value))) return { status: "unverified", removed: null, reason: "New content" };
  let next = 0;
  for (const block of before.blocks) if (next < after.blocks.length && key(block) === key(after.blocks[next])) next++;
  if (next !== after.blocks.length) return { status: "unverified", removed: null, reason: "Retained content reordered" };
  return { status: "verified", removed, fullGoal: null, usability: null, semanticAccuracy: null };
}

export function inspectConsolidation(files) {
  if (!Array.isArray(files) || files.length === 0) return { status: "missing", removed: null };
  const eligible = files.filter(file => /^(?:scratchpad|specs)\/.+\.md$/.test(file.path));
  if (!eligible.some(file => file.path === "scratchpad/dev.md")) return { status: "unverified", removed: null, reason: "Target content not preserved" };
  const parsed = eligible.map(file => ({ path: file.path,
    before: file.before === null ? null : parseDocument(file.before),
    after: file.after === null ? null : parseDocument(file.after) }));
  const target = parsed.find(file => file.path === "scratchpad/dev.md");
  if (!target.after) return { status: "unverified", removed: null, reason: "Missing consolidated target" };
  const sources = parsed.filter(file => file.path !== "scratchpad/dev.md");
  const targetProse = new Set(target.after.blocks.filter(block => block.prose).map(block => block.text));
  const occurrences = counts(sources.flatMap(file => [...new Set(file.before?.blocks.filter(block => block.prose).map(block => block.text) ?? [])]));
  let removed = 0;
  for (const source of sources) {
    if (!source.before) continue;
    if (source.before.frontmatter !== (source.after?.frontmatter ?? "")) return { status: "unverified", removed: null, reason: "Source metadata changed" };
    const retained = counts(source.after?.blocks.map(block => block.text) ?? []);
    const consumed = new Map();
    for (const block of source.before.blocks) {
      const used = (consumed.get(block.text) ?? 0) + 1;
      consumed.set(block.text, used);
      if (used <= (retained.get(block.text) ?? 0)) continue;
      if (!block.prose || !targetProse.has(block.text)) return { status: "unverified", removed: null, reason: "Source content lacks exact retained target" };
      if ((occurrences.get(block.text) ?? 0) > 1) removed++;
    }
  }
  return { status: "verified", removed, fullGoal: null, usability: null, semanticAccuracy: null };
}

export function inspectClaudeBarrier(files, support = []) {
  if (!Array.isArray(files)) return { status: "missing", repaired: null, reason: "No original documentation/implementation proof pair" };
  const cli = files.find(file => file.path === "docs/src/content/docs/setup/cli.md");
  if (!cli || cli.before.status !== "present" || cli.after.status !== "present") return { status: "missing", repaired: null,
    reason: "No original core CLI before/after pair; changed labels and out-of-source-scope MDX are not a verified setup repair" };
  const before = decode(cli.before.bytes), after = decode(cli.after.bytes);
  const section = text => {
    const start = text.indexOf("#### `add-wizard`\n");
    if (start < 0) return null;
    const end = text.indexOf("\n#### ", start + 1);
    return text.slice(start, end < 0 ? text.length : end);
  };
  const oldSection = section(before), newSection = section(after);
  if (!oldSection || !newSection) return { status: "missing", repaired: null, reason: "Wizard section unavailable" };
  const requiredPaths = [
    "pkg/cli/add_wizard_command.go", "pkg/cli/add_interactive_orchestrator.go",
    "pkg/cli/add_interactive_engine.go", "pkg/cli/add_interactive_secrets.go",
    "pkg/cli/engine_secrets.go", "pkg/constants/engine_constants.go",
  ];
  const source = new Map(support.filter(item => item.status === "present").map(item => [item.path, decode(item.bytes)]));
  if (requiredPaths.some(filename => !source.has(filename))) return { status: "missing", repaired: null, reason: "Contemporaneous native setup implementation proof missing" };
  const checks = [
    [requiredPaths[0], /Use:\s*"add-wizard <workflow>\.\.\."/],
    [requiredPaths[0], /RunAddInteractive\(cmd\.Context\(\), &AddInteractiveConfig\{/],
    [requiredPaths[0], /EngineOverride:\s*engineOverride/],
    [requiredPaths[1], /c\.configureEngineAPISecret\(c\.EngineOverride\)/],
    [requiredPaths[1], /if c\.hasWriteAccess && !c\.SkipSecret && !c\.UseCopilotRequests/],
    [requiredPaths[2], /if c\.SkipSecret \{/],
    [requiredPaths[2], /if !c\.hasWriteAccess \{/],
    [requiredPaths[2], /checkAndEnsureEngineSecretsForEngine\(config\)/],
    [requiredPaths[3], /GetEngineSecretNameAndValue\(c\.EngineOverride, c\.existingSecrets\)/],
    [requiredPaths[4], /secretName := opt\.SecretName/],
    [requiredPaths[4], /return secretName, "", true, nil/],
    [requiredPaths[4], /return errUnsupportedClaudeOAuthToken/],
    [requiredPaths[5], /Value:\s*string\(ClaudeEngine\),\s*Label:\s*"Claude",\s*Description:\s*"[^"]+",\s*SecretName:\s*AnthropicAPIKey,/],
    [requiredPaths[5], /AnthropicAPIKey = "ANTHROPIC_API_KEY"/],
    [requiredPaths[5], /KeyURL:\s*"https:\/\/console\.anthropic\.com\/settings\/keys"/],
  ];
  if (checks.some(([filename, expression]) => !expression.test(source.get(filename)))) return { status: "missing", repaired: null, reason: "Native implementation outside frozen verified setup pattern; review required" };
  const setup = /When the Claude engine is selected, the wizard configures \[`ANTHROPIC_API_KEY`\]\([^)]*\) on the pull request path: it reuses an available repository or organization secret, uploads a key from the local environment, or prompts for a key from Anthropic Console and stores it as a repository secret\. Secret setup requires repository write access and is skipped with `--no-secret`\./;
  const selection = /engine: claude/;
  if (!selection.test(after)) return { status: "missing", repaired: null, reason: "Correct Claude engine-selection guidance unavailable" };
  const attained = !setup.test(oldSection) && setup.test(newSection);
  if (!attained) return { status: "assessed", repaired: 0, removed: 0, fullGoal: null,
    reason: "Original pair does not demonstrate the frozen missing-to-correct wizard API-key setup repair" };
  if (!after.includes(before.trimEnd())) {
    const match = newSection.match(setup)?.[0];
    if (!match || newSection.replace(/^When the Claude engine is selected,[^\n]*\n?/m, "").trimEnd() !== oldSection.trimEnd()) {
      return { status: "missing", repaired: null, reason: "Existing wizard instructions changed beyond independently checked addition" };
    }
  }
  return { status: "assessed", repaired: 1, removed: 1, fullGoal: null,
    facet: "Missing Claude add-wizard API-key setup instructions repaired",
    independentProof: requiredPaths, semanticAccuracy: null, usability: null,
    limitations: ["Source-pattern static verification, not CLI execution or human onboarding testing.",
      "Added WIF guidance, whole-document correctness and complete non-Copilot adoption remain separate unverified safeguards."] };
}
