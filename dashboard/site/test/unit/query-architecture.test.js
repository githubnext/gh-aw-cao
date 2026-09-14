import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/** @param {string} path */
const read = (path) => readFileSync(resolve(path), 'utf8');

describe('dashboard query architecture', () => {
  it('gives agents an explicit database-authoritative query and effect contract', () => {
    const guidance = read('../../AGENTS.md');

    expect(guidance).toContain('Eliminate every JavaScript-based dashboard query.');
    expect(guidance).toContain('executed by the query engine in the data Web Worker against the canonical database');
    expect(guidance).toContain('Keep the active page or view subscribed to its worker query');
    expect(guidance).toContain('Effects may synchronize query results and local interaction state to owned DOM only.');
  });

  it('executes dashboard queries and subscriptions through the canonical data worker', () => {
    const worker = read('src/data-worker.js');
    const main = read('src/main.js');

    expect(worker).toContain('executeDashboardQueries(context.queries, canonicalPayload, requested');
    expect(worker).not.toMatch(/deriveOverviewSources|deriveRepositorySources|deriveRuntimeSources|deriveWorkflowSources|deriveDataHealthCalloutSources/);
    expect(worker).toContain("operation === 'subscribe-canonical-dashboard'");
    expect(main).toContain('subscribeCanonicalDashboardView(');
    expect(main).toContain('signal: options.signal');
    expect(main).not.toMatch(/const loadPageSources = async[\s\S]{0,600}loadCanonicalDashboardPage/);
  });
});