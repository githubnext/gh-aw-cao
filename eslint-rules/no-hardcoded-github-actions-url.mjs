const GITHUB_ACTIONS_URL = /https:\/\/github\.com\/[^\s]*\/actions(?:\/|$)/;
const EXPRESSION = "__EXPRESSION__";

function urlShape(node) {
  if (!node) return EXPRESSION;
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  if (node.type === "TemplateLiteral") return node.quasis.map((quasi) => quasi.value.cooked ?? quasi.value.raw).join(EXPRESSION);
  if (node.type === "BinaryExpression" && node.operator === "+") return `${urlShape(node.left)}${urlShape(node.right)}`;
  return EXPRESSION;
}

function hasConcatenatingAncestor(node) {
  return node.parent?.type === "BinaryExpression" && node.parent.operator === "+";
}

export default {
  meta: {
    type: "problem",
    docs: {
      description: "disallow hardcoded github.com GitHub Actions URLs",
    },
    schema: [],
    messages: {
      useActionsServerUrl: "Hardcoded github.com GitHub Actions URLs break on GHES; use GITHUB_SERVER_URL or github.server_url.",
    },
  },
  create(context) {
    function reportIfHardcoded(node) {
      if (!hasConcatenatingAncestor(node) && GITHUB_ACTIONS_URL.test(urlShape(node))) {
        context.report({ node, messageId: "useActionsServerUrl" });
      }
    }

    return {
      Literal: reportIfHardcoded,
      TemplateLiteral: reportIfHardcoded,
      BinaryExpression(node) {
        if (node.parent?.type !== "BinaryExpression" || node.parent.operator !== "+") {
          reportIfHardcoded(node);
        }
      },
    };
  },
};
