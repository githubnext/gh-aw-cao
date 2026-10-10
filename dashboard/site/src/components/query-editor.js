import { h } from '../dom.js';
import { state, effect, batch } from '../reactive.js';
import { createFactoryScope } from './factory-elements.js';
import { createCopyControl } from './ui-primitives.js';
import { publishNotification } from '../notification-service.js';
import { loadCanonicalDashboardPage, subscribeCanonicalDashboardView, validateQueryEditorDocument } from '../data-processor.js';
import { renderDashboardPagePreview } from '../presenter.js';
import { octicon } from '../octicons.js';

let nextEditorId = 0;

/**
 * The editor owns interaction only. Documents and evidence are validated and
 * evaluated by the worker; the shared presenter owns preview DOM.
 * @param {import('./ui-elements.js').ElementRenderContext} context
 */
export function renderQueryEditor(context) {
  if (new URLSearchParams(globalThis.location?.search ?? '').get('local-preview') !== 'canvas') {
    return h('p', { role: 'status' }, 'The query editor is available only in a Copilot canvas.');
  }
  const id = `query-editor-${++nextEditorId}`;
  const scope = createFactoryScope();
  const busy = state(false);
  const message = state('Describe the result you want, then generate a query and view.');
  const diagnostics = state('');
  const acceptedDraft = state('');
  const preview = h('div', { className: 'query-editor-preview', 'aria-label': 'Query preview' });
  /** @type {AbortController | null} */
  let operation = null;
  /** @type {AbortController | null} */
  let previewLifetime = null;
  let previewRevision = 0;

  /** @param {'intent'|'subject'|'objective'|'acceptance'} name @param {string} label @param {number} maximum @param {boolean} [required] */
  const field = (name, label, maximum, required = true) => {
    const input = /** @type {HTMLTextAreaElement} */ (h('textarea', {
      id: `${id}-${name}`, name, rows: name === 'intent' ? 3 : 2, maxLength: maximum, required
    }));
    return { input, root: h('div', { className: 'query-editor-field' },
      h('label', { htmlFor: input.id }, label), input) };
  };
  const intent = field('intent', 'Intent', 8000);
  const subject = field('subject', 'Subject', 2000);
  const objective = field('objective', 'Objective (optional)', 4000, false);
  const acceptance = field('acceptance', 'Acceptance criteria', 4000);
  const authoringContext = () => ({
    intent: intent.input.value, subject: subject.input.value,
    objective: objective.input.value, acceptance: acceptance.input.value
  });
  const document = /** @type {HTMLTextAreaElement} */ (h('textarea', {
    id: `${id}-document`, className: 'query-editor-document', rows: 16,
    maxLength: 131072, spellcheck: false, 'aria-label': 'Dashboard Language document',
    onInput: () => acceptedDraft.set('')
  }));

  const cancel = /** @type {HTMLButtonElement} */ (h('button', {
    type: 'button', className: 'button', onClick: () => operation?.abort()
  }, 'Cancel'));
  const generate = /** @type {HTMLButtonElement} */ (h('button', {
    type: 'submit', className: 'button button-primary'
  }, 'Generate query and view'));
  const improve = /** @type {HTMLButtonElement} */ (h('button', {
    type: 'button', className: 'button', 'aria-label': 'Improve all fields with Copilot',
    onClick: () => enhanceIntent()
  }, octicon('sparkle'), 'Improve all fields'));
  const apply = /** @type {HTMLButtonElement} */ (h('button', {
    type: 'button', className: 'button', onClick: () => run(false)
  }, 'Validate and render'));
  const save = /** @type {HTMLButtonElement} */ (h('button', {
    type: 'button', className: 'button button-primary', onClick: () => saveView()
  }, octicon('bookmark'), 'Save as custom view'));
  const copy = createCopyControl({
    label: 'Copy Dashboard Language', getContent: () => document.value,
    buttonClassName: 'button', statusClassName: 'query-editor-copy-status'
  });

  /**
   * @param {import('../data/query-editor.js').QueryEditorValidation & { ok: true }} result
   * @param {AbortSignal} signal
   */
  const accept = async (result, signal) => {
    const dashboard = result.document.dashboard;
    const pageDefinition = dashboard.pages[0];
    if (pageDefinition.kind !== 'custom') throw new Error('The preview must contain a custom page.');
    const queryContext = {
      githubUrlBase: dashboard['github-url-base'],
      dashboardRepository: dashboard.repository ?? null,
      pages: dashboard.pages,
      queries: dashboard.queries ?? [],
    };
    const sources = await loadCanonicalDashboardPage(result.sourceNames, queryContext, undefined, {
      pageId: result.pageId, signal
    });
    signal.throwIfAborted();
    const lifetime = new AbortController();
    scope.signal.addEventListener('abort', () => lifetime.abort(), { once: true, signal: lifetime.signal });
    const binding = {
      sources: state(sources),
      failures: state(/** @type {Record<string, string>} */ ({})),
      loading: state(false),
      signal: lifetime.signal,
    };
    const subscriptionId = `${id}-preview-${++previewRevision}`;
    /** @type {AbortController | null} */
    let renderingLifetime = null;
    /** @type {() => void} */
    let unsubscribe = () => {};
    /** @type {import('../data/queries/view-payload-compiler.js').GlobalQueryContext | undefined} */
    let interaction;
    const subscribe = () => {
      unsubscribe();
      unsubscribe = subscribeCanonicalDashboardView(subscriptionId, result.sourceNames, queryContext, (fresh) => {
        if (lifetime.signal.aborted) return;
        batch(() => {
          binding.sources.set(fresh);
          binding.failures.set({});
          binding.loading.set(false);
        });
      }, undefined, {
        pageId: result.pageId, queryContext: interaction, signal: lifetime.signal,
        onError: (error) => {
          if (lifetime.signal.aborted) return;
          binding.failures.set(Object.fromEntries(pageDefinition.views.map((view, index) => [
            view && typeof view === 'object' && 'id' in view ? String(view.id) : `view-${index + 1}`,
            error.message
          ])));
          message.set(`Preview query failed: ${error.message}`);
          publishNotification({ message: error.message, tone: 'error' });
        }
      });
    };
    const renderPage = () => {
      const rendering = new AbortController();
      lifetime.signal.addEventListener('abort', () => rendering.abort(), { once: true, signal: rendering.signal });
      try {
        const page = renderDashboardPagePreview(result.document, { ...binding, signal: rendering.signal }, interaction);
        page.addEventListener('dashboard-query-context-change', (event) => {
          if (!(event instanceof CustomEvent)) return;
          event.stopPropagation();
          interaction = event.detail?.queryContext;
          preview.replaceChildren(renderPage());
          subscribe();
        }, { signal: rendering.signal });
        renderingLifetime?.abort();
        renderingLifetime = rendering;
        return page;
      } catch (error) {
        rendering.abort();
        throw error;
      }
    };
    try {
      const page = renderPage();
      subscribe();
      previewLifetime?.abort();
      previewLifetime = lifetime;
      preview.replaceChildren(page);
    } catch (error) {
      lifetime.abort();
      throw error;
    }
  };

  /**
   * @param {string} statusText
   * @param {(signal: AbortSignal) => Promise<void>} task
   */
  async function perform(statusText, task) {
    if (busy.get() || scope.signal.aborted) return;
    const controller = new AbortController();
    operation = controller;
    scope.signal.addEventListener('abort', () => controller.abort(), { once: true, signal: controller.signal });
    busy.set(true);
    message.set(statusText);
    try {
      await task(controller.signal);
    } catch (error) {
      if (scope.signal.aborted) return;
      message.set(controller.signal.aborted ? 'Copilot request or validation cancelled. Existing text and preview are unchanged.'
        : error instanceof Error ? error.message : 'Could not update the editor.');
      if (!controller.signal.aborted) publishNotification({ message: message.get(), tone: 'error' });
    } finally {
      controller.abort();
      if (operation === controller) operation = null;
      if (!scope.signal.aborted) busy.set(false);
    }
  }

  async function enhanceIntent() {
    const context = authoringContext();
    await perform('Improving all four fields with Copilot…', async (signal) => {
      const response = await fetch('./__query_designer/enhance', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
        body: JSON.stringify(context)
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || `Intent improvement failed with HTTP ${response.status}.`);
      const fields = { intent, subject, objective, acceptance };
      if (Object.keys(result).length !== 4 || Object.entries(fields).some(([name, field]) => (
        typeof result[name] !== 'string' || !result[name].trim() || result[name].length > field.input.maxLength
      ))) {
        throw new Error('Copilot returned incomplete or oversized authoring fields. No fields were changed.');
      }
      signal.throwIfAborted();
      if (JSON.stringify(context) !== JSON.stringify(authoringContext())) {
        message.set('Authoring text changed while Copilot was working. The enhancement was not applied.');
        return;
      }
      for (const [name, field] of Object.entries(fields)) {
        field.input.value = result[name];
        field.input.dispatchEvent(new Event('input', { bubbles: true }));
      }
      message.set('All four fields improved. Review them before generating a query.');
    });
  }

  /** @param {boolean} useAgent */
  async function run(useAgent) {
    await perform(useAgent ? 'Generating Dashboard Language with Copilot…' : 'Validating Dashboard Language in the data worker…', async (signal) => {
      if (useAgent) {
        const response = await fetch('./__query_designer', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
          body: JSON.stringify({
            ...authoringContext(),
            ...(document.value.trim() ? { document: document.value } : {}),
            ...(diagnostics.get() ? { feedback: diagnostics.get().slice(0, 8000) } : {})
          })
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || `Query generation failed with HTTP ${response.status}.`);
        if (typeof result.document !== 'string') throw new Error('Query generation returned no Dashboard Language document.');
        signal.throwIfAborted();
        acceptedDraft.set('');
        document.value = result.document;
      }
      const result = await validateQueryEditorDocument(document.value, signal);
      signal.throwIfAborted();
      if (!result.ok) {
        sourceDisclosure.open = true;
        diagnostics.set(result.errors.map((error) => `${error.path}: ${error.message}`).join('\n'));
        message.set('The draft is invalid. Fix it or generate again; the previous preview is unchanged.');
        return;
      }
      await accept(result, signal);
      acceptedDraft.set(document.value);
      diagnostics.set('');
      message.set('Preview updated. It stays subscribed to canonical dashboard data.');
    });
  }
  async function saveView() {
    await perform('Saving the rendered view to local CAO custom views…', async (signal) => {
      const draft = acceptedDraft.get();
      if (!draft || draft !== document.value) throw new Error('Validate and render the current draft before saving.');
      const result = await validateQueryEditorDocument(draft, signal);
      if (!result.ok) throw new Error('The draft is no longer valid. Validate and render it before saving.');
      const response = await fetch('./__custom_views', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
        body: JSON.stringify({ document: draft })
      });
      const saved = await response.json();
      if (!response.ok) throw new Error(saved.error || `Custom view save failed with HTTP ${response.status}.`);
      signal.throwIfAborted();
      if (typeof saved.id !== 'string' || !/^local-[a-f0-9]{24}$/.test(saved.id) || !saved.dashboard?.dashboard) {
        throw new Error('Custom view save returned an invalid view location.');
      }
      publishNotification({ message: `Custom view saved to ${saved.path}.`, tone: 'success' });
      globalThis.location.hash = `#page-${saved.id}`;
      globalThis.dispatchEvent(new CustomEvent('dashboard-preview-update', { detail: { dashboard: saved.dashboard } }));
    });
  }
  const form = h('form', {
    className: 'query-editor-form',
    onSubmit: (/** @type {SubmitEvent} */ event) => { event.preventDefault(); void run(true); }
  }, intent.root, subject.root, objective.root, acceptance.root,
  h('div', { className: 'query-editor-actions' }, generate, improve, cancel));
  const status = h('p', { role: 'status', 'aria-live': 'polite' });
  const errors = h('pre', { className: 'query-editor-errors', role: 'alert', hidden: true });
  const sourceDisclosure = /** @type {HTMLDetailsElement} */ (h('details', { className: 'query-editor-source' },
    h('summary', {}, 'Dashboard Language source (advanced)'),
    h('label', { className: 'query-editor-field', htmlFor: document.id }, 'Dashboard Language (JSON or YAML)', document),
    h('div', { className: 'query-editor-actions' }, apply, copy.button, copy.status)));
  preview.append(h('p', { className: 'muted' }, 'Your rendered view will appear here after generation.'));
  const root = h('section', { className: 'query-editor', 'aria-label': context.title },
    form, status, errors,
    preview,
    h('div', { className: 'query-editor-actions' }, save),
    h('p', { className: 'muted' }, 'Copilot generation and field enhancements use AI credits, with no tools. Previews are read-only and limited to 200 rows per view. Saved custom views stay in this workspace under .cao/dashboard/custom-views/.'),
    sourceDisclosure);
  effect(() => {
    generate.disabled = busy.get();
    apply.disabled = busy.get();
    save.disabled = busy.get() || !acceptedDraft.get();
    improve.disabled = busy.get();
    cancel.hidden = !busy.get();
    root.setAttribute('aria-busy', String(busy.get()));
    document.readOnly = busy.get();
    status.textContent = message.get();
    errors.hidden = !diagnostics.get();
    errors.textContent = diagnostics.get();
  }, { signal: scope.signal });
  scope.signal.addEventListener('abort', () => {
    operation?.abort();
    previewLifetime?.abort();
  }, { once: true });
  scope.bind(root);
  return root;
}
