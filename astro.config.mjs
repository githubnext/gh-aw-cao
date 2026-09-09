import { defineConfig } from "astro/config";
import { unified } from "@astrojs/markdown-remark";
import starlight from "@astrojs/starlight";
import mermaid from "astro-mermaid";
import starlightGitHubAlerts from "starlight-github-alerts";
import rewriteDocsLinks from "./docs/rewrite-docs-links.mjs";

export default defineConfig({
  site: "https://githubnext.github.io",
  base: "/gh-aw-cao",
  srcDir: "./docs",
  markdown: {
    processor: unified({
      remarkPlugins: [[rewriteDocsLinks, { base: "/gh-aw-cao" }]],
    }),
  },
  integrations: [
    mermaid(),
    starlight({
      title: "Central Agentic Ops",
      description: "Enterprise control planes for GitHub Agentic Workflows.",
      logo: {
        src: "./docs/assets/logo.svg",
        alt: "",
      },
      favicon: "/favicon.svg",
      customCss: ["./docs/styles/branding.css"],
      plugins: [starlightGitHubAlerts()],
      markdown: {
        processedDirs: ["."],
      },
      components: {
        Banner: "./docs/components/ExperimentalBanner.astro",
        Footer: "./docs/components/SiteFooter.astro",
        Hero: "./docs/components/HierarchyHero.astro",
      },
      editLink: {
        baseUrl: "https://github.com/githubnext/gh-aw-cao/edit/main/",
      },
      head: [
        {
          // Starlight renders wide markdown tables and code blocks as horizontally
          // scrollable regions (`overflow: auto`), but they aren't keyboard focusable,
          // so keyboard users can't reach clipped content (axe
          // `scrollable-region-focusable`, WCAG 2.1.1/2.1.3). Make overflowing
          // regions focusable with an accessible name.
          tag: "script",
          content: `(function () {
            function findPrecedingHeadingText(headings, table) {
              let text = null;
              for (const heading of headings) {
                if (heading.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING) {
                  text = heading.textContent.trim();
                } else {
                  break;
                }
              }
              return text;
            }
            function markScrollableRegions() {
              document.querySelectorAll(".sl-markdown-content").forEach((content) => {
                const headings = [...content.querySelectorAll("h1, h2, h3, h4, h5, h6")];
                const seenLabels = new Map();
                let unlabeledCount = 0;
                content.querySelectorAll("table, pre").forEach((region) => {
                  if (region.scrollWidth <= region.clientWidth) return;
                  if (!region.hasAttribute("tabindex")) region.setAttribute("tabindex", "0");
                  if (region.hasAttribute("aria-label") || region.hasAttribute("aria-labelledby")) return;
                  const headingText = findPrecedingHeadingText(headings, region);
                  const labelPrefix = region.matches("pre") ? "Scrollable code example" : "Scrollable table";
                  let label;
                  if (headingText) {
                    const labelKey = \`\${labelPrefix}:\${headingText}\`;
                    const count = (seenLabels.get(labelKey) || 0) + 1;
                    seenLabels.set(labelKey, count);
                    label = count > 1 ? \`\${labelPrefix}: \${headingText} (\${count})\` : \`\${labelPrefix}: \${headingText}\`;
                  } else {
                    unlabeledCount += 1;
                    label = \`\${labelPrefix} \${unlabeledCount}\`;
                  }
                  region.setAttribute("aria-label", label);
                });
              });
            }
            if (document.readyState === "loading") {
              document.addEventListener("DOMContentLoaded", markScrollableRegions);
            } else {
              markScrollableRegions();
            }
            window.addEventListener("resize", markScrollableRegions);
            document.addEventListener("astro:page-load", markScrollableRegions);
          })();`,
        },
      ],
      social: [
        {
          icon: "github",
          label: "GitHub repository",
          href: "https://github.com/githubnext/gh-aw-cao",
        },
      ],
      sidebar: [
        { label: "Overview", link: "/" },
        {
          label: "Get started",
          items: [
            { label: "Quickstart", link: "/getting-started/" },
            { label: "Package catalog", link: "/catalog/" },
            { label: "Configure authentication", link: "/authentication/" },
          ],
        },
        {
          label: "Run safely",
          items: [
            { label: "Control plane status", link: "/cao/" },
            { label: "Admission gates", link: "/admission/" },
            { label: "Roll out an operation", link: "/rollout-and-routing/" },
            { label: "Monitor and recover", link: "/operations/" },
            { label: "Emergency stop", link: "/operations/#emergency-stop" },
          ],
        },
        {
          label: "Reference",
          items: [
            { label: "Configuration", link: "/configuration/" },
            { label: "Control plane overview", link: "/architecture/" },
            { label: "Dashboard Overview", link: "/dashboard-overview/" },
            { label: "Dashboard Data Model", link: "/dashboard-data-model/" },
            { label: "CAO Activity", link: "/activity/" },
            { label: "Deployment and governance", link: "/deployment-and-governance/" },
            { label: "Execution and safety", link: "/execution-and-safety/" },
            { label: "Agentic workflow smells", link: "/agentic-workflow-smells/" },
            { label: "Glossary", link: "/glossary/" },
            { label: "Orchestrators and workers", link: "/orchestrators-and-workers/" },
          ],
        },
        {
          label: "Maintain",
          items: [
            { label: "Add a package", link: "/operations/#adding-a-package" },
            { label: "Add a worker", link: "/operations/#adding-a-worker" },
            { label: "Validate changes", link: "/operations/#change-validation" },
          ],
        },
      ],
    }),
  ],
});