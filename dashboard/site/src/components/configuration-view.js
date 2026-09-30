import { h } from '../dom.js';
import { renderThemeControl } from './theme-settings.js';
import { collectFullDiagnostics } from '../diagnostics.js';
import { capturedConsoleLogText } from '../console-log-capture.js';
import { createDebug, fullDebugUrl } from '../debug.js';
import { copyTextToClipboard, createCopyControl, renderCheckbox } from './ui-primitives.js';
import { errorMessage } from './count-formatters.js';
import { isPlainObject, renderLazyDisclosure, renderLiveRegion, renderSectionHeading } from './ui-primitives.js';
import { renderSettingsCliActions } from './cli-actions.js';
import { createFactoryScope } from './factory-elements.js';
import { renderResetDashboardControl } from './reset-dashboard-control.js';
import { effect, state } from '../reactive.js';
import {
  automaticDashboardBackgroundUpdatesActive,
  automaticDashboardDataUpdatesEnabled,
  dashboardBackgroundUpdatesUnavailableReason,
  dashboardInstalled,
  onAutomaticDashboardBackgroundUpdateStatus,
  setAutomaticDashboardDataUpdatesEnabled
} from '../dashboard-data-updates.js';

const debugConfigurationView = createDebug('configuration-view');

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
  'control-plane.web.experimental': 'Shows dashboard views marked as experimental.',
  'control-plane.web.favicon': 'Sets the dashboard favicon to a safe HTTPS URL or non-traversing local path.',
  'control-plane.defaults': 'Supplies inherited campaign limits when a campaign does not override them.',
  'control-plane.defaults.mode': 'Sets the inherited execution mode. Review proposes changes; live may write authorized outputs.',
  'control-plane.defaults.max-repositories': 'Caps repositories selected by each campaign.',
  'control-plane.defaults.rollout-percent': 'Deterministically limits the percentage of eligible repositories selected.',
  'control-plane.defaults.monthly-ai-credit-budget': 'Deprecated compatibility field; it no longer gates monthly AI Credit usage.',
  'control-plane.campaigns': 'Declares installed operation campaigns and their permitted behavior.',
  'control-plane.publishing': 'Controls optional publishing of reviewed operation issues.',
  'control-plane.publishing.enabled': 'Enables or disables reviewed operation publishing.',
  'control-plane.publishing.control-repositories': 'Lists repositories allowed to receive published operations.',
  'control-plane.publishing.reviewers': 'Lists GitHub users who may approve published operations.',
  'target-authority': 'Grants one control repository authority to run named campaigns live against this target.',
  'target-authority.campaigns': 'Maps campaign identifiers to their authorized control repositories.'
};

/** @param {string} path @param {unknown} value */
function explanation(path, value) {
  if (EXACT_EXPLANATIONS[path]) return EXACT_EXPLANATIONS[path];
  if (/^control-plane\.scope\.allowed-owners\.\d+$/.test(path)) return 'An owner included in the discovery boundary.';
  if (/^control-plane\.scope\.allowed-repositories\.\d+$/.test(path)) return 'An exact repository included in the discovery boundary.';
  if (/^control-plane\.publishing\.(control-repositories|reviewers)\.\d+$/.test(path)) return 'One explicitly allowed publishing destination or reviewer.';
  if (/^control-plane\.campaigns\.[^.]+$/.test(path)) return 'Configures one operation campaign; omitted limits inherit from control-plane.defaults.';
  if (/^control-plane\.campaigns\.[^.]+\.enabled$/.test(path)) return 'Controls whether this campaign may activate.';
  if (/^control-plane\.campaigns\.[^.]+\.mode$/.test(path)) return 'Sets this campaign to review-only proposals or authorized live output.';
  if (/^control-plane\.campaigns\.[^.]+\.(max-repositories|rollout-percent|monthly-ai-credit-budget)$/.test(path)) {
    return 'Overrides the matching control-plane default for this campaign.';
  }
  if (/^control-plane\.campaigns\.[^.]+\.icon$/.test(path)) return 'Selects the Octicon used to identify this campaign.';
  if (/^control-plane\.campaigns\.[^.]+\.targets$/.test(path)) return 'Defines exact repository mode overrides without widening global scope.';
  if (/^control-plane\.campaigns\.[^.]+\.targets\.[^.]+\/[^.]+$/.test(path)) return 'Overrides policy for this exact target repository.';
  if (/^control-plane\.campaigns\.[^.]+\.targets\.[^.]+\/[^.]+\.mode$/.test(path)) return 'Narrows or promotes this exact target between review and live mode.';
  if (/^control-plane\.campaigns\.[^.]+\.workers$/.test(path)) return 'Declares the workers this campaign may dispatch.';
  if (/^control-plane\.campaigns\.[^.]+\.workers\.[^.]+$/.test(path)) return 'Configures one campaign worker.';
  if (/^control-plane\.campaigns\.[^.]+\.workers\.[^.]+\.workflow$/.test(path)) return 'Names the exact installed workflow slug for this worker.';
  if (/^control-plane\.campaigns\.[^.]+\.workers\.[^.]+\.enabled$/.test(path)) return 'Controls whether this worker may be dispatched.';
  if (/^control-plane\.campaigns\.[^.]+\.workers\.[^.]+\.max-mode$/.test(path)) return 'Places a ceiling on this worker so it cannot run in a broader mode.';
  if (/^target-authority\.campaigns\.[^.]+$/.test(path)) return 'Declares target-owned authority for one campaign.';
  if (/^target-authority\.campaigns\.[^.]+\.authority$/.test(path)) return 'Names the only control repository authorized for this campaign.';
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
  return renderConfigurationSettingRow(
    {
      label: h('label', { htmlFor: control.id }, settingLabel(name)),
      description: h('div', null, h('code', null, path), h('p', null, explanation(path, value)))
    },
    control
  );
}

/**
 * Renders the shared "label/description copy beside a control" row used by
 * the policy setting editor and the browser data/debugging settings
 * sections, which otherwise duplicated the same `configuration-setting-row`
 * / `configuration-setting-copy` markup with only the copy content and
 * control differing.
 * @param {{ label: HTMLElement, description?: HTMLElement | null }} copy
 * @param {HTMLElement} control
 * @returns {HTMLElement}
 */
function renderConfigurationSettingRow(copy, control) {
  return h('div', { className: 'configuration-setting-row' },
    h('div', { className: 'configuration-setting-copy' }, copy.label, copy.description),
    control
  );
}

/**
 * Renders the shared `configuration-browser-settings-heading` block used by
 * the browser data-updates and debugging settings sections, which otherwise
 * duplicated the same heading `<div>`/`<h3>`/`<p>` markup with only the
 * heading id, title, and description differing.
 * @param {string} headingId
 * @param {string} title
 * @param {string} description
 * @returns {HTMLElement}
 */
function renderConfigurationSectionHeading(headingId, title, description) {
  return h('div', { className: 'configuration-browser-settings-heading' },
    h('div', null,
      h('h3', { id: headingId }, title),
      h('p', null, description)
    )
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

/** @param {Record<string, unknown> | undefined} row */
function policyDocumentFromRow(row) {
  if (isPlainObject(row?.document)) return structuredClone(row.document);
  if (typeof row?.raw !== 'string') return null;
  try {
    const document = JSON.parse(row.raw);
    return isPlainObject(document) ? document : null;
  } catch {
    return null;
  }
}

/** @param {Record<string, unknown>} policyDocument */
function renderSettingsEditor(policyDocument) {
  const original = cloneDocument(policyDocument);
  const draft = state(cloneDocument(policyDocument));
  const status = /** @type {HTMLOutputElement} */ (h('output', {
    className: 'configuration-edit-status',
    'aria-live': 'polite'
  }));
  const settings = h('div', { className: 'configuration-settings' });
  const copyControl = createCopyControl({
    getContent: () => JSON.stringify(draft.get(), null, 2),
    label: 'Copy updated JSON',
    buttonClassName: 'configuration-copy-button',
    statusClassName: 'configuration-copy-status',
    successText: 'Updated JSON copied.'
  });
  /** @param {string[]} segments @param {unknown} value */
  const updateValue = (segments, value) => {
    draft.set((current) => {
      const next = cloneDocument(current);
      setDocumentValue(next, segments, value);
      return next;
    });
  };
  const resetButton = h('button', {
    type: 'button',
    className: 'configuration-reset-button',
    onClick: () => draft.set(cloneDocument(original))
  }, 'Discard changes');
  const diagnosticsStatus = /** @type {HTMLOutputElement} */ (renderLiveRegion('output', 'configuration-copy-status'));
  const diagnosticsButton = /** @type {HTMLButtonElement} */ (h('button', {
    type: 'button',
    className: 'configuration-diagnostics-button',
    onClick: async () => {
      diagnosticsButton.disabled = true;
      diagnosticsStatus.textContent = 'Collecting diagnostics…';
      debugConfigurationView('diagnostics collection started');
      const startedAt = Date.now();
      try {
        const report = await collectFullDiagnostics();
        const copied = await copyTextToClipboard(JSON.stringify(report, null, 2));
        diagnosticsStatus.textContent = copied ? 'Diagnostics copied.' : 'Diagnostics collected; copy unavailable.';
        debugConfigurationView('diagnostics collection finished', { status: 'success', copied, durationMs: Date.now() - startedAt });
      } catch (error) {
        const message = errorMessage(error);
        diagnosticsStatus.textContent = `Unable to collect diagnostics: ${message}`;
        debugConfigurationView('diagnostics collection finished', {
          status: 'error',
          errorName: error instanceof Error ? error.name : 'Error',
          durationMs: Date.now() - startedAt
        });
      } finally {
        diagnosticsButton.disabled = false;
      }
    }
  }, 'Collect diagnostics'));

  const scope = createFactoryScope();
  let lastModified = false;
  effect(() => {
    const currentDraft = draft.get();
    const modified = JSON.stringify(currentDraft) !== JSON.stringify(original);
    copyControl.reset();
    status.textContent = modified ? 'Modified locally' : 'No changes';
    status.setAttribute('data-state', modified ? 'modified' : 'clean');
    settings.replaceChildren(
      ...Object.entries(currentDraft).map(([name, value]) => renderEntry(name, value, name, [name], updateValue))
    );
    if (modified !== lastModified) {
      debugConfigurationView('settings draft state changed', { modified });
      lastModified = modified;
    }
  }, { signal: scope.signal });

  const root = h('div', { className: 'configuration-editor' },
    h('div', { className: 'configuration-editor-toolbar' },
      h('div', null,
        h('strong', null, '.github/workflows/cao.json'),
        status
      ),
      h('div', { className: 'configuration-editor-actions' },
        copyControl.button,
        copyControl.status,
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
  scope.bind(root);
  return root;
}

function renderAutomaticDataUpdatesSetting() {
  const unavailableReason = dashboardBackgroundUpdatesUnavailableReason();
  const statusText = () => {
    if (unavailableReason) return unavailableReason;
    if (!automaticDashboardDataUpdatesEnabled()) {
      return 'Off. Dashboard data updates only while the dashboard is open.';
    }
    if (!automaticDashboardBackgroundUpdatesActive()) {
      return 'Turning on. Waiting for this browser to grant and verify background updates.';
    }
    return 'On. Hourly downloads continue after the dashboard is closed and pause on metered connections or unsuitable power conditions.';
  };
  const scope = createFactoryScope();
  const enabled = state(automaticDashboardDataUpdatesEnabled());
  const checkbox = renderCheckbox({
    id: 'configuration-automatic-dashboard-data-updates',
    className: 'configuration-setting-toggle',
    checked: enabled.get(),
    disabled: Boolean(unavailableReason),
    onChange: /** @param {Event} event */ (event) => {
      const checked = /** @type {HTMLInputElement} */ (event.currentTarget).checked;
      setAutomaticDashboardDataUpdatesEnabled(checked);
      enabled.set(checked);
    }
  });
  const status = h('p', { className: 'configuration-browser-setting-status', 'aria-live': 'polite' });
  checkbox.setAttribute('aria-describedby', 'configuration-automatic-dashboard-data-updates-status');
  status.id = 'configuration-automatic-dashboard-data-updates-status';
  const section = h('section', { className: 'configuration-browser-settings', 'aria-labelledby': 'configuration-browser-settings-heading' },
    renderConfigurationSectionHeading('configuration-browser-settings-heading', 'Dashboard data', 'Browser preferences apply only to this device.'),
    renderConfigurationSettingRow(
      {
        label: h('label', { htmlFor: checkbox.id }, 'Download updated data every hour'),
        description: h('p', null, 'Uses Periodic Background Sync so downloads continue after the dashboard closes. This requires an installed dashboard app and browser support. It is off by default.')
      },
      checkbox
    ),
    status
  );
  // The smallest DOM update needed from the enabled state: resync the checkbox
  // and status text whenever this setting or its background-update status changes.
  effect(() => {
    checkbox.checked = enabled.get();
    status.textContent = statusText();
  }, { signal: scope.signal });
  const stopStatusUpdates = onAutomaticDashboardBackgroundUpdateStatus(() => {
    enabled.set(automaticDashboardDataUpdatesEnabled());
  });
  scope.signal.addEventListener('abort', stopStatusUpdates, { once: true });
  scope.bind(section);
  return section;
}

function renderAppearanceSetting() {
  return h('section', { className: 'configuration-browser-settings', 'aria-labelledby': 'configuration-appearance-heading' },
    renderConfigurationSectionHeading('configuration-appearance-heading', 'Appearance', 'Choose how this dashboard looks.'),
    renderConfigurationSettingRow(
      {
        label: h('span', { className: 'configuration-setting-label' }, 'Theme'),
        description: h('p', null, 'Follow your system setting or choose a theme for this browser.')
      },
      renderThemeControl()
    )
  );
}

function renderDebuggingSettings() {
  if (dashboardInstalled()) return null;

  const copyControl = createCopyControl({
    getContent: capturedConsoleLogText,
    label: 'Copy console logs',
    buttonClassName: 'configuration-transactions-button',
    statusClassName: 'configuration-copy-status',
    successText: 'Console logs copied.',
    failureText: 'Console logs could not be copied.',
    trackState: true
  });
  return h('section', { className: 'configuration-browser-settings configuration-debug-settings', 'aria-labelledby': 'configuration-debug-heading' },
    renderConfigurationSectionHeading('configuration-debug-heading', 'Debugging', 'Collect diagnostic information to share when troubleshooting this dashboard.'),
    renderConfigurationSettingRow(
      {
        label: h('label', null, 'Enable full debugging'),
        description: h('p', null, 'Relaunches this page with all dashboard debug categories enabled.')
      },
      h('a', { href: fullDebugUrl(), className: 'configuration-transactions-button' }, 'Relaunch with debugging')
    ),
    renderConfigurationSettingRow(
      {
        label: h('label', null, 'Console logs'),
        description: h('p', null, 'Copies console output captured since this page was loaded.')
      },
      h('div', { className: 'configuration-debug-copy' }, copyControl.button, copyControl.status)
    )
  );
}

function renderLocalDataActions() {
  return h('div', { className: 'configuration-local-data-actions' },
    renderResetDashboardControl()
  );
}

/** @param {import('./ui-elements.js').ElementRenderContext} context */
export function renderConfigurationView(context) {
  const row = context.sources['configuration-policy']?.rows?.[0];
  const policyDocument = policyDocumentFromRow(row);
  const headingId = `${context.pageId}-configuration-heading`;
  return h('section', { className: 'configuration-view', 'aria-labelledby': headingId },
    renderSectionHeading({
      kicker: 'Policy source of truth',
      id: headingId,
      title: context.title,
      description: context.description,
      headingTag: 'h2'
    }),
    renderLocalDataActions(),
    renderSettingsCliActions(),
    renderAppearanceSetting(),
    renderAutomaticDataUpdatesSetting(),
    isPlainObject(policyDocument)
      ? renderSettingsEditor(policyDocument)
      : h('p', { className: 'configuration-unavailable' }, 'The policy cannot be edited until it contains valid JSON.'),
    renderDebuggingSettings()
  );
}
