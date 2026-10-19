import { createRequire } from "node:module";
import { parse } from "espree";

const require = createRequire(import.meta.url);
export const parserVersion = require("espree/package.json").version;
export const yamlFacet = "trailing-spaces-lines-v1";

export function jsFacts(content) {
  let ast;
  try {
    ast = parse(content, { ecmaVersion: "latest", sourceType: "commonjs" });
  } catch {
    return { syntaxValid: false, defects: null };
  }
  let defects = 0;
  const visit = node => {
    if (!node || typeof node !== "object") return;
    if (node.type === "ThrowStatement" && node.argument?.type === "ObjectExpression") {
      const props = node.argument.properties;
      const keys = props.map(prop => prop.type === "Property" && !prop.computed
        && !prop.method && prop.kind === "init" ? prop.key.name ?? prop.key.value : null);
      const code = props[keys.indexOf("code")]?.value;
      const negative = code?.type === "UnaryExpression" && code.operator === "-"
        && code.argument.type === "Literal" && Number.isInteger(code.argument.value) && code.argument.value > 0;
      const rpc = keys.length > 0 && keys.every(key => ["code", "message", "data"].includes(key))
        && keys.includes("message") && negative;
      if (!rpc) defects++;
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === "object") visit(value);
    }
  };
  visit(ast);
  return { syntaxValid: true, defects };
}

export function yamlFacts(content) {
  return { syntaxValid: null, defects: content.split("\n").filter(line => /[ \t]+\r?$/.test(line)).length };
}

export function lintEffect(before, after) {
  if (!before || !after) return null;
  if (before.defects === null || after.defects === null) return null;
  if (![before.defects, after.defects].every(value => Number.isSafeInteger(value) && value >= 0)) {
    throw new Error("Malformed native lint facts");
  }
  return before.defects - after.defects;
}
