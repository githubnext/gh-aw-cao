import { h } from '../dom.js';
import { octicon } from '../octicons.js';
import { isPlainObject, renderSectionHeading, createCopyControl } from './ui-primitives.js';

/** @type {Record<string, string>} */
const EXACT_EXPLANATIONS = {
  '$schema': 'Connects this file to the published policy schema for editor completion and validation.',
  version: 'Selects the policy contract version. Version 1 is currently required.',
  'control-plane': 'Defines what this control repository may discover, dispatch, and publish.',
  'control-plane.scope': 'Places the outer boundary on repositories the control plane may consider.',
  'control-plane.scope.allowed-owners': 'Limits discovery to these GitHub owners.',
  'control-plane.scope.allowed-repositories': 'Limits discovery to these exact owner/repository names.',
  'control-plane.inventory': 'Bounds deterministic repository discovery and partitions large inventories.',
  'control-plane.inventory.max-scan-repositories': 'Caps repositories inspected during discovery.',
  'control-plane.inventory.cell-count': 'Splits discovery into this many stable cells.',
  'control-plane.inventory.cell-index': 'Selects the zero-based discovery cell; it must be smaller than cell-count.',
  'control-plane.inventory.batch-size': 'Caps repositories processed in one inventory batch.',
  'control-plane.inventory.batch-index': 'Selects the zero-based inventory batch.',
  'control-plane.web': 'Configures presentation without granting operational authority.',
  'control-plane.web.favicon': 'Sets the dashboard favicon to a safe HTTPS URL or non-traversing local path.',
  'control-plane.defaults': 'Supplies inherited package limits when a package does not override them.',
  'control-plane.defaults.mode': 'Sets the inherited execution mode. Review proposes changes; live may write authorized outputs.',
  'control-plane.defaults.max-repositories': 'Caps repositories selected by each package.',
  'control-plane.defaults.rollout-percent': 'Deterministically limits the percentage of eligible repositories selected.',
  'control-plane.defaults.monthly-ai-credit-budget': 'Caps monthly AI Credits; zero disables budget-based tuning.',
  'control-plane.packages': 'Declares installed operation packages and their permitted behavior.',
  'control-plane.publishing': 'Controls optional publishing of reviewed operation issues.',
  'control-plane.publishing.enabled': 'Enables or disables reviewed operation publishing.',
  'control-plane.publishing.control-repositories': 'Lists repositories allowed to receive published operations.',
  'control-plane.publishing.reviewers': 'Lists GitHub users who may approve published operations.',
  'target-authority': 'Grants one control repository authority to run named packages live against this target.',
  'target-authority.packages': 'Maps package identifiers to their authorized control repositories.'
};

/** @param {string} path @param {unknown} value */
function explanation(path, value) {
  if (EXACT_EXPLANATIONS[path]) return EXACT_EXPLANATIONS[path];
  if (/^control-plane\.scope\.allowed-owners\.\d+$/.test(path)) return 'An owner included in the discovery boundary.';
  if (/^control-plane\.scope\.allowed-repositories\.\d+$/.test(path)) return 'An exact repository included in the discovery boundary.';
  if (/^control-plane\.publishing\.(control-repositories|reviewers)\.\d+$/.test(path)) return 'One explicitly allowed publishing destination or reviewer.';
  if (/^control-plane\.packages\.[^.]+$/.test(path)) return 'Configures one operation package; omitted limits inherit from control-plane.defaults.';
  if (/^control-plane\.packages\.[^.]+\.enabled$/.test(path)) return 'Controls whether this package may activate.';
  if (/^control-plane\.packages\.[^.]+\.mode$/.test(path)) return 'Sets this package to review-only proposals or authorized live output.';
  if (/^control-plane\.packages\.[^.]+\.(max-repositories|rollout-percent|monthly-ai-credit-budget)$/.test(path)) {
    return 'Overrides the matching control-plane default for this package.';
  }
  if (/^control-plane\.packages\.[^.]+\.icon$/.test(path)) return 'Selects the Octicon used to identify this package.';
  if (/^control-plane\.packages\.[^.]+\.targets$/.test(path)) return 'Defines exact repository mode overrides without widening global scope.';
  if (/^control-plane\.packages\.[^.]+\.targets\.[^.]+\/[^.]+$/.test(path)) return 'Overrides policy for this exact target repository.';
  if (/^control-plane\.packages\.[^.]+\.targets\.[^.]+\/[^.]+\.mode$/.test(path)) return 'Narrows or promotes this exact target between review and live mode.';
  if (/^control-plane\.packages\.[^.]+\.workers$/.test(path)) return 'Declares the workers this package may dispatch.';
  if (/^control-plane\.packages\.[^.]+\.workers\.[^.]+$/.test(path)) return 'Configures one package worker.';
  if (/^control-plane\.packages\.[^.]+\.workers\.[^.]+\.workflow$/.test(path)) return 'Names the exact installed workflow slug for this worker.';
  if (/^control-plane\.packages\.[^.]+\.workers\.[^.]+\.enabled$/.test(path)) return 'Controls whether this worker may be dispatched.';
  if (/^control-plane\.packages\.[^.]+\.workers\.[^.]+\.max-mode$/.test(path)) return 'Places a ceiling on this worker so it cannot run in a broader mode.';
  if (/^target-authority\.packages\.[^.]+$/.test(path)) return 'Declares target-owned authority for one package.';
  if (/^target-authority\.packages\.[^.]+\.authority$/.test(path)) return 'Names the only control repository authorized for this package.';
  if (/^\$/.test(path)) return 'Policy document root.';
  return isPlainObject(value) || Array.isArray(value)
    ? 'Groups the policy entries shown below.'
    : 'This entry is not recognized by the current policy vocabulary; validation should be reviewed.';
}

/** @param {unknown} value */
function valueLabel(value) {
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? '' : 's'}`;
  if (isPlainObject(value)) return `${Object.keys(value).length} entr${Object.keys(value).length === 1 ? 'y' : 'ies'}`;
  return JSON.stringify(value);
}

/** @param {string} name @param {unknown} value @param {string} path @param {number} [depth] */
function renderEntry(name, value, path, depth = 0) {
  const children = Array.isArray(value)
    ? value.map((item, index) => [
        ['string', 'number', 'boolean'].includes(typeof item) ? String(item) : String(index),
        item,
        String(index)
      ])
    : isPlainObject(value) ? Object.entries(value).map(([childName, childValue]) => [childName, childValue, childName]) : [];
  const content = [
    h('div', { className: 'configuration-entry-heading' },
      h('code', null, name),
      h('span', { className: 'configuration-entry-value' }, valueLabel(value))),
    h('p', null, explanation(path, value))
  ];
  if (children.length > 0) {
    content.push(h('div', { className: 'configuration-entry-children' },
      ...children.map(([childName, childValue, pathSegment]) => renderEntry(
        childName,
        childValue,
        path === '$' ? pathSegment : `${path}.${pathSegment}`,
        depth + 1
      ))));
  }
  return h(
    children.length > 0 ? 'details' : 'div',
    {
      className: 'configuration-entry',
      style: `--configuration-depth: ${depth}`,
      ...(children.length > 0 ? { open: true } : {})
    },
    ...(children.length > 0 ? [h('summary', null, ...content.slice(0, 2)), ...content.slice(2)] : content)
  );
}

/** @param {Array<Record<string, unknown>>} diagnostics */
function renderDiagnostics(diagnostics) {
  return h('section', { className: 'configuration-diagnostics', 'aria-label': 'Policy diagnostics' },
    ...diagnostics.map((diagnostic) => h(
      'article',
      { className: `configuration-diagnostic configuration-diagnostic-${diagnostic.severity}` },
      octicon(diagnostic.severity === 'error' ? 'x-circle' : diagnostic.severity === 'valid' ? 'check-circle' : 'alert'),
      h('div', null,
        h('strong', null, String(diagnostic.title ?? 'Policy diagnostic')),
        h('code', null, String(diagnostic.path ?? '')),
        h('p', null, String(diagnostic.detail ?? '')))
    )));
}

/** @param {string} raw */
function renderRawPolicy(raw) {
  const { button: copyButton, status: copyStatus } = createCopyControl({
    getContent: () => raw,
    label: 'Copy JSON',
    buttonClassName: 'configuration-copy-button',
    statusClassName: 'configuration-copy-status'
  });
  return h('details', { className: 'configuration-raw' },
    h('summary', null, 'Raw JSON'),
    h('div', { className: 'configuration-raw-actions' }, copyButton, copyStatus),
    h('pre', null, h('code', null, raw || 'Raw policy is unavailable.')));
}

/** @param {import('./ui-elements.js').ElementRenderContext} context */
export function renderConfigurationView(context) {
  const row = context.sources['configuration-policy']?.rows?.[0];
  if (!row) return null;
  const policyDocument = row.document;
  const diagnostics = Array.isArray(row.diagnostics) ? row.diagnostics.filter(isPlainObject) : [];
  const headingId = `${context.pageId}-configuration-heading`;
  return h('section', { className: 'configuration-view', 'aria-labelledby': headingId },
    renderSectionHeading({
      kicker: 'Policy source of truth',
      id: headingId,
      title: context.title,
      description: context.description,
      headingTag: 'h2'
    }),
    renderDiagnostics(diagnostics),
    isPlainObject(policyDocument)
      ? h('details', { className: 'configuration-entries' },
          h('summary', null, 'Explained entries'),
          renderEntry('.github/workflows/cao.json', policyDocument, '$'))
      : h('p', { className: 'configuration-unavailable' }, 'The policy cannot be explained until it contains valid JSON.'),
    renderRawPolicy(String(row.raw ?? ''))
  );
}
