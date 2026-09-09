import { dirname, join, normalize, relative, sep } from "node:path";

export default function rewriteDocsLinks({ base }) {
  const docsRoot = join(process.cwd(), "docs");
  const repositoryRoot = process.cwd();

  return (tree, file) => {
    const repositoryPath = relative(repositoryRoot, file.path);
    const packageReadme = repositoryPath.match(/^([^/]+)\/README\.md$/);
    const sourceDirectory = dirname(relative(docsRoot, file.path));

    visit(tree, (node) => {
      if (node.type !== "link" || typeof node.url !== "string") return;

      const match = node.url.match(/^([^?#]+)\.md([?#].*)?$/);
      if (!match || match[1].includes(":")) return;

      if (packageReadme) {
        const target = normalize(join(dirname(repositoryPath), `${match[1]}.md`))
          .split(sep)
          .join("/");
        if (target.startsWith("docs/")) {
          const docsTarget = target.slice("docs/".length).replace(/\.md$/, "");
          const route = docsTarget === "README" ? "" : `${docsTarget}/`;
          node.url = `${base}/${route}${match[2] || ""}`;
        } else if (!target.startsWith("../")) {
          node.url = `https://github.com/githubnext/gh-aw-cao/blob/main/${target}${match[2] || ""}`;
        }
        return;
      }

      const target = normalize(join(sourceDirectory, match[1])).split(sep).join("/");
      if (target.startsWith("../")) return;

      const route = target === "README" ? "" : `${target}/`;
      node.url = `${base}/${route}${match[2] || ""}`;
    });
  };
}

function visit(node, visitor) {
  visitor(node);
  if (!Array.isArray(node.children)) return;
  for (const child of node.children) visit(child, visitor);
}
