import { describe, expect, it } from 'vitest';
import { processDataRequest } from '../../src/data-worker.js';
import editor from '../../canvas-query-editor.json' with { type: 'json' };
import { validateDashboardDocument } from '../../src/validator.js';
import previewFixture from '../fixtures/query-editor.json' with { type: 'json' };
import layeredFixture from '../fixtures/chart-layer-facet-contract.json' with { type: 'json' };

const previewDocument = () => structuredClone(previewFixture);

/** @param {unknown} document */
const validate = (document) => processDataRequest({ operation: 'validate-query-editor-document', content: JSON.stringify(document) });

describe('query editor worker validation', () => {
  it('validates the canvas-only declarative authoring page', () => {
    expect(validateDashboardDocument(JSON.stringify(editor))).toMatchObject({ ok: true });
  });

  it('accepts complete bounded Dashboard Language and reports preview sources', async () => {
    expect(await validate(previewDocument())).toMatchObject({
      ok: true, pageId: 'query-preview', sourceNames: ['failure-counts'], errors: []
    });
  });

  it('accepts bounded layered facets without a forbidden view-level limit', async () => {
    const document = structuredClone(layeredFixture);
    document.dashboard.pages[0].id = 'query-preview';
    expect(await validate(document)).toMatchObject({ ok: true });
    document.dashboard.queries[0].limit = 201;
    expect(await validate(document)).toMatchObject({ ok: false });
  });

  it('fails closed on unknown fields, cycles, invalid YAML, and oversized input', async () => {
    const badField = previewDocument();
    badField.dashboard.queries[0].aggregate.by = ['made-up-field'];
    expect(await validate(badField)).toMatchObject({ ok: false });
    const cycle = previewDocument();
    cycle.dashboard.queries[0].from = 'failure-counts';
    expect(await validate(cycle)).toMatchObject({ ok: false });
    for (const content of ['[invalid', 'x'.repeat(131073)]) {
      expect(await processDataRequest({ operation: 'validate-query-editor-document', content })).toMatchObject({ ok: false });
    }
  });

  it('rejects editor recursion, unbounded views, other page IDs, and new capabilities', async () => {
    const unbounded = previewDocument();
    unbounded.dashboard.pages[0].views[0].data.limit = 201;
    expect(await validate(unbounded)).toMatchObject({ ok: false, errors: [expect.objectContaining({ code: 'QUERY-EDITOR' })] });
    const unboundedQuery = previewDocument();
    unboundedQuery.dashboard.queries[0].limit = 201;
    expect(await validate(unboundedQuery)).toMatchObject({ ok: false });
    const otherPage = previewDocument();
    otherPage.dashboard.pages[0].id = 'overview';
    expect(await validate(otherPage)).toMatchObject({ ok: false });
    expect(await validate(editor)).toMatchObject({ ok: false });
    const actions = {
      ...previewDocument(),
      dashboard: { ...previewDocument().dashboard, 'cli-actions': [{ id: 'write', label: 'Write', icon: 'code', command: 'gh aw update' }] }
    };
    expect(await validate(actions)).toMatchObject({ ok: false });
  });
});
