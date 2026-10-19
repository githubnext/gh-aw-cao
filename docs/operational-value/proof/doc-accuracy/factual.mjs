function section(text, heading, includeCode = false) {
  const lines = text.split("\n"), selected = [];
  let active = false, level = 0, fence = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; continue; }
    if (fence && !includeCode) continue;
    const match = /^(#{1,6})\s+(.+)$/.exec(line);
    if (match) {
      if (active && match[1].length <= level) active = false;
      if (heading.test(match[2])) { active = true; level = match[1].length; }
    }
    if (active) selected.push(line);
  }
  return selected;
}

const codeNames = text => [...text.matchAll(/`([a-z][a-z0-9_-]*)`/g)].map(match => match[1]);
function aliases(text) {
  const pairs = new Set();
  for (const line of section(text, /^Invalid (?:Network )?Shorthands$/i)) {
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").slice(1, -1);
    if (![2, 3].includes(cells.length)) continue;
    const valid = codeNames(cells.at(-1));
    if (valid.length !== 1) continue;
    for (const invalid of codeNames(cells[0])) pairs.add(`${invalid}->${valid[0]}`);
  }
  return pairs;
}

export function networkGuidance(before, after, referenceBefore, referenceAfter) {
  const old = aliases(before), current = aliases(after), first = aliases(referenceBefore), last = aliases(referenceAfter);
  return [...current].filter(pair => !old.has(pair) && first.has(pair) && last.has(pair))
    .sort().map(identity => ({ kind: "network-alias", identity }));
}

export function goTokens(source) {
  const tokens = [];
  let i = 0;
  while (i < source.length) {
    const rest = source.slice(i);
    if (/^\s/.test(rest)) { i++; continue; }
    if (rest.startsWith("//")) {
      const end = source.indexOf("\n", i);
      i = end < 0 ? source.length : end + 1;
      continue;
    }
    if (rest.startsWith("/*")) {
      const end = source.indexOf("*/", i + 2);
      if (end < 0) throw new Error("Unterminated source comment");
      i = end + 2;
      continue;
    }
    if (['"', "'", "`"].includes(source[i])) {
      const quote = source[i], start = i++;
      let complete = false;
      while (i < source.length) {
        if (source[i] === "\\" && quote !== "`") { i += 2; continue; }
        if (source[i++] === quote) { complete = true; break; }
      }
      if (!complete) throw new Error("Unterminated source literal");
      tokens.push(source.slice(start, i));
      continue;
    }
    const word = /^[A-Za-z_][A-Za-z_0-9]*|^[0-9]+|^(?:==|!=|&&|\|\|)/.exec(rest)?.[0];
    tokens.push(word ?? source[i]);
    i += word?.length ?? 1;
  }
  return tokens;
}

function sequence(tokens, text) {
  const expected = goTokens(text);
  return tokens.some((_, i) => expected.every((value, j) => tokens[i + j] === value));
}

function outputs(text) {
  const result = new Set();
  for (const line of section(text, /^Safe Output Mapping$/i)) {
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").slice(1, -1);
    if (cells.length === 2) for (const name of codeNames(cells[1])) result.add(name);
  }
  return result;
}

function registeredOutputs(text) {
  const tokens = goTokens(text), signature = goTokens("var ValidationConfig = map[string]TypeValidationConfig{");
  const start = tokens.findIndex((_, i) => signature.every((value, j) => tokens[i + j] === value));
  if (start < 0) throw new Error("Unsupported safe-output registration source");
  const result = new Set();
  let depth = 1;
  for (let i = start + signature.length; i < tokens.length && depth > 0; i++) {
    if (depth === 1 && /^"[a-z_]+"$/.test(tokens[i]) && tokens[i + 1] === ":" && tokens[i + 2] === "{") {
      result.add(JSON.parse(tokens[i]).replaceAll("_", "-"));
    }
    if (tokens[i] === "{") depth++;
    if (tokens[i] === "}") depth--;
  }
  if (depth !== 0 || result.size === 0) throw new Error("Invalid safe-output registration block");
  return result;
}

export function outputGuidance(before, after, schemaBefore, schemaAfter, registryBefore, registryAfter) {
  const keys = schema => {
    const properties = JSON.parse(schema).properties?.["safe-outputs"]?.properties;
    if (!properties) throw new Error("Unsupported safe-output workflow schema");
    return new Set(Object.keys(properties));
  };
  const old = outputs(before), fresh = outputs(after), a = keys(schemaBefore), b = keys(schemaAfter);
  const first = registeredOutputs(registryBefore), last = registeredOutputs(registryAfter);
  const accepted = [], rejected = [];
  for (const name of fresh) {
    if (old.has(name)) continue;
    const supported = a.has(name) && b.has(name) && first.has(name) && last.has(name);
    (supported ? accepted : rejected).push({ kind: "safe-output-mapping", identity: name,
      ...(supported ? {} : { reason: "Exact operation name is not both a schema configuration key and a registered operation at both revisions." }) });
  }
  return { accepted, rejected };
}

export function toolsetRepairs(before, after, dataBefore, dataAfter, schemaBefore, schemaAfter) {
  const names = text => new Set(codeNames(text.split("\n").find(line => line.startsWith("**Available**:")) ?? ""));
  const a = JSON.parse(dataBefore).toolsets, b = JSON.parse(dataAfter).toolsets;
  const first = JSON.parse(schemaBefore).$defs?.github_toolset_name?.enum;
  const last = JSON.parse(schemaAfter).$defs?.github_toolset_name?.enum;
  if (!a || !b || !Array.isArray(first) || !Array.isArray(last)) throw new Error("Unsupported canonical toolset evidence");
  const accepted = [], rejected = [], current = names(after);
  for (const name of names(before)) {
    if (current.has(name)) continue;
    const unsupported = !Object.hasOwn(a, name) && !Object.hasOwn(b, name) && !first.includes(name) && !last.includes(name);
    (unsupported ? accepted : rejected).push({ kind: "stale-toolset", identity: name,
      ...(unsupported ? {} : { reason: "Frozen v2 requires absence from both canonical permissions data and schema enum at both revisions." }) });
  }
  return { accepted, rejected };
}

function authWitness(source) {
  const tokens = goTokens(source);
  return sequence(tokens, 'var errUnsupportedClaudeOAuthToken = errors.New("CLAUDE_CODE_OAUTH_TOKEN is not supported for Claude workflows; use ANTHROPIC_API_KEY or configure Anthropic Workload Identity Federation instead")')
    && sequence(tokens, 'if engine == string(constants.ClaudeEngine) && value == "" && os.Getenv("CLAUDE_CODE_OAUTH_TOKEN") != "" { return "", "", false, errUnsupportedClaudeOAuthToken }');
}

export function authenticationRepair(before, after, runtimeBefore, runtimeAfter) {
  const warnings = text => text.split(/\n\s*\n/).filter(block => block.includes("`CLAUDE_CODE_OAUTH_TOKEN`"));
  const old = warnings(before).some(block => /silently ignored/.test(block) && /(?:never|does not) mention/.test(block));
  const next = warnings(after).some(block => /(?:error naming|explicit error|error.*names)/i.test(block)
    && block.includes("`ANTHROPIC_API_KEY`") && !/silently ignored/.test(block));
  return old && next && authWitness(runtimeBefore) && authWitness(runtimeAfter)
    ? [{ kind: "named-token-auth-error", identity: "CLAUDE_CODE_OAUTH_TOKEN->explicit-named-error" }] : [];
}

export function compileFlagRepair(before, after, commandBefore, commandAfter, runtimeBefore, runtimeAfter) {
  const row = text => text.split("\n").filter(line => line.startsWith("|") && /\|\s*`--allow-experimental`\s*\|/.test(line));
  const registered = text => {
    const tokens = goTokens(text);
    return sequence(tokens, 'compileCmd.Flags().Bool("allow-experimental", false,')
      && sequence(tokens, 'cmd.Flags().GetBool("allow-experimental")');
  };
  const read = text => sequence(goTokens(text), "if config.AllowExperimental {");
  return row(before).length === 0 && row(after).length === 1
    && registered(commandBefore) && registered(commandAfter) && read(runtimeBefore) && read(runtimeAfter)
    ? [{ kind: "registered-compile-flag", identity: "compile:--allow-experimental" }] : [];
}

export function explicitParentRepair(before, after, schemaBefore, schemaAfter, handlerBefore, handlerAfter) {
  const documented = text => {
    const scoped = section(text, /^Link Sub-Issue \(`link-sub-issue:`\)$/i, true).join("\n");
    return /safe-outputs:\n {2}link-sub-issue:\n {4}target: "\*"/.test(scoped)
      && /`target` selects the parent:/.test(scoped)
      && /"\*"` uses the agent's `parent_issue_number`/.test(scoped);
  };
  const valid = schema => {
    const variants = JSON.parse(schema).properties?.["safe-outputs"]?.properties?.["link-sub-issue"]?.oneOf;
    if (!Array.isArray(variants)) throw new Error("Unsupported sub-issue configuration schema");
    const targets = variants.filter(item => item.type === "object").map(item => item.properties?.target);
    return targets.length === 1 && targets[0]?.type === "string" && !targets[0].pattern
      && (!targets[0].enum || targets[0].enum.includes("*"));
  };
  const supports = source => {
    const tokens = goTokens(source);
    return sequence(tokens, 'const targetConfig = config.target || "triggering";')
      && sequence(tokens, 'if (targetConfig === "*") { parentResolved = resolveRepoIssueTarget(item.parent_issue_number, temporaryIdMap, itemOwner, itemRepo);');
  };
  return !documented(before) && documented(after) && valid(schemaBefore) && valid(schemaAfter)
    && supports(handlerBefore) && supports(handlerAfter)
    ? [{ kind: "explicit-sub-issue-parent", identity: "link-sub-issue.target:*=agent-parent" }] : [];
}

export function factualRepairs(slug, change, originals) {
  const before = file => originals.text(change.parent, file);
  const after = file => originals.text(change.commit, file);
  const schema = "pkg/parser/schemas/main_workflow_schema.json";
  const records = [], rejected = [];
  const add = (file, values) => records.push(...values.map(value => ({ file, ...value })));
  for (const file of change.files) {
    if (before(file) === null || after(file) === null) continue;
    if (slug === "designer-drift-audit" && file === ".github/aw/designer.md") {
      add(file, networkGuidance(before(file), after(file), before(".github/aw/network.md"), after(".github/aw/network.md")));
    } else if (slug === "designer-drift-audit" && file === ".github/aw/designer-mappings.md") {
      const registry = "pkg/workflow/safe_outputs_validation_config.go";
      const result = outputGuidance(before(file), after(file), before(schema), after(schema), before(registry), after(registry));
      add(file, result.accepted);
      rejected.push(...result.rejected.map(value => ({ file, ...value })));
    } else if (slug === "daily-doc-healer" && file.endsWith("/github-tools.md")) {
      const data = "pkg/workflow/data/github_toolsets_permissions.json";
      const result = toolsetRepairs(before(file), after(file), before(data), after(data), before(schema), after(schema));
      add(file, result.accepted);
      rejected.push(...result.rejected.map(value => ({ file, ...value })));
    } else if (slug === "daily-doc-healer" && /\/(?:cli\.md|quick-start\.mdx)$/.test(file)) {
      const runtime = "pkg/cli/engine_secrets.go";
      add(file, authenticationRepair(before(file), after(file), before(runtime), after(runtime)));
    } else if (slug === "daily-doc-updater" && file.endsWith("/cli.md")) {
      const values = compileFlagRepair(before(file), after(file), before("cmd/gh-aw/main.go"), after("cmd/gh-aw/main.go"),
        before("pkg/cli/compile_development.go"), after("pkg/cli/compile_development.go"));
      add(file, values);
      if (!values.length && !before(file).includes("`--allow-experimental`") && after(file).includes("`--allow-experimental`")) {
        rejected.push({ file, kind: "registered-compile-flag", identity: "compile:--allow-experimental",
          reason: "Frozen v2 requires an exact option row; the native change adds an options-list entry and prose, not that row." });
      }
    } else if (slug === "daily-doc-updater" && file.endsWith("/safe-outputs.md")) {
      const handler = "actions/setup/js/link_sub_issue.cjs";
      add(file, explicitParentRepair(before(file), after(file), before(schema), after(schema), before(handler), after(handler)));
    }
  }
  return { records, rejected };
}
