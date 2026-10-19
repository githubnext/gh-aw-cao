import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "espree";
import { readCensusJson, writeCensusJson } from "./operational-value-census-io.mjs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const modulePath = "docs/operational-value/proof/functions/smoke-multi-pr.mjs";
const directory = "docs/operational-value/proof/smoke-multi-pr-native";
const parseModule = source => parse(source, { ecmaVersion: "latest", sourceType: "module", range: true, tokens: true });
const withoutPositions = value => Array.isArray(value) ? value.map(withoutPositions)
  : value && typeof value === "object" ? Object.fromEntries(Object.entries(value)
    .filter(([key]) => !["start", "end", "range", "loc", "tokens"].includes(key))
    .map(([key, child]) => [key, withoutPositions(child)])) : value;
const lexemes = (source, ast) => ast.tokens.map(token => ({ type: token.type, raw: source.slice(...token.range) }));

export function verifyMultiPrFormatting(original, replacement) {
  const before = parseModule(original), after = parseModule(replacement);
  assert.deepEqual(withoutPositions(before), withoutPositions(after), "Formatting changed module AST");
  assert.deepEqual(lexemes(original, before), lexemes(replacement, after), "Formatting changed token lexemes");
  return { astSha256: hash(JSON.stringify(withoutPositions(before))),
    tokenLexemesSha256: hash(JSON.stringify(lexemes(original, before))), tokens: before.tokens.length };
}

export function formatMultiPrWrapper(source) {
  const ast = parseModule(source), edits = [];
  const visit = node => {
    if (!node || typeof node !== "object") return;
    if (node.type === "ObjectExpression" && node.properties.length && node.properties.every(property =>
      property.type === "Property" && ["Literal", "UnaryExpression"].includes(property.value.type))) {
      const tokens = ast.tokens.filter(token => token.range[0] >= node.range[0] && token.range[1] <= node.range[1]);
      const compact = tokens.map(token => source.slice(...token.range)).join(" ");
      if (compact.length <= 240 && source.slice(...node.range).includes("\n")) edits.push({ range: node.range, compact });
    }
    for (const [key, value] of Object.entries(node)) if (!["tokens", "range"].includes(key)) {
      if (Array.isArray(value)) value.forEach(visit);
      else visit(value);
    }
  };
  visit(ast);
  let replacement = source;
  for (const { range, compact } of edits.sort((left, right) => right.range[0] - left.range[0])) {
    replacement = replacement.slice(0, range[0]) + compact + replacement.slice(range[1]);
  }
  verifyMultiPrFormatting(source, replacement);
  return replacement;
}

export function preserveAndFormatMultiPr() {
  const original = readFileSync(modulePath, "utf8"), predecessorSha256 = hash(original);
  const replacement = formatMultiPrWrapper(original), replacementSha256 = hash(replacement);
  if (predecessorSha256 === replacementSha256) throw new Error("Module is already formatted; do not relabel a predecessor");
  const version = `${directory}/versions/${predecessorSha256}`;
  mkdirSync(version, { recursive: true });
  const archivePath = `${version}/formatting-predecessor.json.gz`;
  if (existsSync(archivePath)) throw new Error("Never replace preserved original formatting evidence");
  const walk = root => readdirSync(root, { withFileTypes: true }).flatMap(entry => entry.name === "versions" ? []
    : entry.isDirectory() ? walk(`${root}/${entry.name}`) : [`${root}/${entry.name}`]);
  const reports = "docs/operational-value/proof/reports/github-gh-aw";
  const files = [modulePath, ...walk(directory),
    ...readdirSync("scripts").filter(name => name.includes("smoke-multi-pr") && name.endsWith(".mjs")).map(name => `scripts/${name}`),
    "tests/unit/cao-operational-value-smoke-multi-pr-native.test.mjs",
    ...readdirSync(reports).filter(name => name.startsWith("smoke-multi-pr-")).map(name => `${reports}/${name}`)]
    .sort().map(file => { const bytes = readFileSync(file); return { path: file, sha256: hash(bytes), content: bytes.toString("base64") }; });
  const archive = { schemaVersion: 1, kind: "formatting-only-predecessor", functionSha256: predecessorSha256, files };
  writeCensusJson(archivePath, archive);
  assert.deepEqual(readCensusJson(archivePath), archive);
  const receipt = { schemaVersion: 1, kind: "formatting-only-equivalence", predecessorSha256, replacementSha256,
    modulePath, archivePath, archiveSha256: hash(readFileSync(archivePath)),
    ...verifyMultiPrFormatting(original, replacement), beforeLines: original.split("\n").length,
    afterLines: replacement.split("\n").length,
    preservedFiles: files.map(({ path, sha256 }) => ({ path, sha256 })),
    invariant: "Only inter-token whitespace changes. Original sources, proofs, indexes and observation identities remain byte-preserved; active reports use the new function SHA." };
  writeCensusJson(`${directory}/formatting-equivalence.json`, receipt);
  writeFileSync(modulePath, replacement);
  return receipt;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const receipt = preserveAndFormatMultiPr();
  console.log(JSON.stringify({ ...receipt, preservedFiles: receipt.preservedFiles.length }));
}
