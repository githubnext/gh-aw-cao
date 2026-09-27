declare module "virtual:starlight-agent/config" {
  export const starlightAgentConfig: {
    projectName: string;
    description: string;
    repository?: string;
    scopePath: string;
    generator: string;
    generatorVersion: string;
    excludedIds: string[];
  };
}
