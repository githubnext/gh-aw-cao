/**
 * Presentation of query-prepared workflow value evidence.
 * Counts, relationships, comparison and coverage belong to Dashboard Language.
 */
import { h, svgAnchor } from '../dom.js';
import { createDebug } from '../debug.js';
import { render, state } from '../reactive.js';
import { formatNumber } from '../view-formatters.js';
import { bindFactorySources, createFactoryScope } from './factory-elements.js';
import { externalAnchorAttrs } from './link-content.js';
import { isSafeHttpsUrl, renderIconSpan, renderLoadingMessage, renderVisualizationEmptyMessage } from './ui-primitives.js';

const debugWorkflowValueReport = createDebug('workflow-value-report');

/** @typedef {Record<string, unknown>} Row */
/** @typedef {import('./ui-elements.js').ElementRenderContext} Context */

/** @param {unknown} value */
const text = value => typeof value === 'string' ? value : '';
/** @param {unknown} value */
const quantity = value => typeof value === 'number' && Number.isFinite(value) ? formatNumber(value) : 'Unknown';
/** @param {unknown} value */
const date = value => text(value) ? new Date(text(value)).toLocaleDateString('en-US', { timeZone: 'UTC', year: 'numeric', month: 'short', day: 'numeric' }) : 'Not retained';

/** @param {unknown} label @param {unknown} url */
function evidenceLink(label, url) {
  const name = text(label) || 'Evidence';
  return typeof url === 'string' && isSafeHttpsUrl(url) ? h('a', externalAnchorAttrs(url, name), name) : h('span', null, name);
}

/**
 * @param {Context} context
 * @param {(rows: Row[][]) => HTMLElement} draw
 */
function boundEvidence(context, draw) {
  const scope = createFactoryScope();
  const bindings = bindFactorySources(context.sources, context.sourceNames, {
    pageId: context.pageId, viewId: context.viewId, viewIndex: context.viewIndex,
    sourceNames: context.sourceNames, routeParameters: context.routeParameters, queryContext: context.queryContext
  }, { requestMissingSources: !context.sourcesSubscribed });
  const root = h('section', { className: 'workflow-value-report-bound', 'aria-label': context.title });
  render(root, () => {
    const header = bindings[context.sourceNames[0]];
    if (context.sourceNames.some(name => bindings[name].pending() && !bindings[name].source())) {
      return renderLoadingMessage('Loading published value evidence...');
    }
    if (context.sourceNames.some(name => bindings[name].unavailable())) {
      debugWorkflowValueReport({ event: 'evidence-unavailable', sources: context.sourceNames.length });
      return renderVisualizationEmptyMessage('Value evidence is unavailable. Check collection and ingestion; missing evidence is not zero value.');
    }
    if (!header?.source() || header.empty()) {
      debugWorkflowValueReport({ event: 'evidence-empty', sources: context.sourceNames.length });
      return renderVisualizationEmptyMessage('No value evidence has been published for this selection.');
    }
    return draw(context.sourceNames.map(name => bindings[name].rows()));
  }, { signal: scope.signal });
  scope.bind(root);
  return root;
}

/** @param {Context} context */
export function renderWorkflowValueReport(context) {
  const expanded = state(false);
  return boundEvidence(context, ([headers, sources, requirements, outputs, trails, files, snapshots, checks, limitations, origins]) => {
    const summary = headers[0];
    const root = h('article', { className: 'workflow-value-report' });
    const evidence = h('details', { className: 'value-report-evidence', open: expanded.get(),
      onToggle: (/** @type {Event} */ event) => {
        if (event.currentTarget instanceof HTMLDetailsElement) expanded.set(event.currentTarget.open);
      } },
      h('summary', null, 'Explore evidence'));
    /** @param {string} id @param {Event} event */
    const reveal = (id, event) => {
      debugWorkflowValueReport({ event: 'evidence-revealed', section: id });
      const owner = event.currentTarget instanceof Element ? event.currentTarget.closest('.workflow-value-report') : null;
      owner?.querySelector('.value-report-evidence')?.setAttribute('open', '');
      expanded.set(true);
      const destination = owner?.querySelector(`[data-value-section="${id}"]`);
      if (destination instanceof HTMLElement) {
        destination.scrollIntoView?.({ block: 'start' });
        destination.focus({ preventScroll: true });
      }
    };
    /** @param {string} label @param {unknown} value @param {string} unit @param {string} destination */
    const trail = (label, value, unit, destination) => h('div', null,
      h('span', null, label),
      h('button', { type: 'button', onClick: reveal.bind(null, destination), 'aria-label': `${label}: ${quantity(value)} ${unit}. Explore evidence.` },
        h('strong', null, quantity(value)), ` ${unit}`));
    const back = text(summary['workflow-value-href']);
    root.append(h('header', { className: 'value-report-heading' },
      h('a', { href: '#page-value' }, '← Value'),
      h('h2', null, back ? h('a', { href: back }, text(summary['workflow-name']) || text(summary.workflow))
        : text(summary['workflow-name']) || text(summary.workflow)),
      h('p', { className: 'muted', title: `Captured ${text(summary['observed-at'])}; evidence cutoff ${text(summary['window-end'])}` },
        `Evidence captured ${date(summary['observed-at'])} · Cutoff ${date(summary['window-end'])}`),
      h('h3', null, 'Workflow intent'), h('p', null, text(summary.goal))));
    const outputTrail = trail('Safe outputs', summary['output-count'], text(summary['output-unit']) || 'outputs', 'outputs');
    outputTrail.append(h('p', { className: 'muted' }, `${quantity(summary['receipt-outputs'])} receipt-confirmed`));
    const implementationTrail = trail('Accepted changes', summary['accepted-implementations'], text(summary['implementation-unit']) || 'changes', 'trails');
    implementationTrail.append(h('p', { className: 'muted' }, 'Linked to outputs'));
    const resultTrail = trail(summary['complete-report'] === true ? 'Measured result' : 'Known subtotal', summary['native-result'], text(summary['metric-unit']), 'files');
    resultTrail.append(h('p', { className: 'muted' }, text(summary['result-label'])));
    if (summary['show-workflow-trail'] === true) {
      root.append(h('div', { className: 'value-report-trail' }, outputTrail, implementationTrail, resultTrail),
        h('p', { className: 'muted value-report-scope' },
          `Retained cohort since ${date(summary['window-start'])}. Output creation is not acceptance; these are different populations, not a conversion rate.`));
    }
    const state = h('section', { className: 'value-report-outcome', 'aria-label': 'Independent repository outcome' },
      h('h3', null, renderIconSpan('value-report-icon', 'graph'), text(summary['snapshot-name']) || 'Repository outcome'),
      h('div', { className: 'value-report-outcome-body' },
        h('div', null,
          h('a', { href: text(summary['current-snapshot-href']) || text(summary['report-href']), className: 'value-report-number' },
            quantity(summary['current-value']), h('span', null, ` ${text(summary['snapshot-unit'])}`)),
          h('p', { className: 'value-report-movement', 'data-movement': text(summary.movement) }, text(summary['change-label'])),
          h('p', { className: 'muted' }, text(summary['comparison-label']))),
        renderSnapshotPlot(snapshots, text(summary['direction-label']))));
    root.append(state,
      h('section', { className: 'value-report-recent', 'aria-label': 'Recent accepted contribution' },
        h('h3', null, `Recent ${text(summary['result-label']) || 'linked results'}`),
        h('p', null, h('strong', null, quantity(summary['recent-result'])), ` ${text(summary['metric-unit'])} in 28 days · ${quantity(summary['previous-result'])} in the previous 28`)),
      h('button', { type: 'button', className: 'value-report-quality', onClick: reveal.bind(null, 'checks') }, 'Quality checks and evidence limits'));
    /** @param {string} id @param {string} title @param {HTMLElement} content */
    const section = (id, title, content) => h('section', { 'data-value-section': id, tabIndex: -1 }, h('h3', null, title), content);
    evidence.append(
      h('p', { className: 'muted' }, 'Linked measurements demonstrate a contribution, not exclusive causal credit or proof that every safeguard passed. Independent repository state includes everyone’s work.'),
      section('intent', 'Intent sources and acceptance requirements', h('div', null,
        h('ul', null, ...sources.map(row => h('li', null, evidenceLink(row.label, row.url)))),
        h('ul', null, ...requirements.map(row => h('li', null, text(row.label)))))),
      section('outputs', 'Retained safe outputs', h('div', null, evidenceTable(
        ['Output', 'Created', 'State at cutoff', 'Origin'],
        outputs.map(row => [evidenceLink(row.label, row.url), date(row.at), text(row.state), text(row.origin)]),
        'No retained output facts. Missing context is not an empty cohort.'),
        evidenceTable(['Output', 'Origin evidence'], origins.map(row => [
          evidenceLink(row['output-label'], row['output-url']), evidenceLink(row.label, row.url)
        ]), 'No producer evidence links were retained.'))),
      section('trails', 'Outputs → accepted implementations', evidenceTable(
        ['Safe output', 'Accepted implementation', 'Accepted', 'Native effect'],
        trails.map(row => [evidenceLink(row['output-label'], row['output-url']),
          evidenceLink(row['implementation-label'], row['implementation-url']), date(row['trail-accepted-at']), quantity(row['implementation-value'])]),
        'No accepted implementation trails were retained. Closed issues alone are not acceptance.')),
      section('files', 'Measured changes and Git evidence', evidenceTable(
        ['Implementation', 'Evidence', 'Observed relationship'],
        files.map(row => [evidenceLink(row['implementation-label'], row['implementation-url']), evidenceLink(row.label, row.url),
          row.at ? date(row.at) : 'Not applicable']),
        'Item-level implementation evidence was not retained.')),
      section('checks', 'Quality checks and limitations', h('div', null,
        checks.length ? h('ul', null, ...checks.map(row => h('li', null,
          h('strong', null, `${text(row.label)}: ${text(row.status)}`), ` — ${text(row.detail)}`)))
          : h('p', null, 'Quality checks were not retained; full acceptance is not verified.'),
        h('ul', null, ...limitations.map(row => h('li', null, text(row.detail) || text(row.label)))),
        h('p', null, text(summary['metric-formula'])),
        h('p', { className: 'muted' }, `Frozen metric ${text(summary['metric-id'])} · Version ${text(summary['metric-version'])} · ${text(summary['contract-digest'])}`))));
    root.append(evidence);
    return root;
  });
}

/** @param {Context} context */
export function renderWorkflowValueSnapshot(context) {
  return boundEvidence(context, ([snapshots, items]) => {
    const snapshot = snapshots[0];
    return h('article', { className: 'workflow-value-report' },
      h('a', { href: `#page-value-report?report=${encodeURIComponent(text(snapshot['report-id']))}` }, '← Value report'),
      h('h2', null, `Measured snapshot · ${date(snapshot.at)}`),
      h('p', null, h('strong', null, quantity(snapshot.value)), ' counted items at the retained revision.'),
      snapshot['items-available'] !== true
        ? h('p', { className: 'muted' }, 'Item-level evidence was not retained. The repository revision alone does not identify the measured population.')
        : items.length ? h('ul', { className: 'value-report-items' }, ...items.map(row =>
          h('li', null, evidenceLink(row.label, row.url))))
          : h('p', null, 'The retained item list is empty.'),
      h('p', null, evidenceLink('Full repository revision (context)', snapshot.url)));
  });
}

/** @param {string[]} headings @param {(string | HTMLElement)[][]} rows @param {string} empty */
function evidenceTable(headings, rows, empty) {
  if (!rows.length) return h('p', { className: 'muted' }, empty);
  return h('div', { className: 'value-report-table' }, h('table', null,
    h('thead', null, h('tr', null, ...headings.map(heading => h('th', { scope: 'col' }, heading)))),
    h('tbody', null, ...rows.map(row => h('tr', null, ...row.map(value => h('td', null, value)))))));
}

/** @param {Row[]} snapshots @param {string} direction */
function renderSnapshotPlot(snapshots, direction) {
  if (!snapshots.length) return renderVisualizationEmptyMessage('Independent repository state has not been measured.');
  const values = snapshots.map(row => Number(row.value));
  const low = Math.min(0, ...values), high = Math.max(1, ...values);
  const first = Date.parse(text(snapshots[0].at)), last = Date.parse(text(snapshots.at(-1)?.at));
  /** @param {Row} row */
  const x = row => first === last ? 250 : 32 + (Date.parse(text(row.at)) - first) / (last - first) * 436;
  /** @param {Row} row */
  const y = row => 44 + (high - Number(row.value)) / (high - low) * 88;
  const svg = h('svg', { viewBox: '0 0 500 180', role: 'group', 'aria-label': 'Independent measured snapshots' },
    h('title', null, 'Dashed lines guide the eye between measured observations, not continuous monitoring. Select a dot for its counted items.'),
    h('text', { x: first === last ? 32 : 250, y: 28, 'text-anchor': first === last ? 'start' : 'middle', class: 'value-snapshot-direction' }, direction));
  for (const [index, snapshot] of snapshots.entries()) {
    if (index) svg.append(h('line', { class: 'value-snapshot-guide', 'aria-hidden': 'true',
      x1: x(snapshots[index - 1]), y1: y(snapshots[index - 1]), x2: x(snapshot), y2: y(snapshot) }));
    const label = `${date(snapshot.at)}: ${quantity(snapshot.value)}. Inspect counted items.`;
    const anchor = svgAnchor({ href: text(snapshot['snapshot-href']), 'aria-label': label },
      h('title', null, label), h('circle', { cx: x(snapshot), cy: y(snapshot), r: 5 }));
    if (index === 0 || index === snapshots.length - 1) {
      anchor.append(h('text', { x: x(snapshot), y: y(snapshot) - 12, 'text-anchor': 'middle', class: 'value-snapshot-label' }, quantity(snapshot.value)),
        h('text', { x: x(snapshot), y: 157, 'text-anchor': first === last ? 'middle' : index === 0 ? 'start' : 'end', class: 'value-snapshot-date' },
          new Date(text(snapshot.at)).toLocaleDateString('en-US', { timeZone: 'UTC', year: 'numeric', month: 'short' })));
    }
    svg.append(anchor);
  }
  return h('div', { className: 'value-report-plot' }, svg, h('p', { className: 'muted' }, 'Dashed guide · Select measured dots'));
}
