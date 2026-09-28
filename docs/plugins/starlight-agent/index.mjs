import { fileURLToPath } from "node:url";

export default function starlightAgent(options = {}) {
  const scopePath = (options.scopePath ?? "agent").replace(/^\/+|\/+$/g, "");
  return {
    name: "starlight-agent",
    hooks: {
      setup({ addIntegration, config, updateConfig }) {
        updateConfig({
          components: {
            ...config.components,
            Head: fileURLToPath(new URL("./AgentHead.astro", import.meta.url)),
          },
        });
        addIntegration({
          name: "starlight-agent",
          hooks: {
            "astro:config:setup"({ config: astroConfig, injectRoute, updateConfig: updateAstroConfig }) {
              injectRoute({
                entrypoint: new URL("./agent-resource.json.ts", import.meta.url),
                pattern: "/[...slug]/index.json",
                prerender: true,
              });
              injectRoute({
                entrypoint: new URL("./scoped-llms.txt.ts", import.meta.url),
                pattern: `/${scopePath}/llms.txt`,
                prerender: true,
              });

              const moduleId = "virtual:starlight-agent/config";
              const resolvedModuleId = `\0${moduleId}`;
              const pluginConfig = {
                projectName: options.projectName ?? config.title,
                description: options.description ?? config.description,
                repository: options.repository,
                scopePath,
                generator: "starlight-agent",
                generatorVersion: "1",
                generatedAt: new Date().toISOString(),
                excludedIds: Object.keys(astroConfig.redirects ?? {})
                  .map((route) => route.replace(/^\/+|\/+$/g, ""))
                  .filter(Boolean),
              };
              updateAstroConfig({
                vite: {
                  plugins: [{
                    name: "vite-plugin-starlight-agent",
                    resolveId(id) {
                      if (id === moduleId) return resolvedModuleId;
                    },
                    load(id) {
                      if (id === resolvedModuleId) {
                        return `export const starlightAgentConfig = ${JSON.stringify(pluginConfig)}`;
                      }
                    },
                  }],
                },
              });
            },
          },
        });
      },
    },
  };
}
