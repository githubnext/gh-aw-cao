import { describe, expect, it } from 'vitest';

import { isAgentFacingPage, navigationPageIds, webMCPManifestForDashboard, webMCPToolName } from '../../src/webmcp/manifest.js';
import { listPages } from '../../src/agent/catalog.js';
import { authoritativeDashboard } from '../authoritative-dashboard.js';

/** @typedef {import('../../src/webmcp/manifest.js').DashboardPageDefinition} DashboardPageDefinition */

/**
 * @param {import('../../src/webmcp/manifest.js').WebMCPToolDescriptor[]} manifest
 * @param {string} name
 */
function requireTool(manifest, name) {
  const tool = manifest.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`The manifest does not declare ${name}.`);
  return tool;
}

/**
 * @param {string} id
 * @returns {DashboardPageDefinition}
 */
function requirePage(id) {
  const page = dashboardDocument.dashboard.pages.find((candidate) => candidate.id === id);
  if (!page) throw new Error(`The document does not declare ${id}.`);
  return page;
}

/** @type {{ dashboard: { title: string, navigation: Array<{ label?: string, pages: string[] }>, pages: DashboardPageDefinition[] } }} */
const dashboardDocument = {
  dashboard: {
    title: 'Central Agentic Ops Dashboard',
    navigation: [
      { pages: ['overview'] },
      { label: 'Data', pages: ['cost', 'memory', 'simulator'] }
    ],
    pages: [
      { id: 'overview', kind: 'custom', title: 'Overview' },
      { id: 'cost', kind: 'custom', title: 'Cost', description: 'Observed AI Credit cost.' },
      { id: 'memory', kind: 'custom', title: 'Memory', description: 'Campaign memory.', experimental: true },
      {
        id: 'campaign-detail',
        kind: 'custom',
        title: 'Campaign',
        route: { 'hash-query-parameter': 'campaign' }
      },
      {
        id: 'overview-failed-runs',
        kind: 'custom',
        title: 'Failed runs',
        route: { 'navigation-page': 'overview' }
      },
      {
        id: 'simulator',
        kind: 'custom',
        title: 'Simulator',
        subject: 'Estimate observed AIC under an operator-selected multiplier.',
        form: {
          fields: [
            { id: 'multiplier', label: 'AIC multiplier', control: 'slider', default: 1, min: 0, max: 4, step: 0.25 },
            { id: 'include-live', label: 'Include live runs', control: 'checkbox', default: true },
            {
              id: 'profile',
              label: 'Profile',
              control: 'radio',
              default: 'balanced',
              options: [{ value: 'balanced', label: 'Balanced' }, { value: 'fast', label: 'Fast' }]
            },
            { id: 'offset', label: 'Offset', control: 'slider', default: 0.1, min: 0.1, max: 1, step: 0.25 },
            { id: 'unsupported', label: 'Unsupported', control: 'colour-picker' }
          ]
        }
      }
    ]
  }
};

describe('WebMCP manifest generation', () => {
  it('names tools deterministically from page identifiers', () => {
    expect(webMCPToolName('campaign-detail')).toBe('cao_campaign_detail');
    expect(webMCPToolName('Overview')).toBe('cao_overview');
  });

  it('collects the navigation page identifiers', () => {
    expect([...navigationPageIds(dashboardDocument.dashboard.navigation)]).toEqual(['overview', 'cost', 'memory', 'simulator']);
  });

  it('treats navigation pages and route-parameter pages as agent facing', () => {
    const navigation = navigationPageIds(dashboardDocument.dashboard.navigation);
    expect(isAgentFacingPage(requirePage('overview'), navigation)).toBe(true);
    expect(isAgentFacingPage(requirePage('campaign-detail'), navigation)).toBe(true);
    expect(isAgentFacingPage(requirePage('overview-failed-runs'), navigation)).toBe(false);
    expect(isAgentFacingPage({ id: 'untitled' }, navigation)).toBe(false);
  });

  it('generates one read-only tool per agent-facing page', () => {
    const manifest = webMCPManifestForDashboard(dashboardDocument);
    expect(manifest.map((tool) => tool.name)).toEqual([
      'cao_overview',
      'cao_cost',
      'cao_memory',
      'cao_campaign_detail',
      'cao_simulator'
    ]);
    for (const tool of manifest) {
      expect(tool.annotations).toEqual({ readOnlyHint: true, untrustedContentHint: true });
      expect(tool.inputSchema.additionalProperties).toBe(false);
    }
  });

  it('derives descriptions from the page definition', () => {
    const manifest = webMCPManifestForDashboard(dashboardDocument);
    expect(requireTool(manifest, 'cao_cost').description).toBe('Observed AI Credit cost.');
    expect(requireTool(manifest, 'cao_simulator').description).toBe('Estimate observed AIC under an operator-selected multiplier.');
    expect(requireTool(manifest, 'cao_overview').description).toBe('Read the Overview page of the Central Agentic Ops Dashboard.');
    expect(requireTool(manifest, 'cao_memory').description).toBe('Experimental. Campaign memory.');
  });

  it('maps route parameters to required string properties', () => {
    const tool = requireTool(webMCPManifestForDashboard(dashboardDocument), 'cao_campaign_detail');
    expect(tool.routeParameter).toBe('campaign');
    expect(tool.inputSchema.properties.campaign.type).toBe('string');
    expect(tool.inputSchema.required).toEqual(['campaign']);
  });

  it('maps form controls to JSON Schema properties', () => {
    const tool = requireTool(webMCPManifestForDashboard(dashboardDocument), 'cao_simulator');
    expect(tool.formFields).toEqual(['multiplier', 'include-live', 'profile', 'offset']);
    expect(tool.inputSchema.properties.multiplier).toEqual({
      type: 'number',
      description: 'AIC multiplier',
      minimum: 0,
      maximum: 4,
      multipleOf: 0.25,
      default: 1
    });
    expect(tool.inputSchema.properties['include-live']).toEqual({
      type: 'boolean',
      description: 'Include live runs',
      default: true
    });
    expect(tool.inputSchema.properties.profile).toEqual({
      type: 'string',
      description: 'Profile',
      enum: ['balanced', 'fast'],
      default: 'balanced'
    });
    expect(tool.inputSchema.properties.offset).toEqual({
      type: 'number',
      description: 'Offset',
      minimum: 0.1,
      maximum: 1,
      default: 0.1
    });
    expect(tool.inputSchema.properties.unsupported).toBeUndefined();
    expect(tool.inputSchema.required).toBeUndefined();
  });

  it('returns no tools for an empty or malformed document', () => {
    expect(webMCPManifestForDashboard({})).toEqual([]);
    expect(webMCPManifestForDashboard(/** @type {never} */ ({ dashboard: { pages: 'none' } }))).toEqual([]);
  });
});

describe('webmcp manifest and shared catalog agreement', () => {
  it('derives one tool for each agent-facing page of the shared catalog', () => {
    const manifest = webMCPManifestForDashboard(authoritativeDashboard);
    const pages = listPages(authoritativeDashboard);
    expect(manifest.map((tool) => tool.pageId)).toEqual(pages.map((page) => page.id));
    expect(manifest.map((tool) => tool.name))
      .toEqual(pages.map((page) => webMCPToolName(page.id)));
  });

  it('exposes the same page parameters the catalog declares', () => {
    const manifest = webMCPManifestForDashboard(authoritativeDashboard);
    for (const page of listPages(authoritativeDashboard)) {
      const tool = requireTool(manifest, webMCPToolName(page.id));
      expect(Object.keys(tool.inputSchema.properties).toSorted())
        .toEqual(page.parameters.map((parameter) => parameter.name).toSorted());
      expect(tool.inputSchema.required ?? [])
        .toEqual(page.parameters.filter((parameter) => parameter.required).map((parameter) => parameter.name));
    }
  });

  it('declares every tool as read-only and closed to undeclared input', () => {
    for (const tool of webMCPManifestForDashboard(authoritativeDashboard)) {
      expect(tool.annotations).toEqual({ readOnlyHint: true, untrustedContentHint: true });
      expect(tool.inputSchema.additionalProperties).toBe(false);
    }
  });

  it('never exposes a page the shared catalog withholds', () => {
    const catalogued = new Set(listPages(dashboardDocument).map((page) => page.id));
    for (const tool of webMCPManifestForDashboard(dashboardDocument)) {
      expect(catalogued.has(tool.pageId)).toBe(true);
    }
  });
});
