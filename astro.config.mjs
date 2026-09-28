import { defineConfig } from "astro/config";
import { unified } from "@astrojs/markdown-remark";
import starlight from "@astrojs/starlight";
import mermaid from "astro-mermaid";
import starlightBlog from "starlight-blog";
import starlightGitHubAlerts from "starlight-github-alerts";
import starlightLlmsTxt from "starlight-llms-txt";
import starlightAgent from "./docs/plugins/starlight-agent/index.mjs";
import rewriteDocsLinks from "./docs/rewrite-docs-links.mjs";

/**
 * Builds blog author entries, defaulting each picture to the author's GitHub avatar.
 * @param {Record<string, {name: string, url: string, picture?: string}>} authors
 */
function createAuthors(authors) {
  return Object.fromEntries(
    Object.entries(authors).map(([key, author]) => [key, { ...author, picture: author.picture ?? `https://github.com/${key}.png?size=200` }]),
  );
}

export default defineConfig({
  site: "https://githubnext.github.io",
  base: "/gh-aw-cao",
  redirects: {
    "/control-plane-authentication": "/gh-aw-cao/authentication/",
    "/getting-started": "/gh-aw-cao/setup-quickstarts/",
    "/setup/": "/gh-aw-cao/setup-quickstarts/",
  },
  srcDir: "./docs",
  markdown: {
    processor: unified({
      remarkPlugins: [[rewriteDocsLinks, { base: "/gh-aw-cao" }]],
    }),
  },
  integrations: [
    mermaid(),
    starlight({
      title: "CAO",
      description: "Enterprise control planes for GitHub Agentic Workflows.",
      logo: {
        light: "./docs/assets/logo-day.svg",
        dark: "./docs/assets/logo-night.svg",
        alt: "",
      },
      favicon: "/favicon.svg",
      customCss: ["./docs/styles/branding.css"],
      plugins: [
        starlightBlog({
          title: "Central Agentic Ops Blog",
          recentPostCount: 12,
          navigation: "none",
          authors: createAuthors({
            mnkiefer: {
              name: "Mara Kiefer",
              url: "https://github.com/mnkiefer",
            },
            pelikhan: {
              name: "Peli de Halleux",
              url: "https://github.com/pelikhan",
            },
            copilot: {
              name: "Copilot",
              url: "https://github.com/features/copilot",
              picture: "https://avatars.githubusercontent.com/in/1143301?s=200&v=4",
            },
          }),
        }),
        starlightGitHubAlerts(),
        starlightAgent({
          projectName: "Central Agentic Ops",
          description: "Machine-readable navigation for the authoritative CAO documentation and dashboard architecture.",
          repository: "githubnext/gh-aw-cao",
        }),
        starlightLlmsTxt({
          projectName: "Central Agentic Ops",
          description: "Run, observe, and evolve governed GitHub Agentic Workflow campaigns from a central control plane.",
          details: "Start with the high-value routes below. Markdown and Starlight source documents are authoritative; the llms*.txt files are generated during every documentation build.",
          promote: [
            "index",
            "architecture-at-a-glance",
            "setup-quickstarts",
          ],
          demote: [
            "blog/**",
            "operational-value/reports/**",
            "activity-cache-compression-analysis",
            "dashboard-overview-*",
            "dashboard-view-catalog",
            "operational-observability-visualization-specification",
            "dashboard-language-specification",
          ],
          exclude: [
            "activity*",
            "admission",
            "agent-*",
            "agentic-*",
            "architecture",
            "authentication",
            "author-*",
            "blog/**",
            "cao-cli",
            "configuration",
            "control-*",
            "dashboard*",
            "deployment*",
            "execution-*",
            "glossary",
            "marketplace",
            "operational-*",
            "operations",
            "orchestrators-*",
            "rollout-*",
            "setup-fine-*",
            "setup-multiple-*",
            "setup-one-*",
          ],
          optionalLinks: [
            {
              label: "Set up a CAO control plane",
              url: "https://github.com/githubnext/gh-aw-cao/blob/main/skills/setup-cao/SKILL.md",
              description: "Use setup-cao for bootstrap, repository scope, and authentication.",
            },
            {
              label: "Debug a CAO failure",
              url: "https://github.com/githubnext/gh-aw-cao/blob/main/skills/debug-cao/SKILL.md",
              description: "Use debug-cao for policy, credential, workflow, Activity, dashboard, or safe-output failures.",
            },
            {
              label: "Add an existing campaign",
              url: "https://github.com/githubnext/gh-aw-cao/blob/main/skills/add-cao-campaign/SKILL.md",
              description: "Use add-cao-campaign to discover, compare, and install a catalog campaign.",
            },
            {
              label: "Create a new campaign",
              url: "https://github.com/githubnext/gh-aw-cao/blob/main/skills/create-cao-campaign/SKILL.md",
              description: "Use create-cao-campaign to author an orchestrator and its workers.",
            },
            {
              label: "Analyze CAO activity",
              url: "https://github.com/githubnext/gh-aw-cao/blob/main/skills/analyze-cao/SKILL.md",
              description: "Use analyze-cao to answer questions from a published Activity snapshot.",
            },
            {
              label: "Use or extend the CAO CLI",
              url: "https://github.com/githubnext/gh-aw-cao/blob/main/skills/cao-cli/SKILL.md",
              description: "Use cao-cli for command selection, workflow invocation, and CLI development.",
            },
            {
              label: "Compact project context",
              url: "https://githubnext.github.io/gh-aw-cao/llms-small.txt",
              description: "Load only when a routed skill needs project context.",
            },
            {
              label: "Dashboard data access",
              url: "https://githubnext.github.io/gh-aw-cao/cao/llms.txt",
              description: "Choose bounded dashboard artifacts, MCP queries, or local SQLite analysis.",
            },
            {
              label: "Machine-readable resource index",
              url: "https://githubnext.github.io/gh-aw-cao/agent/resources.json",
              description: "Discover every documentation route without loading its body.",
            },
            {
              label: "Scoped documentation index",
              url: "https://githubnext.github.io/gh-aw-cao/agent/llms.txt",
              description: "Browse the small set of important HTML and JSON resources.",
            },
          ],
        }),
      ],
      markdown: {
        processedDirs: ["."],
      },
      components: {
        Footer: "./docs/components/SiteFooter.astro",
        Hero: "./docs/components/HierarchyHero.astro",
        SocialIcons: "./docs/components/HeaderLinks.astro",
        ThemeSelect: "./docs/components/ThemeToggle.astro",
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
        {
          label: "Overview",
          items: [
            { label: "What is Central Agentic Ops?", link: "/architecture-at-a-glance/" },
            { label: "How the control plane works", link: "/architecture/" },
          ],
        },
        {
          label: "Get started",
          items: [
            { label: "Set up the control plane", link: "/setup-quickstarts/" },
            { label: "Add a campaign", link: "/catalog/" },
            { label: "CAO commands", link: "/cao-cli/" },
            { label: "Authentication", link: "/authentication/" },
          ],
        },
        {
          label: "Run safely",
          items: [
            { label: "Control plane status", link: "/cao/" },
            { label: "Admission gates", link: "/admission/" },
            { label: "Roll out a campaign", link: "/rollout-and-routing/" },
            { label: "Monitor and recover", link: "/operations/" },
            { label: "Emergency stop", link: "/operations/#emergency-stop" },
          ],
        },
        {
          label: "Deploy",
          items: [
            { label: "Deployment options", link: "/deployment/" },
            { label: "GitHub Actions only", link: "/deployment-actions/" },
            { label: "Actions with GitHub Apps", link: "/deployment-actions-github-app/" },
            { label: "Actions with a PAT", link: "/deployment-actions-pat/" },
            { label: "Azure", link: "/deployment-azure/" },
            { label: "Coolify", link: "/deployment-coolify/" },
            { label: "Upstash Redis", link: "/deployment-upstash/" },
            { label: "Managed Redis", link: "/deployment-managed-redis/" },
          ],
        },
        {
          label: "Dashboard",
          items: [
            { label: "At a glance", link: "/dashboard/" },
            { label: "Data ingestion", link: "/dashboard-data-ingestion/" },
            { label: "Data model", link: "/dashboard-data-model/" },
            { label: "Language", link: "/dashboard-language/" },
            { label: "Language specification", link: "/dashboard-language-specification/" },
            { label: "View catalog", link: "/dashboard-view-catalog/" },
            { label: "WebMCP", link: "/dashboard-webmcp/" },
            { label: "Agent analysis", link: "/agent-analysis/" },
            { label: "Agent-readable documentation", link: "/agent-resources/" },
            {
              label: "Views",
              items: [
                { label: "Overview", link: "/dashboard-overview/" },
                { label: "Overview components", link: "/dashboard-overview-components/" },
              ],
            },
          ],
        },
        {
          label: "Reference",
          items: [
            { label: "Configuration", link: "/configuration/" },
            { label: "CAO Activity", link: "/activity/" },
            { label: "Campaign package marketplace", link: "/marketplace/" },
            { label: "Operational value", link: "/operational-value/" },
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
            { label: "Add a campaign", link: "/operations/#adding-a-campaign" },
            { label: "Add a worker", link: "/operations/#adding-a-worker" },
            { label: "Validate changes", link: "/operations/#change-validation" },
          ],
        },
      ],
    }),
  ],
});