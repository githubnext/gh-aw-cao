import { createHash } from "node:crypto";

export const revision = "c86377ec47b38f0b5af463277ee55d1d03d08da8";
export const cutoff = "2026-10-18T15:00:12Z";
export const repository = "github/gh-aw";
export const normativePath = "pkg/cli/cli_consistency_help_test.go";
export const documentationPath = "docs/src/content/docs/setup/cli.md";
export const hash = value => createHash("sha256").update(value).digest("hex");
export const sourceTests = [
  "TestUpdateDocsIncludeCoolDownOption",
  "TestCompileDocsReflectCurrentOptions",
  "TestCLIDocsReflectStatusAuditExperimentsAndGradersCommands",
];

export function sourceText(archive, name) {
  const matches = archive.files.filter(file => file.path === name);
  if (matches.length !== 1) throw new Error(`Missing or duplicate source: ${name}`);
  const file = matches[0];
  if (file.encoding !== "base64" || !/^[a-f0-9]{40}$/.test(file.blob)) throw new Error("Invalid source encoding");
  const bytes = Buffer.from(file.content, "base64");
  if (bytes.toString("base64") !== file.content || bytes.length !== file.bytes
    || hash(bytes) !== file.sha256
    || createHash("sha1").update(Buffer.from(`blob ${bytes.length}\0`)).update(bytes).digest("hex") !== file.blob) {
    throw new Error(`Source bytes failed integrity verification: ${name}`);
  }
  const text = bytes.toString("utf8");
  if (!Buffer.from(text).equals(bytes)) throw new Error(`Invalid UTF-8 source: ${name}`);
  return text;
}

export function goTokens(source) {
  const tokens = [];
  for (let offset = 0; offset < source.length;) {
    const rest = source.slice(offset);
    const ignored = rest.match(/^(?:\s+|\/\/[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)/);
    if (ignored) { offset += ignored[0].length; continue; }
    const literal = rest.match(/^(?:`[^`]*`|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')/);
    if (literal) {
      tokens.push({ kind: "literal", text: literal[0], offset });
      offset += literal[0].length;
      continue;
    }
    if (/^[`"']/.test(rest)) throw new Error("Unsupported or unterminated Go literal");
    const identifier = rest.match(/^[A-Za-z_][A-Za-z_0-9]*/)?.[0];
    const text = identifier ?? rest[0];
    tokens.push({ kind: identifier ? "identifier" : "punctuation", text, offset });
    offset += text.length;
  }
  return tokens;
}

export function goString(token) {
  if (typeof token !== "string") throw new Error("Missing Go string");
  if (token.startsWith("`") && token.endsWith("`")) return token.slice(1, -1).replaceAll("\r", "");
  if (!token.startsWith('"') || !token.endsWith('"')) throw new Error("Expected Go string literal");
  return token.slice(1, -1).replace(/\\(U[0-9a-fA-F]{8}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[0-7]{3}|.)/g, (_, escape) => {
    const named = { a: "\x07", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v", "\\": "\\", '"': '"' };
    if (Object.hasOwn(named, escape)) return named[escape];
    if (/^[Uux]/.test(escape)) return String.fromCodePoint(Number.parseInt(escape.slice(1), 16));
    if (/^[0-7]{3}$/.test(escape)) return String.fromCharCode(Number.parseInt(escape, 8));
    throw new Error(`Unsupported Go escape: ${escape}`);
  });
}

function matching(tokens, start, opening, closing) {
  if (tokens[start]?.text !== opening) throw new Error(`Expected ${opening}`);
  let depth = 0;
  for (let index = start; index < tokens.length; index++) {
    if (tokens[index].kind === "literal") continue;
    if (tokens[index].text === opening) depth++;
    if (tokens[index].text === closing) {
      depth--;
      if (depth === 0) return index;
    }
  }
  throw new Error("Unclosed Go delimiter");
}

function argumentsOf(tokens) {
  const result = [[]];
  let depth = 0;
  for (const token of tokens) {
    if (token.kind !== "literal" && ["(", "[", "{"].includes(token.text)) depth++;
    if (token.kind !== "literal" && [")", "]", "}"].includes(token.text)) depth--;
    if (token.text === "," && depth === 0) result.push([]);
    else result.at(-1).push(token);
  }
  return result;
}

function literalExpression(tokens) {
  if (!tokens.length || tokens.length % 2 === 0) return null;
  let result = "";
  for (let i = 0; i < tokens.length; i++) {
    if (i % 2) { if (tokens[i].text !== "+") return null; }
    else {
      if (tokens[i].kind !== "literal" || tokens[i].text.startsWith("'")) return null;
      result += goString(tokens[i].text);
    }
  }
  return result;
}

export function extractDocumentationRules(source) {
  const tokens = goTokens(source), rules = [];
  for (const name of sourceTests) {
    const found = tokens.map((token, index) => token.text === "func" && tokens[index + 1]?.text === name ? index : -1)
      .filter(index => index >= 0);
    if (found.length !== 1) throw new Error(`Missing or duplicate native rule function: ${name}`);
    const start = tokens.findIndex((token, index) => index > found[0] && token.text === "{");
    const end = matching(tokens, start, "{", "}");
    const body = tokens.slice(start + 1, end);
    let ordinal = 0;
    for (let i = 0; i < body.length; i++) {
      if (body[i].text !== "assert" || body[i + 1]?.text !== "."
        || !["Contains", "NotContains"].includes(body[i + 2]?.text)) continue;
      const close = matching(body, i + 3, "(", ")");
      const args = argumentsOf(body.slice(i + 4, close));
      if (args[0]?.map(token => token.text).join("") !== "t") throw new Error("Unsupported assertion receiver");
      const target = args[1]?.map(token => token.text).join("");
      if (!["text", "updateSection", "compileSection"].includes(target)) throw new Error("Unsupported native doc scope");
      rules.push({ id: `${name}:${++ordinal}`, test: name, scope: target,
        operation: body[i + 2].text, expected: literalExpression(args[2] ?? []),
        expression: (args[2] ?? []).map(token => token.text).join(""),
        line: source.slice(0, body[i].offset).split("\n").length });
      i = close;
    }
    if (!ordinal) throw new Error(`No native assertions: ${name}`);
  }
  return rules;
}

export function checkDocumentation(documentation, rules) {
  if (typeof documentation !== "string" || !documentation || !Array.isArray(rules) || !rules.length) {
    throw new Error("Complete native documentation and nonempty rules required");
  }
  return rules.map(rule => {
    const prefix = rule.scope === "updateSection" ? "#### `update`"
      : rule.scope === "compileSection" ? "#### `compile`" : null;
    const start = prefix ? documentation.indexOf(prefix) : 0;
    if (start < 0) return { ...rule, status: "failed", reason: "Required command section absent" };
    if (rule.expected === null) return { ...rule, status: "unavailable", reason: "Native expression requires engine registry; not a literal rule" };
    const present = documentation.slice(start).includes(rule.expected);
    return { ...rule, status: present === (rule.operation === "Contains") ? "passed" : "failed" };
  });
}

export function helpSections(rawOutput) {
  if (typeof rawOutput !== "string" || !rawOutput.trim()) throw new Error("Missing native help bytes");
  const headings = [...rawOutput.matchAll(/^(Usage|Examples|Flags|Global Flags|Available Commands):[ \t]*$/gm)];
  if (!headings.some(match => match[1] === "Usage")) throw new Error("Not a native command help document");
  if (new Set(headings.map(match => match[1])).size !== headings.length) {
    throw new Error("Ambiguous duplicate native help sections");
  }
  return Object.fromEntries(headings.map((heading, index) => [heading[1],
    rawOutput.slice(heading.index + heading[0].length, headings[index + 1]?.index ?? rawOutput.length)]));
}

export function checkHelp(command, rawOutput) {
  const sections = helpSections(rawOutput);
  const rules = [{ id: "help-flag-prefix", source: "cmd/gh-aw/help_flag_test.go",
    status: /--help\b[^\n]*Show help for gh aw/.test(sections.Flags ?? "") ? "passed" : "failed" }];
  if (["compile", "disable", "enable", "new", "remove", "run", "version"].includes(command)) {
    rules.push({ id: "usage-before-examples", source: "cmd/gh-aw/help_sections_order_test.go",
      status: sections.Examples !== undefined && rawOutput.indexOf("\nUsage:") < rawOutput.indexOf("\nExamples:")
        ? "passed" : "failed" });
  }
  return rules;
}

export function reviewNativeSource(archive, frozenRules) {
  if (archive.repository !== repository || archive.repositoryId !== 1036865607 || archive.revision !== revision
    || archive.cutoff !== cutoff || !Array.isArray(archive.files)) throw new Error("Native source scope mismatch");
  const workflow = sourceText(archive, ".github/workflows/cli-consistency-checker.md");
  const workflowFile = archive.files.find(file => file.path === ".github/workflows/cli-consistency-checker.md");
  if (workflowFile.blob !== "1c1b852850fd69016d2b550a9adb38219eb11f30"
    || !workflow.includes("Use real CLI output as source of truth")) throw new Error("Frozen intent mismatch");
  const rules = extractDocumentationRules(sourceText(archive, normativePath));
  if (JSON.stringify(rules) !== JSON.stringify(frozenRules)) throw new Error("Native rule profile changed");
  const results = checkDocumentation(sourceText(archive, documentationPath), rules);
  const counts = Object.fromEntries(["passed", "failed", "unavailable"].map(status =>
    [status, results.filter(rule => rule.status === status).length]));
  return { results, counts, eligibleCount: rules.filter(rule => rule.expected !== null).length,
    inventoryDigest: hash(JSON.stringify(rules)),
    populationDigest: hash(JSON.stringify(rules.filter(rule => rule.expected !== null))),
    documentationDigest: archive.files.find(file => file.path === documentationPath).sha256,
    fullCommandAcceptance: null,
    limitation: "Literal source-defined documentation obligations only; neither runtime help, correct examples, typo absence nor whole-command usability.",
    readiness: {
      checker: "implemented-native-documentation-and-help-facets",
      fullFunction: "partial-native-facet",
      producer: "discovery-only-without-original-execution-receipts",
      evidence: "complete-frozen-doc-bytes; runtime-help-and-behavior-unavailable",
      fullAcceptance: "unavailable",
      contribution: "unavailable",
    } };
}
