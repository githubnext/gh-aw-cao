import { h } from '../dom.js';
import { collectFullDiagnostics } from '../diagnostics.js';
import { copyTextToClipboard } from './ui-primitives.js';
import { isPlainObject, renderLazyDisclosure, renderSectionHeading } from './ui-primitives.js';
import {
  automaticDashboardDataUpdatesEnabled,
  setAutomaticDashboardDataUpdatesEnabled
} from '../dashboard-data-updates.js';

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
  'control-plane.defaults.monthly-ai-credit-budget': 'Deprecated compatibility field; it no longer gates monthly AI Credit usage.',
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

/**
 * @param {string} name
 * @param {unknown} value
 * @param {string} path
 * @param {string[]} segments
 * @param {(segments: string[], value: unknown) => void} onChange
 * @param {number} [depth]
 * @returns {HTMLElement}
 */
function renderEntry(name, value, path, segments, onChange, depth = 0) {
  if (isPlainObject(value)) {
    const children = h('div', { className: 'configuration-setting-children' });
    return renderLazyDisclosure(
      'configuration-setting-group',
      [h('span', null, settingLabel(name)), h('small', null, valueLabel(value))],
      children,
      (container) => container.replaceChildren(
        ...Object.entries(value).map(([childName, childValue]) => renderEntry(
          childName,
          childValue,
          `${path}.${childName}`,
          [...segments, childName],
          onChange,
          depth + 1
        ))
      ),
      { open: depth < 2, eagerContent: h('p', { className: 'configuration-setting-description' }, explanation(path, value)) }
    );
  }

  const control = renderSettingControl(name, value, path, (nextValue) => onChange(segments, nextValue));
  return h('div', { className: 'configuration-setting-row' },
    h('div', { className: 'configuration-setting-copy' },
      h('label', { htmlFor: control.id }, settingLabel(name)),
      h('code', null, path),
      h('p', null, explanation(path, value))
    ),
    control
  );
}

/** @param {string} name */
function settingLabel(name) {
  if (name === '$schema') return 'Schema';
  return name.replaceAll('-', ' ').replace(/(^|\s)\S/g, (letter) => letter.toUpperCase());
}

/** @param {string} name @param {unknown} value @param {string} path @param {(value: unknown) => void} onChange */
function renderSettingControl(name, value, path, onChange) {
  const id = `configuration-${path.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase()}`;
  if (typeof value === 'boolean') {
    return /** @type {HTMLInputElement} */ (h('input', {
      id,
      className: 'configuration-setting-toggle',
      type: 'checkbox',
      checked: value,
      onChange: /** @param {Event} event */ (event) => onChange(/** @type {HTMLInputElement} */ (event.currentTarget).checked)
    }));
  }
  if (Array.isArray(value)) {
    if (!value.every((item) => typeof item === 'string')) {
      return /** @type {HTMLTextAreaElement} */ (h('textarea', {
        id,
        className: 'configuration-setting-list configuration-setting-json',
        rows: Math.min(12, Math.max(4, value.length + 2)),
        value: JSON.stringify(value, null, 2),
        onInput: /** @param {Event} event */ (event) => {
          const input = /** @type {HTMLTextAreaElement} */ (event.currentTarget);
          try {
            const parsed = JSON.parse(input.value);
            if (Array.isArray(parsed)) onChange(parsed);
          } catch {
            // Keep the last valid typed array while the JSON edit is incomplete.
          }
        }
      }));
    }
    return /** @type {HTMLTextAreaElement} */ (h('textarea', {
      id,
      className: 'configuration-setting-list',
      rows: Math.min(8, Math.max(3, value.length)),
      value: value.map(String).join('\n'),
      onInput: /** @param {Event} event */ (event) => onChange(
        /** @type {HTMLTextAreaElement} */ (event.currentTarget).value.split('\n').map((item) => item.trim()).filter(Boolean)
      )
    }));
  }
  if (name === 'mode' || name === 'max-mode') {
    return /** @type {HTMLSelectElement} */ (h('select', {
      id,
      value: String(value),
      onChange: /** @param {Event} event */ (event) => onChange(/** @type {HTMLSelectElement} */ (event.currentTarget).value)
    },
    h('option', { value: 'review' }, 'Review'),
    h('option', { value: 'live' }, 'Live')));
  }
  return /** @type {HTMLInputElement} */ (h('input', {
    id,
    type: typeof value === 'number' ? 'number' : 'text',
    value: String(value ?? ''),
    ...(typeof value === 'number' ? { min: 0 } : {}),
    onInput: /** @param {Event} event */ (event) => {
      const input = /** @type {HTMLInputElement} */ (event.currentTarget);
      if (typeof value !== 'number') onChange(input.value);
      else if (input.value !== '' && Number.isFinite(input.valueAsNumber)) onChange(input.valueAsNumber);
    }
  }));
}

/** @param {Record<string, unknown>} document @param {string[]} segments @param {unknown} value */
function setDocumentValue(document, segments, value) {
  let parent = document;
  for (const segment of segments.slice(0, -1)) {
    const child = parent[segment];
    if (!isPlainObject(child)) return;
    parent = child;
  }
  parent[segments.at(-1) ?? ''] = value;
}

/** @param {Record<string, unknown>} value */
function cloneDocument(value) {
  return /** @type {Record<string, unknown>} */ (JSON.parse(JSON.stringify(value)));
}

/** @param {Record<string, unknown>} policyDocument */
function renderSettingsEditor(policyDocument) {
  const original = cloneDocument(policyDocument);
  let draft = cloneDocument(policyDocument);
  const status = /** @type {HTMLOutputElement} */ (h('output', {
    className: 'configuration-edit-status',
    'aria-live': 'polite'
  }, 'No changes'));
  const settings = h('div', { className: 'configuration-settings' });
  const updateStatus = () => {
    const modified = JSON.stringify(draft) !== JSON.stringify(original);
    status.textContent = modified ? 'Modified locally' : 'No changes';
    status.setAttribute('data-state', modified ? 'modified' : 'clean');
  };
  /** @param {string[]} segments @param {unknown} value */
  const updateValue = (segments, value) => {
    setDocumentValue(draft, segments, value);
    updateStatus();
  };
  const renderSettings = () => settings.replaceChildren(
    ...Object.entries(draft).map(([name, value]) => renderEntry(name, value, name, [name], updateValue))
  );
  const resetButton = h('button', {
    type: 'button',
    className: 'configuration-reset-button',
    onClick: () => {
      draft = cloneDocument(original);
      renderSettings();
      updateStatus();
    }
  }, 'Discard changes');
  const diagnosticsStatus = /** @type {HTMLOutputElement} */ (h('output', {
    className: 'configuration-copy-status',
    'aria-live': 'polite'
  }));
  const diagnosticsButton = /** @type {HTMLButtonElement} */ (h('button', {
    type: 'button',
    className: 'configuration-diagnostics-button',
    onClick: async () => {
      diagnosticsButton.disabled = true;
      diagnosticsStatus.textContent = 'Collecting diagnostics…';
      try {
        const report = await collectFullDiagnostics();
        const copied = await copyTextToClipboard(JSON.stringify(report, null, 2));
        diagnosticsStatus.textContent = copied ? 'Diagnostics copied.' : 'Diagnostics collected; copy unavailable.';
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        diagnosticsStatus.textContent = `Unable to collect diagnostics: ${message}`;
      } finally {
        diagnosticsButton.disabled = false;
      }
    }
  }, 'Collect diagnostics'));
  renderSettings();
  updateStatus();

  return h('div', { className: 'configuration-editor' },
    h('div', { className: 'configuration-editor-toolbar' },
      h('div', null,
        h('strong', null, '.github/workflows/cao.json'),
        status
      ),
      h('div', { className: 'configuration-editor-actions' },
        diagnosticsButton,
        diagnosticsStatus,
        resetButton
      )
    ),
    settings,
    h('p', { className: 'configuration-save-note' },
      'Edits stay in this browser and do not change the policy.'
    )
  );
}

function renderAutomaticDataUpdatesSetting() {
  const checkbox = /** @type {HTMLInputElement} */ (h('input', {
    id: 'configuration-automatic-dashboard-data-updates',
    className: 'configuration-setting-toggle',
    type: 'checkbox',
    checked: automaticDashboardDataUpdatesEnabled(),
    onChange: /** @param {Event} event */ (event) => {
      setAutomaticDashboardDataUpdatesEnabled(
        /** @type {HTMLInputElement} */ (event.currentTarget).checked
      );
      status.textContent = checkbox.checked
        ? 'On. Downloads pause automatically on low battery or metered connections.'
        : 'Off. Dashboard data updates only while the dashboard is open.';
    }
  }));
  const status = h('p', { className: 'configuration-browser-setting-status', 'aria-live': 'polite' },
    checkbox.checked
      ? 'On. Downloads pause automatically on low battery or metered connections.'
      : 'Off. Dashboard data updates only while the dashboard is open.'
  );
  return h('section', { className: 'configuration-browser-settings', 'aria-labelledby': 'configuration-browser-settings-heading' },
    h('div', { className: 'configuration-browser-settings-heading' },
      h('div', null,
        h('h3', { id: 'configuration-browser-settings-heading' }, 'Dashboard data'),
        h('p', null, 'Browser preferences apply only to this device.')
      )
    ),
    h('div', { className: 'configuration-setting-row' },
      h('div', { className: 'configuration-setting-copy' },
        h('label', { htmlFor: checkbox.id }, 'Download updated data every hour'),
        h('p', null, 'While the dashboard is open, uses a service worker to download fresh data. It is off by default.')
      ),
      checkbox
    ),
    status
  );
}

/** @param {import('./ui-elements.js').ElementRenderContext} context */
export function renderConfigurationView(context) {
  const row = context.sources['configuration-policy']?.rows?.[0];
  if (!row) return null;
  const policyDocument = row.document;
  const headingId = `${context.pageId}-configuration-heading`;
  return h('section', { className: 'configuration-view', 'aria-labelledby': headingId },
    renderSectionHeading({
      kicker: 'Policy source of truth',
      id: headingId,
      title: context.title,
      description: context.description,
      headingTag: 'h2'
    }),
    renderAutomaticDataUpdatesSetting(),
    isPlainObject(policyDocument)
      ? renderSettingsEditor(policyDocument)
      : h('p', { className: 'configuration-unavailable' }, 'The policy cannot be edited until it contains valid JSON.')
  );
}
