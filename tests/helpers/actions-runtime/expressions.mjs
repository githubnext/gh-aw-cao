// Deliberately limited to expressions emitted by the samples/dry-run compiler.
const token = /\s*(?:(\d+(?:\.\d+)?)|('(?:[^']|'')*')|([A-Za-z_][\w-]*)|(&&|\|\||==|!=|>=|<=|[!><()[\].,]))/y;
const precedence = { "||": 1, "&&": 2, "==": 3, "!=": 3, ">": 4, "<": 4, ">=": 4, "<=": 4 };

export function truthy(value) {
  return value !== false && value !== null && value !== undefined && value !== "" && value !== 0;
}

export function evaluate(source, context) {
  if (typeof source !== "string") return source;
  const tokens = [];
  let position = 0;
  source = source.trim().replace(/^\$\{\{([\s\S]*)\}\}$/, "$1").trim();
  while (position < source.length) {
    token.lastIndex = position;
    const match = token.exec(source);
    if (!match) throw new Error(`Unsupported Actions expression at ${source.slice(position)}`);
    tokens.push(match[1] ? { value: Number(match[1]) } : match[2]
      ? { value: match[2].slice(1, -1).replaceAll("''", "'") } : match[3] || match[4]);
    position = token.lastIndex;
  }
  let cursor = 0;
  const take = expected => {
    if (tokens[cursor++] !== expected) throw new Error(`Expected ${expected} in Actions expression`);
  };
  function atom() {
    const next = tokens[cursor++];
    let node;
    if (next === "!") node = { not: atom() };
    else if (next === "(") { node = expression(0); take(")"); }
    else if (next && typeof next === "object") node = { literal: next.value };
    else if (["true", "false", "null"].includes(next)) node = { literal: JSON.parse(next) };
    else if (typeof next === "string" && /^[A-Za-z_]/.test(next)) {
      if (tokens[cursor] === "(") {
        cursor++;
        const args = [];
        if (tokens[cursor] !== ")") {
          do {
            args.push(expression(0));
            if (tokens[cursor] !== ",") break;
            cursor++;
          } while (true);
        }
        take(")");
        node = { call: next, args };
      } else node = { root: next };
    } else throw new Error("Invalid Actions expression");
    while (tokens[cursor] === "." || tokens[cursor] === "[") {
      const dot = tokens[cursor++] === ".";
      const key = dot ? { literal: tokens[cursor++] } : expression(0);
      if (!dot) take("]");
      node = { object: node, key };
    }
    return node;
  }
  function expression(minimum) {
    let node = atom();
    while ((precedence[tokens[cursor]] || 0) > minimum) {
      const op = tokens[cursor++];
      node = { op, left: node, right: expression(precedence[op]) };
    }
    return node;
  }
  const tree = expression(0);
  if (cursor !== tokens.length) throw new Error("Unsupported trailing Actions expression");
  const lower = value => typeof value === "string" ? value.toLowerCase() : value;
  function run(node) {
    if ("literal" in node) return node.literal;
    if (node.root) {
      if (!Object.hasOwn(context, node.root)) throw new Error(`Unsupported Actions context: ${node.root}`);
      return context[node.root];
    }
    if (node.object) {
      const object = run(node.object);
      const key = run(node.key);
      if (["__proto__", "prototype", "constructor"].includes(key)) throw new Error("Invalid Actions property");
      return object && Object.hasOwn(Object(object), key) ? object[key] : "";
    }
    if (node.not) return !truthy(run(node.not));
    if (node.call) {
      const args = node.args.map(run);
      switch (node.call) {
        case "always": return true;
        case "cancelled": return false;
        case "success": return context.status === "success";
        case "failure": return context.status === "failure";
        case "toJSON": return JSON.stringify(args[0]);
        case "fromJSON": return JSON.parse(args[0]);
        case "contains": return Array.isArray(args[0])
          ? args[0].map(lower).includes(lower(args[1]))
          : String(args[0]).toLowerCase().includes(String(args[1]).toLowerCase());
        case "startsWith": return String(args[0]).toLowerCase().startsWith(String(args[1]).toLowerCase());
        case "format": return args[0].replace(/\{(\d+)\}/g, (_, index) => String(args[Number(index) + 1]));
        default: throw new Error(`Unsupported Actions function: ${node.call}`);
      }
    }
    const left = run(node.left);
    if (node.op === "&&") return truthy(left) ? run(node.right) : left;
    if (node.op === "||") return truthy(left) ? left : run(node.right);
    const right = run(node.right);
    switch (node.op) {
      case "==": return lower(left) === lower(right);
      case "!=": return lower(left) !== lower(right);
      case ">": return left > right;
      case "<": return left < right;
      case ">=": return left >= right;
      case "<=": return left <= right;
      default: throw new Error("Unsupported Actions operator");
    }
  }
  return run(tree);
}

export function interpolate(value, context) {
  if (typeof value !== "string") return value;
  const whole = /^\$\{\{([\s\S]*?)\}\}$/.exec(value);
  if (whole && !whole[1].includes("}}")) return evaluate(whole[1], context);
  return value.replace(/\$\{\{([\s\S]*?)\}\}/g, (_, expression) => String(evaluate(expression, context) ?? ""));
}

export function condition(value, context) {
  const expression = value ?? "success()";
  const hasStatus = /\b(?:always|success|failure|cancelled)\s*\(/.test(String(expression));
  return (hasStatus || context.status === "success") && truthy(evaluate(expression, context));
}
