// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { renderExperimentsEvaluation } from '../../src/components/experiments-evaluation.js';

const metadata = /** @type {import('../../src/presenter.js').SourceMetadata} */ ({
  'source-id': 'experiment-fixture',
  'source-kind': 'fixture',
  'as-of': '2026-09-05T12:00:00Z',
  'retrieved-at': '2026-09-05T12:01:00Z',
  completeness: 'complete',
  freshness: 'fresh',
  availability: 'available'
});

/** @param {string} name @param {Array<Record<string, unknown>>} rows */
const source = (name, rows) => ({ source: name, rows, metadata });

afterEach(() => {
  window.history.replaceState(null, '', '/');
});

describe('experiments and evaluation', () => {
  it('keeps decisions, observations, producers, runs, and evidence distinct', () => {
    window.history.replaceState(null, '', '/#page-experiments?experiment=routing-v3');
    const runLink = { href: 'https://github.com/acme/tools/actions/runs/101', label: 'Open run 101' };
    const evidenceLink = { href: 'https://github.com/acme/tools/actions/runs/101/artifacts/5', label: 'Open grader evidence' };
    const sources = {
      experiments: source('experiments', [{
        organization: 'acme',
        repository: 'tools',
        workflow: 'triage-agent',
        experiment: 'routing-v3',
        'experiment-name': 'Tool routing v3',
        'control-variant': 'control',
        'candidate-variant': 'candidate',
        'primary-metric': 'quality',
        readiness: 'READY',
        decision: 'PROMOTE',
        'evidence-strength': 'Strong'
      }]),
      'experiment-assignments': source('experiment-assignments', [
        { experiment: 'routing-v3', run: '100', variant: 'control' },
        { experiment: 'routing-v3', run: '101', variant: 'candidate' },
        { experiment: 'routing-v3', run: '102', variant: 'candidate', 'exclusion-reason': 'eval missing' }
      ]),
      graders: source('graders', [
        { grader: 'quality', role: 'PRIMARY', direction: 'higher_is_better', unit: 'raw' },
        { grader: 'hallucination', role: 'GUARDRAIL', direction: 'lower_is_better', unit: 'percent', threshold: .05 }
      ]),
      'grader-observations': source('grader-observations', [
        { experiment: 'routing-v3', run: '100', grader: 'quality', value: .72, status: 'complete', 'observed-at': '2026-09-04T10:00:00Z' },
        { experiment: 'routing-v3', run: '101', grader: 'quality', value: .81, status: 'complete', 'observed-at': '2026-09-05T10:00:00Z', 'evidence-link': evidenceLink },
        { experiment: 'routing-v3', run: '100', grader: 'hallucination', value: .03, status: 'complete' },
        { experiment: 'routing-v3', run: '101', grader: 'hallucination', value: .07, status: 'complete' },
        { experiment: 'routing-v3', run: '102', grader: 'quality', status: 'missing', 'exclusion-reason': 'grader missing' }
      ]),
      evals: source('evals', [{ eval: 'answer-correct', 'eval-question': 'Is the answer correct?', role: 'SECONDARY' }]),
      'eval-observations': source('eval-observations', [
        { experiment: 'routing-v3', run: '100', eval: 'answer-correct', 'eval-result': 'YES', status: 'complete' },
        { experiment: 'routing-v3', run: '101', eval: 'answer-correct', 'eval-result': 'UNKNOWN', status: 'complete' },
        { experiment: 'routing-v3', run: '102', eval: 'answer-correct', status: 'missing', 'exclusion-reason': 'eval missing' }
      ]),
      runs: source('runs', [
        { run: '100' },
        { run: '101', 'run-conclusion': 'success', 'run-link': runLink },
        { run: '102' }
      ])
    };

    const rendered = renderExperimentsEvaluation({
      pageId: 'experiments',
      title: 'Experiment decisions and evidence',
      sourceNames: Object.keys(sources),
      sources,
      contextDetails: [],
      headingTag: 'h3'
    });

    expect(rendered.querySelector('[data-chart-widget="pie"]')).not.toBeNull();
    expect(rendered.querySelector('.experiment-decision-table')?.textContent).toContain('PROMOTE');
    expect(rendered.querySelector('.experiment-metric-table')?.textContent).toContain('hallucination');
    expect(rendered.querySelector('.experiment-metric-table')?.textContent).toContain('-0.040 ▼');
    expect(rendered.querySelector('.eval-outcome')?.textContent).toContain('Is the answer correct?');
    expect(rendered.querySelector('.eval-stacked-bar')?.getAttribute('aria-label')).toContain('0 unknown or missing');
    expect(rendered.querySelectorAll('.eval-stacked-bar')[1]?.getAttribute('aria-label')).toContain('1 unknown or missing');
    expect(rendered.querySelector('.observation-quality')?.textContent).toContain('grader missing');
    expect(rendered.querySelector('.run-evidence-table')?.textContent).toContain('eval missing');
    expect(rendered.querySelector(`a[href="${evidenceLink.href}"]`)).not.toBeNull();
    expect(rendered.textContent).not.toContain('successful experiment');
  });

  it('distinguishes no configured experiments from an unavailable source', () => {
    const empty = renderExperimentsEvaluation({
      pageId: 'experiments',
      title: 'Experiments',
      sourceNames: ['experiments'],
      sources: { experiments: source('experiments', []) },
      contextDetails: [],
      headingTag: 'h3'
    });
    expect(empty.textContent).toContain('No experiments configured');

    const unavailable = renderExperimentsEvaluation({
      pageId: 'experiments',
      title: 'Experiments',
      sourceNames: ['experiments'],
      sources: {
        experiments: {
          ...source('experiments', []),
          metadata: { ...metadata, availability: 'unavailable' }
        }
      },
      contextDetails: [],
      headingTag: 'h3'
    });
    expect(unavailable.textContent).toContain('Experiment source unavailable');
  });

  it('renders overview and table slices declaratively from config.body', () => {
    const sources = {
      experiments: source('experiments', [{
        organization: 'acme',
        repository: 'tools',
        workflow: 'triage-agent',
        experiment: 'routing-v3',
        'experiment-name': 'Tool routing v3',
        'control-variant': 'control',
        'candidate-variant': 'candidate',
        'primary-metric': 'quality',
        readiness: 'READY',
        decision: 'PROMOTE'
      }]),
      'experiment-assignments': source('experiment-assignments', [
        { experiment: 'routing-v3', run: '100', variant: 'control' },
        { experiment: 'routing-v3', run: '101', variant: 'candidate' }
      ]),
      graders: source('graders', [{ grader: 'quality', role: 'PRIMARY', direction: 'higher_is_better', unit: 'raw' }]),
      'grader-observations': source('grader-observations', [
        { experiment: 'routing-v3', run: '100', grader: 'quality', value: .72, status: 'complete', 'observed-at': '2026-09-04T10:00:00Z' },
        { experiment: 'routing-v3', run: '101', grader: 'quality', value: .81, status: 'complete', 'observed-at': '2026-09-05T10:00:00Z' }
      ]),
      evals: source('evals', []),
      'eval-observations': source('eval-observations', []),
      runs: source('runs', [{ run: '100' }, { run: '101' }])
    };

    const overview = renderExperimentsEvaluation({
      pageId: 'experiments',
      title: 'Experiment readiness overview',
      sourceNames: Object.keys(sources),
      sources,
      contextDetails: [],
      elementConfig: { body: 'overview' },
      headingTag: 'h3'
    });
    expect(overview.querySelector('.experiment-overview')).not.toBeNull();
    expect(overview.querySelector('.experiment-decision-table')).toBeNull();

    const table = renderExperimentsEvaluation({
      pageId: 'experiments',
      title: 'Experiment decision table',
      sourceNames: Object.keys(sources),
      sources,
      contextDetails: [],
      elementConfig: { body: 'table' },
      headingTag: 'h3'
    });
    expect(table.querySelector('.experiment-overview')).toBeNull();
    expect(table.querySelector('.experiment-decision-table')).not.toBeNull();
    expect(table.querySelector('.experiment-detail')).toBeNull();
  });
});
